// src/client.ts
import { EventEmitter } from "node:events";
import { ConcurrencyLimiter } from "./limiter.js";
import { doHttpRequest } from "./http.js";
import { CircuitBreaker } from "./breaker.js";
import { CircuitOpenError } from "./errors.js";
import type {
  MicroCacheOptions,
  ResilientHttpClientOptions,
  ResilientRequest,
  ResilientResponse,
} from "./types.js";

/**
 * Micro-cache errors (local to this file to keep your project simple).
 * If you prefer, move these into src/errors.ts and export them.
 */
export class MicroCacheWaitersFullError extends Error {
  override name = "MicroCacheWaitersFullError";
  constructor(public readonly key: string, public readonly maxWaiters: number) {
    super(`micro-cache waiters full for key=${key} (maxWaiters=${maxWaiters})`);
  }
}

export class MicroCacheFollowerWindowClosedError extends Error {
  override name = "MicroCacheFollowerWindowClosedError";
  constructor(public readonly key: string, public readonly windowMs: number) {
    super(`micro-cache follower window closed for key=${key} (windowMs=${windowMs})`);
  }
}

function defaultBreakerKeyFn(req: ResilientRequest): string {
  return new URL(req.url).host;
}

function normalizeUrlForKey(rawUrl: string): string {
  // Normalize enough to avoid trivial cache misses:
  // - remove default ports (:80, :443)
  // - normalize hostname casing
  // - keep path + query exactly (order matters; we intentionally do NOT reorder query params)
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

function withTimeout<T>(p: Promise<T>, timeoutMs: number, onTimeout: () => Error): Promise<T> {
  if (timeoutMs <= 0) return p;
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(onTimeout()), timeoutMs);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });
}

type CacheEntry = {
  createdAt: number; // when last known good was produced
  expiresAt: number; // fresh-until (ttlMs)
  value: ResilientResponse; // last known good (2xx)
};

type InFlightState = {
  promise: Promise<ResilientResponse>;
  startedAt: number; // when leader refresh started
  windowEndsAt: number; // startedAt + followerTimeoutMs (shared window)
};

export class ResilientHttpClient extends EventEmitter {
  private readonly limiter: ConcurrencyLimiter;
  private readonly breaker: CircuitBreaker;
  private readonly requestTimeoutMs: number;
  private readonly breakerKeyFn: (req: ResilientRequest) => string;

  // micro-cache
  private readonly microCache?: Required<
    Pick<
      MicroCacheOptions,
      "enabled" | "ttlMs" | "maxEntries" | "maxStaleMs" | "maxWaiters" | "followerTimeoutMs" | "keyFn"
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
  private inFlight?: Map<string, InFlightState>;
  private waiters?: Map<string, number>;

  // cleanup bookkeeping (micro-cache only)
  private microCacheReqCount = 0;
  private readonly cleanupEveryNRequests = 100;

