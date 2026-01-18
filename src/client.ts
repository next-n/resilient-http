// src/client.ts
import { EventEmitter } from "node:events";
import { ConcurrencyLimiter } from "./limiter.js";
import { doHttpRequest } from "./http.js";
import {
  QueueFullError,
  RequestTimeoutError,
  ResilientHttpError,
  HalfOpenRejectedError,
  UpstreamUnhealthyError,
} from "./errors.js";
import type {
  MicroCacheOptions,
  ResilientHttpClientOptions,
  ResilientRequest,
  ResilientResponse,
} from "./types.js";

/* ---------------------------- helpers ---------------------------- */

function normalizeUrlForKey(rawUrl: string): string {
  const u = new URL(rawUrl);
  u.hostname = u.hostname.toLowerCase();

  const isHttpDefault = u.protocol === "http:" && u.port === "80";
  const isHttpsDefault = u.protocol === "https:" && u.port === "443";
  if (isHttpDefault || isHttpsDefault) u.port = "";

  return u.toString();
}

function baseUrlKey(rawUrl: string): string {
  const u = new URL(rawUrl);
  u.hostname = u.hostname.toLowerCase();

  const isHttpDefault = u.protocol === "http:" && u.port === "80";
  const isHttpsDefault = u.protocol === "https:" && u.port === "443";
  if (isHttpDefault || isHttpsDefault) u.port = "";

  return `${u.protocol}//${u.host}`;
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

function jitterMs(ms: number): number {
  const mult = 0.8 + Math.random() * 0.4; // [0.8, 1.2]
  return Math.round(ms * mult);
}


/* ---------------------------- health ---------------------------- */

type HealthState = "OPEN" | "CLOSED" | "HALF_OPEN";
type Outcome = "SUCCESS" | "HARD_FAIL" | "SOFT_FAIL";

type HealthTracker = {
  state: HealthState;

  window: Outcome[];
  windowSize: number; // 20
  minSamples: number; // 10

  consecutiveHardFails: number; // trip at 3

  cooldownBaseMs: number; // 1000
  cooldownCapMs: number;  // 30000
  cooldownMs: number;     // current backoff
  cooldownUntil: number;

  probeInFlight: boolean; // probeConcurrency=1
  probeRemaining: number; // 1 probe per half-open

  stableNonHard: number;  // reset backoff after 5 non-hard after open
};

const SOFT_FAIL_STATUSES = new Set([429, 502, 503, 504]);

function classifyHttpStatus(status: number): Outcome {
  if (status >= 200 && status < 300) return "SUCCESS";
  if (SOFT_FAIL_STATUSES.has(status)) return "SOFT_FAIL";
  return "SUCCESS"; // do not penalize health for other statuses (incl 4xx except 429)
}

function computeRates(window: Outcome[]) {
  const total = window.length;
  let hard = 0;
  let soft = 0;
  for (const o of window) {
    if (o === "HARD_FAIL") hard += 1;
    else if (o === "SOFT_FAIL") soft += 1;
  }
  return {
    total,
    hard,
    soft,
    hardFailRate: total === 0 ? 0 : hard / total,
    failRate: total === 0 ? 0 : (hard + soft) / total,
  };
}

/**
 * Only HTTP-layer failures should count as HARD_FAIL.
 * Control-plane rejections must NOT poison health.
 */
function shouldCountAsHardFail(err: unknown): boolean {
  if (err instanceof UpstreamUnhealthyError) return false;
  if (err instanceof HalfOpenRejectedError) return false;
  if (err instanceof QueueFullError) return false;

  // if your http layer throws this, it's a real hard fail (timeout)
  if (err instanceof RequestTimeoutError) return true;

  // If it’s a known library error but not one of the above, be conservative:
  // treat it as NOT a health signal unless it’s clearly HTTP-related.
  if (err instanceof ResilientHttpError) return false;

  // Unknown thrown error: assume it's an HTTP/network failure.
  return true;
}

/* ---------------------------- microcache types ---------------------------- */

type CacheEntry = {
  createdAt: number;
  expiresAt: number;
  value: ResilientResponse;
};

type InFlightGroup = {
  promise: Promise<ResilientResponse>;
  windowStartMs: number;
  waiters: number;
};

/* ---------------------------- client ---------------------------- */

export class ResilientHttpClient extends EventEmitter {
  private readonly requestTimeoutMs: number;
  private readonly healthEnabled: boolean;

  private readonly limiters = new Map<string, ConcurrencyLimiter>();
  private readonly health = new Map<string, HealthTracker>();

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
    this.requestTimeoutMs = opts.requestTimeoutMs;
    this.healthEnabled = opts.health?.enabled ?? true;

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
    return this.execute(req, { allowProbe: false });
  }

  snapshot(): { inFlight: number; queueDepth: number } {
    let inFlight = 0;
    let queueDepth = 0;
    for (const l of this.limiters.values()) {
      const s = l.snapshot();
      inFlight += s.inFlight;
      queueDepth += s.queueDepth;
    }
    return { inFlight, queueDepth };
  }

  /* ---------------- internals ---------------- */

  private getLimiter(baseKey: string): ConcurrencyLimiter {
    let l = this.limiters.get(baseKey);
    if (!l) {
      l = new ConcurrencyLimiter({
        maxInFlight: this.opts.maxInFlight,
        maxQueue: this.opts.maxInFlight * 10, // hidden factor
      });
      this.limiters.set(baseKey, l);
    }
    return l;
  }

  private getHealth(baseKey: string): HealthTracker {
    let h = this.health.get(baseKey);
    if (!h) {
      h = {
        state: "OPEN",
        window: [],
        windowSize: 20,
        minSamples: 10,
        consecutiveHardFails: 0,
        cooldownBaseMs: 1000,
        cooldownCapMs: 30_000,
        cooldownMs: 1000,
        cooldownUntil: 0,
        probeInFlight: false,
        probeRemaining: 0,
        stableNonHard: 0,
      };
      this.health.set(baseKey, h);
    }
    return h;
  }

  private closeHealth(baseKey: string, reason: string): void {
    const h = this.getHealth(baseKey);
    if (h.state === "CLOSED") return;

    h.state = "CLOSED";
    h.cooldownUntil = Date.now() + jitterMs(h.cooldownMs);
    h.cooldownMs = Math.min(h.cooldownMs * 2, h.cooldownCapMs);

    // reject queued immediately
    this.getLimiter(baseKey).flush(new UpstreamUnhealthyError(baseKey, "CLOSED"));

    const rates = computeRates(h.window);
    this.emit("health:closed", {
      baseUrl: baseKey,
      reason,
      cooldownMs: h.cooldownUntil - Date.now(),
      hardFailRate: rates.hardFailRate,
      failRate: rates.failRate,
      samples: rates.total,
    });
  }

  private halfOpenHealth(baseKey: string): void {
    const h = this.getHealth(baseKey);
    if (h.state !== "CLOSED") return;

    h.state = "HALF_OPEN";
    h.probeInFlight = false;
    h.probeRemaining = 1;
    this.emit("health:half_open", { baseUrl: baseKey });
  }

  private openHealth(baseKey: string): void {
    const h = this.getHealth(baseKey);
    h.state = "OPEN";
    h.window = [];
    h.consecutiveHardFails = 0;
    h.probeInFlight = false;
    h.probeRemaining = 0;
    h.stableNonHard = 0;
    this.emit("health:open", { baseUrl: baseKey });
  }

  private recordOutcome(baseKey: string, outcome: Outcome): void {
    const h = this.getHealth(baseKey);

    h.window.push(outcome);
    while (h.window.length > h.windowSize) h.window.shift();

    if (outcome === "HARD_FAIL") h.consecutiveHardFails += 1;
    else h.consecutiveHardFails = 0;

    // stabilization (reset backoff after 5 non-hard in OPEN)
    if (h.state === "OPEN") {
      if (outcome !== "HARD_FAIL") {
        h.stableNonHard += 1;
        if (h.stableNonHard >= 5) {
          h.cooldownMs = h.cooldownBaseMs;
        }
      } else {
        h.stableNonHard = 0;
      }
    }

    if (!this.healthEnabled) return;

    if (h.consecutiveHardFails >= 3) {
      this.closeHealth(baseKey, "3 consecutive hard failures");
      return;
    }

    const rates = computeRates(h.window);
    if (rates.total >= h.minSamples) {
      if (rates.hardFailRate >= 0.3) {
        this.closeHealth(baseKey, "hardFailRate >= 30%");
        return;
      }
      if (rates.failRate >= 0.5) {
        this.closeHealth(baseKey, "failRate >= 50%");
        return;
      }
    }
  }

  private async execute(req: ResilientRequest, opts: { allowProbe: boolean }): Promise<ResilientResponse> {
    const baseKey = baseUrlKey(req.url);
    const h = this.getHealth(baseKey);
    const limiter = this.getLimiter(baseKey);

    if (this.healthEnabled) {
      if (h.state === "CLOSED") {
        if (Date.now() >= h.cooldownUntil) {
          this.halfOpenHealth(baseKey);
        } else {
          throw new UpstreamUnhealthyError(baseKey, "CLOSED");
        }
      }

      if (h.state === "HALF_OPEN") {
        if (!opts.allowProbe) throw new HalfOpenRejectedError(baseKey);
        if (h.probeRemaining <= 0 || h.probeInFlight) throw new HalfOpenRejectedError(baseKey);
        h.probeInFlight = true;
        h.probeRemaining -= 1;
      }
    }

    const requestId = genRequestId();
    const start = Date.now();

    try {
      // Probes should not wait in queue.
      if (this.healthEnabled && h.state === "HALF_OPEN") {
        await limiter.acquireNoQueue();
      } else {
        await limiter.acquire();
      }
    } catch (err) {
      this.emit("request:rejected", { requestId, request: req, error: err });
      throw err;
    }

    this.emit("request:start", { requestId, request: req });

    try {
      const res = await doHttpRequest(req, this.requestTimeoutMs);
      const durationMs = Date.now() - start;

      const outcome = classifyHttpStatus(res.status);
      this.recordOutcome(baseKey, outcome);

      // Probe decision
      if (this.healthEnabled && h.state === "HALF_OPEN") {
        this.emit("health:probe", { baseUrl: baseKey, outcome, status: res.status });
        if (res.status >= 200 && res.status < 300) {
          this.openHealth(baseKey);
        } else {
          this.closeHealth(baseKey, `probe failed status=${res.status}`);
        }
      }

      this.emit("request:success", { requestId, request: req, status: res.status, durationMs });
      return res;
    } catch (err) {
      const durationMs = Date.now() - start;

      if (shouldCountAsHardFail(err)) {
        this.recordOutcome(baseKey, "HARD_FAIL");
      }

      if (this.healthEnabled && h.state === "HALF_OPEN") {
        this.emit("health:probe", { baseUrl: baseKey, outcome: "HARD_FAIL", error: err });
        this.closeHealth(baseKey, "probe hard failure");
      }

      this.emit("request:failure", { requestId, request: req, error: err, durationMs });
      throw err;
    } finally {
      // Clear probe flag (if any)
      if (this.healthEnabled && h.state === "HALF_OPEN") {
        h.probeInFlight = false;
      }
      limiter.release();
    }
  }

  /* ---------------- microcache ---------------- */

  private cloneResponse(res: ResilientResponse): ResilientResponse {
    return { status: res.status, headers: { ...res.headers }, body: new Uint8Array(res.body) };
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
    if (!retry) return this.execute(req, { allowProbe: false });

    const { maxAttempts, baseDelayMs, maxDelayMs, retryOnStatus } = retry;

    let last: ResilientResponse | undefined;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const res = await this.execute(req, { allowProbe: false });
      last = res;

      if (this.isRetryableStatus(res.status, retryOnStatus) && attempt < maxAttempts) {
        const delay = this.computeBackoffMs(attempt, baseDelayMs, maxDelayMs);
        this.emit("microcache:retry", { url: req.url, attempt, maxAttempts, reason: `status ${res.status}`, delayMs: delay });
        await sleep(delay);
        continue;
      }
      return res;
    }
    return last!;
  }

  private async requestWithMicroCache(req: ResilientRequest): Promise<ResilientResponse> {
    const mc = this.microCache!;
    const cache = this.cache!;
    const inFlight = this.inFlight!;

    this.maybeCleanupExpired(cache, mc.maxStaleMs);

    const key = mc.keyFn(req);
    const now = Date.now();

    const hit0 = cache.get(key);
    if (hit0 && now - hit0.createdAt > mc.maxStaleMs) cache.delete(key);

    const hit = cache.get(key);
    if (hit && now < hit.expiresAt) return this.cloneResponse(hit.value);

    // If CLOSED: serve stale if allowed else fail fast
    if (this.healthEnabled) {
      const baseKey = baseUrlKey(req.url);
      const h = this.getHealth(baseKey);
      if (h.state === "CLOSED") {
        const staleAllowed = !!hit && now - hit.createdAt <= mc.maxStaleMs;
        if (staleAllowed) return this.cloneResponse(hit!.value);
        throw new UpstreamUnhealthyError(baseKey, "CLOSED");
      }
    }

    const group = inFlight.get(key);
    if (group) {
      const h = cache.get(key);
      const staleAllowed = !!h && now - h.createdAt <= mc.maxStaleMs;

      if (h && staleAllowed) return this.cloneResponse(h.value);

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

    const prev = cache.get(key);
    const prevStaleAllowed = !!prev && now - prev.createdAt <= mc.maxStaleMs;

    const promise = (async () => {
      const baseKey = baseUrlKey(req.url);
      const h = this.getHealth(baseKey);
      const allowProbe = this.healthEnabled && h.state === "HALF_OPEN";

      const res = allowProbe
        ? await this.execute(req, { allowProbe: true })
        : await this.fetchWithLeaderRetry(req);

      if (res.status >= 200 && res.status < 300) {
        this.evictIfNeeded(cache, mc.maxEntries);
        const t = Date.now();
        cache.set(key, { value: this.cloneResponse(res), createdAt: t, expiresAt: t + mc.ttlMs });
      }
      return res;
    })();

    inFlight.set(key, { promise, windowStartMs: Date.now(), waiters: 0 });

    try {
      const res = await promise;

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
}
