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

export interface MicroCacheRetryOptions {
  maxAttempts?: number; // default 3
  baseDelayMs?: number; // default 50
  maxDelayMs?: number; // default 200
  retryOnStatus?: number[]; // default [503]
}

export interface MicroCacheOptions {
  enabled: boolean;
  ttlMs?: number;
  maxStaleMs?: number;
  maxEntries?: number;

  // ⭐ follower controls
  maxWaiters?: number;          // default 1000
  followerTimeoutMs?: number;   // default 5000 (shared window)

  keyFn?: (req: ResilientRequest) => string;
  retry?: MicroCacheRetryOptions;
}


export interface ResilientHttpClientOptions {
  maxInFlight: number;
  maxQueue: number;
  enqueueTimeoutMs: number;
  requestTimeoutMs: number;

  /**
   * GET-only micro-cache + request coalescing.
   */
  microCache?: MicroCacheOptions;
}