  constructor(private readonly opts: ResilientHttpClientOptions) {
    super();

    this.limiter = new ConcurrencyLimiter({
      maxInFlight: opts.maxInFlight,
      maxQueue: opts.maxQueue,
      enqueueTimeoutMs: opts.enqueueTimeoutMs,
    });

    this.breaker = new CircuitBreaker(opts.breaker);
    this.requestTimeoutMs = opts.requestTimeoutMs;
    this.breakerKeyFn = opts.keyFn ?? defaultBreakerKeyFn;

    const mc = opts.microCache;
    if (mc?.enabled) {
      const retry = mc.retry
        ? {
            maxAttempts: mc.retry.maxAttempts ?? 3, // leader retries default = 3
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
      this.waiters = new Map();
    }
  }

  async request(req: ResilientRequest): Promise<ResilientResponse> {
    // Micro-cache: GET-only; skip if GET has a body (safest)
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
      // Hard cleanup: entries older than maxStaleMs are never allowed to be served again.
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

  private incWaiter(key: string): number {
    const waiters = this.waiters!;
    const next = (waiters.get(key) ?? 0) + 1;
    waiters.set(key, next);
    return next;
  }

  private decWaiter(key: string): number {
    const waiters = this.waiters!;
    const cur = waiters.get(key) ?? 0;
    const next = Math.max(0, cur - 1);
    if (next === 0) waiters.delete(key);
    else waiters.set(key, next);
    return next;
  }

  private isRetryableStatus(status: number, retryOnStatus: number[]): boolean {
    return retryOnStatus.includes(status);
  }

  private isRetryableError(err: unknown): boolean {
    // Conservative: retry only on timeouts and generic network-ish errors.
    // (If you have a RequestTimeoutError class, add instanceof check here.)
    if (err && typeof err === "object") {
      const anyErr = err as any;
      const name = String(anyErr.name ?? "");
      const code = String(anyErr.code ?? "");
      if (name.includes("AbortError")) return true;
      if (code === "ETIMEDOUT" || code === "ECONNRESET" || code === "EAI_AGAIN") return true;
    }
    return false;
  }

  private computeBackoffMs(attemptIndex: number, baseDelayMs: number, maxDelayMs: number): number {
    const exp = baseDelayMs * Math.pow(2, attemptIndex - 1);
    const capped = clamp(exp, baseDelayMs, maxDelayMs);
    const jitter = 0.5 + Math.random(); // 0.5x..1.5x
    return Math.round(capped * jitter);
  }

  /**
   * Leader-only retry for GET refresh.
   * Followers never retry independently.
   */
  private async fetchWithLeaderRetry(req: ResilientRequest): Promise<ResilientResponse> {
    const mc = this.microCache!;
    const retry = mc.retry;
    if (!retry) return this.existingPipeline(req);

    const { maxAttempts, baseDelayMs, maxDelayMs, retryOnStatus } = retry;

    let lastErr: unknown = undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const res = await this.existingPipeline(req);

        // If upstream returns retryable status, treat as retryable failure
        if (this.isRetryableStatus(res.status, retryOnStatus) && attempt < maxAttempts) {
          lastErr = new Error(`Retryable status: ${res.status}`);
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
      } catch (err) {
        lastErr = err;

        // Never retry if breaker is open; fail fast
        if (err instanceof CircuitOpenError) throw err;

        if (attempt >= maxAttempts || !this.isRetryableError(err)) {
          throw err;
        }

        const delay = this.computeBackoffMs(attempt, baseDelayMs, maxDelayMs);
        this.emit("microcache:retry", {
          url: req.url,
          attempt,
          maxAttempts,
          reason: "error",
          delayMs: delay,
        });
        await sleep(delay);
      }
    }

    throw lastErr ?? new Error("Retry exhausted");
  }

  /**
   * Window behavior:
   * - 0..ttlMs: return cache (fresh)
   * - ttlMs..maxStaleMs: leader refreshes; others get old value until replaced (even if refresh fails)
   * - >maxStaleMs: do not serve old; behave like no cache
   *
   * Cold-start/reset follower rules (NO allowed cache):
   * - maxWaiters caps how many followers may wait per key
   * - followerTimeoutMs is a SHARED window per refresh:
   *   after window closes, new followers fail fast until leader completes
   */
  private async requestWithMicroCache(req: ResilientRequest): Promise<ResilientResponse> {
    const mc = this.microCache!;
    const cache = this.cache!;
    const inFlight = this.inFlight!;

    this.maybeCleanupExpired(cache, mc.maxStaleMs);

    const key = mc.keyFn(req);
    const now = Date.now();

    const hit0 = cache.get(key);
    const isStaleAllowed0 = !!hit0 && now - hit0.createdAt <= mc.maxStaleMs;

    // If too old, delete immediately (reset to start)
    if (hit0 && !isStaleAllowed0) cache.delete(key);

    // 1) fresh hit => return immediately
    const hit = cache.get(key); // re-read (in case deleted)
    if (hit && now < hit.expiresAt) {
      return this.cloneResponse(hit.value);
    }

    // 2) if refresh is already running
    const state = inFlight.get(key);
    if (state) {
      const h = cache.get(key);
      const staleAllowed = !!h && now - h.createdAt <= mc.maxStaleMs;

      // Within stale window: return previous immediately while refresh runs
      if (h && staleAllowed) return this.cloneResponse(h.value);

      // NO allowed cache => follower wait is bounded by:
      // - maxWaiters
      // - shared windowEndsAt
      const count = this.incWaiter(key);
      if (count > mc.maxWaiters) {
        this.decWaiter(key);
        const err = new MicroCacheWaitersFullError(key, mc.maxWaiters);
        this.emit("microcache:waiters_full", { key, url: req.url, maxWaiters: mc.maxWaiters });
        throw err;
      }

      try {
        const now2 = Date.now();
        if (now2 > state.windowEndsAt) {
          const err = new MicroCacheFollowerWindowClosedError(key, mc.followerTimeoutMs);
          this.emit("microcache:follower_window_closed", { key, url: req.url, windowMs: mc.followerTimeoutMs });
          throw err;
        }

        const remaining = state.windowEndsAt - now2;
        const res = await withTimeout(
          state.promise,
          remaining,
          () => new MicroCacheFollowerWindowClosedError(key, mc.followerTimeoutMs)
        );
        return this.cloneResponse(res);
      } finally {
        this.decWaiter(key);
      }
    }

    // 3) become leader and start refresh (with optional leader-only retry)
    const prev = cache.get(key); // may exist and may be stale-allowed
    const prevStaleAllowed = !!prev && now - prev.createdAt <= mc.maxStaleMs;

    const startedAt = Date.now();
    const windowEndsAt = startedAt + mc.followerTimeoutMs;

    const p = (async () => {
      const res = await this.fetchWithLeaderRetry(req);

      // Replace only on 2xx
      if (res.status >= 200 && res.status < 300) {
        this.evictIfNeeded(cache, mc.maxEntries);
        const now3 = Date.now();
        cache.set(key, {
          value: this.cloneResponse(res),
          createdAt: now3,
          expiresAt: now3 + mc.ttlMs,
        });
      }

      return res;
    })();

    inFlight.set(key, { promise: p, startedAt, windowEndsAt });

    try {
      const res = await p;

      // If not 2xx, don't overwrite cache.
      // If we have previous allowed cache, serve it to keep behavior stable.
      if (!(res.status >= 200 && res.status < 300) && prev && prevStaleAllowed) {
        this.emit("microcache:refresh_non2xx", { key, url: req.url, status: res.status });
        return this.cloneResponse(prev.value);
      }

      return this.cloneResponse(res);
    } catch (err) {
      // Refresh failed: serve previous only if still within maxStaleMs
      if (prev && prevStaleAllowed) {
        this.emit("microcache:refresh_failed", { key, url: req.url, error: err });
        return this.cloneResponse(prev.value);
      }
      throw err;
    } finally {
      inFlight.delete(key);
    }
  }

  /**
   * breaker decision -> queue/limiter -> http timeout -> breaker update -> events
   */
  private async existingPipeline(req: ResilientRequest): Promise<ResilientResponse> {
    const key = this.breakerKeyFn(req);
    const requestId = genRequestId();

    // Circuit decision before consuming concurrency/queue
    const decision = this.breaker.allow(key);
    if (!decision.allowed) {
      const err = new CircuitOpenError(key, decision.retryAfterMs ?? 0);
      this.emit("request:rejected", { key, requestId, request: req, error: err });
      return Promise.reject(err);
    }

    // Acquire (may reject with QueueFullError / QueueTimeoutError)
    try {
      await this.limiter.acquire();
    } catch (err) {
      this.emit("request:rejected", { key, requestId, request: req, error: err });
      // local load shedding shouldn't punish upstream breaker
      throw err;
    }

    const start = Date.now();
    this.emit("request:start", { key, requestId, request: req });

    try {
      const res = await doHttpRequest(req, this.requestTimeoutMs);

      // classify breaker success/failure (v1 rule: 5xx = failure)
      if (res.status >= 500) {
        const change = this.breaker.onFailure(key);
        if (change.changed) this.emit("breaker:state", { key, from: change.from, to: change.to });
      } else {
        const change = this.breaker.onSuccess(key);
        if (change.changed) this.emit("breaker:state", { key, from: change.from, to: change.to });
      }

      const durationMs = Date.now() - start;
      this.emit("request:success", { key, requestId, request: req, status: res.status, durationMs });
      return res;
    } catch (err) {
      const change = this.breaker.onFailure(key);
      if (change.changed) this.emit("breaker:state", { key, from: change.from, to: change.to });

      const durationMs = Date.now() - start;
      this.emit("request:failure", { key, requestId, request: req, error: err, durationMs });
      throw err;
    } finally {
      this.limiter.release();
    }
  }

  snapshot(): { inFlight: number; queueDepth: number; breakers: ReturnType<CircuitBreaker["snapshot"]> } {
    const s = this.limiter.snapshot();
    return { inFlight: s.inFlight, queueDepth: s.queueDepth, breakers: this.breaker.snapshot() };
  }
}
