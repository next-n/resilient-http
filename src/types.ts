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
  body: Uint8Array;
}

export interface MicroCacheRetryOptions {
  maxAttempts?: number;     // default 3
  baseDelayMs?: number;     // default 50
  maxDelayMs?: number;      // default 200
  retryOnStatus?: number[]; // default [429, 502, 503, 504]
}

export interface MicroCacheOptions {
  enabled: boolean;
  ttlMs?: number;          // default 1000
  maxStaleMs?: number;     // default 10_000
  maxEntries?: number;     // default 500

  maxWaiters?: number;        // default 1000
  followerTimeoutMs?: number; // default 5000

  keyFn?: (req: ResilientRequest) => string;
  retry?: MicroCacheRetryOptions;
}

export interface HealthOptions {
  enabled?: boolean; // default true
}

export interface ResilientHttpClientOptions {
  /**
   * Applied per base URL (scheme + host + port).
   */
  maxInFlight: number;

  /**
   * Per-attempt timeout.
   */
  requestTimeoutMs: number;

  health?: HealthOptions;

  microCache?: MicroCacheOptions;
}
