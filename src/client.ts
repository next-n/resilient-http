// src/client.ts
import { EventEmitter } from "node:events";
import { ConcurrencyLimiter } from "./limiter.js";
import { doHttpRequest } from "./http.js";
import type {
  MicroCacheOptions,
  ResilientHttpClientOptions,
  ResilientRequest,
  ResilientResponse,
} from "./types.js";

function normalizeUrlForKey(rawUrl: string): string {
  const u = new URL(rawUrl);
  u.hostname = u.hostname.toLowerCase();

  const isHttpDefault = u.protocol === "http:" && u.port === "80";
  const isHttpsDefault = u.protocol === "https:" && u.port === "443";
  if (isHttpDefault || isHttpsDefault) u.port = "";

  return u.toString();
}

function defaultMicroCacheKeyFn(req: ResilientRequest): string {
  return `GET ${normalizeUrlForKey(req.url)}`;
}

function genRequestId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

type CacheEntry = {
  createdAt: number;
  expiresAt: number;
  value: ResilientResponse;
};

type InFlightGroup = {
  promise: Promise<ResilientResponse>;
  // follower join window
  windowStartMs: number;
  waiters: number; // followers currently joined (not counting leader)
};

export class ResilientHttpClient extends EventEmitter {
  private readonly limiter: ConcurrencyLimiter;
  private readonly requestTimeoutMs: number;

  private readonly microCache?: Required<
    Pick<
      MicroCacheOptions,
      | "enabled"
      | "ttlMs"
      | "maxStaleMs"
      | "maxEntries"
      | "maxWaiters"
      | "followerTimeoutMs"
      | "keyFn"
    >
  > & {
    retry?: {
      maxAttempts: number;
      baseDelayMs: number;
      maxDelayMs: number;
      retryOnStatus: number[];
    };
  };

  private cache?: Map<string, CacheEntry>;
  private inFlight?: Map<string, InFlightGroup>;

  private microCacheReqCount = 0;
  private readonly cleanupEveryNRequests = 100;

  constructor(private readonly opts: ResilientHttpClientOptions) {
    super();

    this.limiter = new ConcurrencyLimiter({
      maxInFlight: opts.maxInFlight,
      maxQueue: opts.maxQueue,
      enqueueTimeoutMs: opts.enqueueTimeoutMs,
    });

    this.requestTimeoutMs = opts.requestTimeoutMs;

    const mc = opts.microCache;
    if (mc?.enabled) {
      const retry = mc.retry
        ? {
            maxAttempts: mc.retry.maxAttempts ?? 3,
            baseDelayMs: mc.retry.baseDelayMs ?? 50,
            maxDelayMs: mc.retry.maxDelayMs ?? 200,
            retryOnStatus: mc.retry.retryOnStatus ?? [429, 502, 503, 504],
          }
        : undefined;

      this.microCache = {
        enabled: true,
        ttlMs: mc.ttlMs ?? 1000,
        maxStaleMs: mc.maxStaleMs ?? 10_000,
        maxEntries: mc.maxEntries ?? 500,
        maxWaiters: mc.maxWaiters ?? 1000,
        followerTimeoutMs: mc.followerTimeoutMs ?? 5000,
        keyFn: mc.keyFn ?? defaultMicroCacheKeyFn,
        retry,
      };

      this.cache = new Map();
      this.inFlight = new Map();
    }
  }

  async request(req: ResilientRequest): Promise<ResilientResponse> {
    if (this.microCache?.enabled && req.method === "GET" && req.body == null) {
      return this.requestWithMicroCache(req);
    }
    return this.existingPipeline(req);
  }

  private cloneResponse(res: ResilientResponse): ResilientResponse {
    return {
      status: res.status,
      headers: { ...res.headers },
      body: new Uint8Array(res.body),
    };
  }

  private maybeCleanupExpired(cache: Map<string, CacheEntry>, maxStaleMs: number): void {
    this.microCacheReqCount++;
    if (this.microCacheReqCount % this.cleanupEveryNRequests !== 0) return;

    const now = Date.now();
    for (const [k, v] of cache.entries()) {
      if (now - v.createdAt > maxStaleMs) cache.delete(k);
    }
  }

  private evictIfNeeded(cache: Map<string, CacheEntry>, maxEntries: number): void {
    while (cache.size >= maxEntries) {
      const oldestKey = cache.keys().next().value as string | undefined;
      if (!oldestKey) break;
      cache.delete(oldestKey);
    }
  }

  private isRetryableStatus(status: number, retryOnStatus: number[]): boolean {
    return retryOnStatus.includes(status);
  }

  private computeBackoffMs(attemptIndex: number, baseDelayMs: number, maxDelayMs: number): number {
    const exp = baseDelayMs * Math.pow(2, attemptIndex - 1);
    const capped = clamp(exp, baseDelayMs, maxDelayMs);
    const jitter = 0.5 + Math.random();
    return Math.round(capped * jitter);
  }

