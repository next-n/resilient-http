// src/types.ts

export type HttpMethod =
  | "GET"
  | "POST"
  | "PUT"
  | "PATCH"
  | "DELETE"
  | "HEAD"
  | "OPTIONS";

export interface ResilientRequest {
  method: HttpMethod;
  url: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array | Buffer;
}

export interface ResilientResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array; // keep raw; helpers can parse JSON
}

export type BreakerState = "CLOSED" | "OPEN" | "HALF_OPEN";

export interface BreakerOptions {
  windowSize: number; // e.g. 50
  minRequests: number; // e.g. 20
  failureThreshold: number; // 0..1 (e.g. 0.5)
  cooldownMs: number; // e.g. 5000
  halfOpenProbeCount: number; // e.g. 3
}

export interface MicroCacheRetryOptions {
  maxAttempts?: number; // default 3
  baseDelayMs?: number; // default 50
  maxDelayMs?: number; // default 200
  retryOnStatus?: number[]; // default [429, 502, 503, 504]
}

export interface MicroCacheOptions {
  enabled: boolean;
  ttlMs?: number; // default 1000
  maxStaleMs?: number; // default 10000
  maxEntries?: number; // default 500

  /**
   * Follower protection when NO cache is allowed (cold start / reset):
   * - maxWaiters caps how many identical callers may wait for the leader
   * - followerTimeoutMs is a shared window per in-flight refresh:
   *   once the window closes, new followers fail fast until leader completes.
   */
  maxWaiters?: number; // default 1000
  followerTimeoutMs?: number; // default 5000

  /**
   * Default: GET + normalized URL (incl query).
   * Use this to include tenant/user headers if responses vary.
   */
  keyFn?: (req: ResilientRequest) => string;

  /**
   * Leader-only retries (GET refresh).
   */
  retry?: MicroCacheRetryOptions;
}

export interface ResilientHttpClientOptions {
  maxInFlight: number;
  maxQueue: number;
  enqueueTimeoutMs: number;
  requestTimeoutMs: number;
  breaker: BreakerOptions;

  /**
   * Determines which breaker bucket a request belongs to.
   * Default: (req) => new URL(req.url).host
   */
  keyFn?: (req: ResilientRequest) => string;

  /**
   * GET-only micro-cache + singleflight.
   * When enabled, concurrent identical GETs share one upstream call,
   * then cache successful 2xx results for a short TTL.
   */
  microCache?: MicroCacheOptions;
}
