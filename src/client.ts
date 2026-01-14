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

type CacheEntry = {
  expiresAt: number;
  value: ResilientResponse;
};

export class ResilientHttpClient extends EventEmitter {
  private readonly limiter: ConcurrencyLimiter;
  private readonly breaker: CircuitBreaker;
  private readonly requestTimeoutMs: number;
  private readonly breakerKeyFn: (req: ResilientRequest) => string;

  // micro-cache
  private readonly microCache?: Required<
    Pick<MicroCacheOptions, "enabled" | "ttlMs" | "maxEntries" | "keyFn">
  >;
  private cache?: Map<string, CacheEntry>;
  private inFlight?: Map<string, Promise<ResilientResponse>>;

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
      this.microCache = {
        enabled: true,
        ttlMs: mc.ttlMs ?? 3000,
        maxEntries: mc.maxEntries ?? 500,
        keyFn: mc.keyFn ?? defaultMicroCacheKeyFn,
      };
      this.cache = new Map();
      this.inFlight = new Map();
    }
  }

  async request(req: ResilientRequest): Promise<ResilientResponse> {
    // Micro-cache: GET-only
    if (this.microCache?.enabled && req.method === "GET") {
      return this.requestWithMicroCache(req);
    }
    return this.existingPipeline(req);
  }

  private cloneResponse(res: ResilientResponse): ResilientResponse {
    // defensive copies: body + headers (avoid shared mutation between callers)
    return {
      status: res.status,
      headers: { ...res.headers },
      body: new Uint8Array(res.body),
    };
  }

  private maybeCleanupExpired(cache: Map<string, CacheEntry>): void {
    this.microCacheReqCount++;
    if (this.microCacheReqCount % this.cleanupEveryNRequests !== 0) return;

    const now = Date.now();
    for (const [k, v] of cache.entries()) {
      if (now >= v.expiresAt) cache.delete(k);
    }
  }

  private async requestWithMicroCache(req: ResilientRequest): Promise<ResilientResponse> {
    const mc = this.microCache!;
    const cache = this.cache!;
    const inFlight = this.inFlight!;

    // periodic sweep (cheap, bounded by maxEntries)
    this.maybeCleanupExpired(cache);

    const key = mc.keyFn(req);
    const now = Date.now();

    // 1) fresh cache hit (also clean expired entry for this key)
    const hit = cache.get(key);
    if (hit) {
      if (now < hit.expiresAt) {
        return this.cloneResponse(hit.value);
      }
      cache.delete(key);
    }

    // 2) singleflight: await existing in-flight
    const existing = inFlight.get(key);
    if (existing) {
      const res = await existing;
      return this.cloneResponse(res);
    }

    // 3) create new in-flight pipeline call
    const p = (async () => {
      const res = await this.existingPipeline(req);

      // cache only 2xx by default
      if (res.status >= 200 && res.status < 300) {
        this.evictIfNeeded(cache, mc.maxEntries);

        cache.set(key, {
          value: this.cloneResponse(res),
          expiresAt: Date.now() + mc.ttlMs,
        });
      }

      return res;
    })();

    inFlight.set(key, p);

    try {
      const res = await p;
      return this.cloneResponse(res);
    } finally {
      inFlight.delete(key);
    }
  }

  private evictIfNeeded(cache: Map<string, CacheEntry>, maxEntries: number): void {
    // Map preserves insertion order. Delete oldest entries first.
    while (cache.size >= maxEntries) {
      const oldestKey = cache.keys().next().value as string | undefined;
      if (!oldestKey) break;
      cache.delete(oldestKey);
    }
  }

  /**
   * Your current pipeline: breaker decision -> queue/limiter -> http timeout -> breaker update -> events.
   * Unchanged logic (just extracted into a method).
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