  private async fetchWithLeaderRetry(req: ResilientRequest): Promise<ResilientResponse> {
    const mc = this.microCache!;
    const retry = mc.retry;
    if (!retry) return this.existingPipeline(req);

    const { maxAttempts, baseDelayMs, maxDelayMs, retryOnStatus } = retry;

    let last: ResilientResponse | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const res = await this.existingPipeline(req);
      last = res;

      if (this.isRetryableStatus(res.status, retryOnStatus) && attempt < maxAttempts) {
        const delay = this.computeBackoffMs(attempt, baseDelayMs, maxDelayMs);
        this.emit("microcache:retry", {
          url: req.url,
          attempt,
          maxAttempts,
          reason: `status ${res.status}`,
          delayMs: delay,
        });
        await sleep(delay);
        continue;
      }

      return res;
    }

    // should never
    return last!;
  }

  /**
   * Window behavior:
   * - 0..ttlMs: return cache (fresh)
   * - ttlMs..maxStaleMs: leader refreshes; others get old value until replaced (stale-while-revalidate)
   * - >maxStaleMs: do not serve old; behave like no cache
   *
   * Follower controls (only when no cache is served):
   * - maxWaiters: cap concurrent followers joining the leader
   * - followerTimeoutMs: shared "join window" from first follower; after it expires, late followers fail fast until leader completes
   */
  private async requestWithMicroCache(req: ResilientRequest): Promise<ResilientResponse> {
    const mc = this.microCache!;
    const cache = this.cache!;
    const inFlight = this.inFlight!;

    this.maybeCleanupExpired(cache, mc.maxStaleMs);

    const key = mc.keyFn(req);
    const now = Date.now();

    // If cached entry exists but too old, delete it
    const hit0 = cache.get(key);
    if (hit0 && now - hit0.createdAt > mc.maxStaleMs) {
      cache.delete(key);
    }

    const hit = cache.get(key);
    if (hit && now < hit.expiresAt) {
      return this.cloneResponse(hit.value);
    }

    // If refresh exists
    const group = inFlight.get(key);
    if (group) {
      const h = cache.get(key);
      const staleAllowed = !!h && now - h.createdAt <= mc.maxStaleMs;

      // stale-while-revalidate: serve old immediately
      if (h && staleAllowed) {
        return this.cloneResponse(h.value);
      }

      // No cache allowed: followers must "join" or be rejected
      const age = now - group.windowStartMs;
      if (age > mc.followerTimeoutMs) {
        const err = new Error(`Follower window closed for key=${key}`);
        (err as any).name = "FollowerWindowClosedError";
        throw err;
      }

      if (group.waiters >= mc.maxWaiters) {
        const err = new Error(`Too many followers for key=${key}`);
        (err as any).name = "TooManyWaitersError";
        throw err;
      }

      group.waiters += 1;
      try {
        const res = await group.promise;
        return this.cloneResponse(res);
      } finally {
        group.waiters -= 1;
      }
    }

    // Become leader
    const prev = cache.get(key);
    const prevStaleAllowed = !!prev && now - prev.createdAt <= mc.maxStaleMs;

    const promise = (async () => {
      const res = await this.fetchWithLeaderRetry(req);

      if (res.status >= 200 && res.status < 300) {
        this.evictIfNeeded(cache, mc.maxEntries);
        const t = Date.now();
        cache.set(key, {
          value: this.cloneResponse(res),
          createdAt: t,
          expiresAt: t + mc.ttlMs,
        });
      }

      return res;
    })();

    const newGroup: InFlightGroup = {
      promise,
      windowStartMs: Date.now(),
      waiters: 0,
    };

    inFlight.set(key, newGroup);

    try {
      const res = await promise;

      // if not 2xx and we have stale allowed -> serve prev instead
      if (!(res.status >= 200 && res.status < 300) && prev && prevStaleAllowed) {
        return this.cloneResponse(prev.value);
      }

      return this.cloneResponse(res);
    } catch (err) {
      if (prev && prevStaleAllowed) {
        this.emit("microcache:refresh_failed", { key, url: req.url, error: err });
        return this.cloneResponse(prev.value);
      }
      throw err;
    } finally {
      inFlight.delete(key);
    }
  }

  private async existingPipeline(req: ResilientRequest): Promise<ResilientResponse> {
    const requestId = genRequestId();

    try {
      await this.limiter.acquire();
    } catch (err) {
      this.emit("request:rejected", { requestId, request: req, error: err });
      throw err;
    }

    const start = Date.now();
    this.emit("request:start", { requestId, request: req });

    try {
      const res = await doHttpRequest(req, this.requestTimeoutMs);
      const durationMs = Date.now() - start;
      this.emit("request:success", { requestId, request: req, status: res.status, durationMs });
      return res;
    } catch (err) {
      const durationMs = Date.now() - start;
      this.emit("request:failure", { requestId, request: req, error: err, durationMs });
      throw err;
    } finally {
      this.limiter.release();
    }
  }

  snapshot(): { inFlight: number; queueDepth: number } {
    const s = this.limiter.snapshot();
    return { inFlight: s.inFlight, queueDepth: s.queueDepth };
  }
}
