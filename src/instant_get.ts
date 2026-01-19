// src/instant_get.ts
//
// Instant GET store (single URL):
// - GET-only
// - Polls one URL on an interval (default 5000ms)
// - Stores latest successful ResilientResponse
// - get() returns cached value instantly (or undefined)
// - Cached value is valid for 60s only (expired => undefined)
// - On error: stop OR retry N times (default: retry forever)
// - Infinite retry uses backoff: 1s, 5s, 10s, 30s, 60s, 60s...
// - start() never blocks
// - ready flips to true after first successful fetch (2xx)
// - waitReady(timeoutSec=10) polls ready every 1s and returns true/false (never throws)

import type {
  ResilientResponse,
  InstantGetOptions,
  InstantGetSnapshot,
  InstantGetOnError,
} from "./types.js";

const VALID_MS = 60_000;
const RETRY_BACKOFF_MS = [1000, 5000, 10_000, 30_000, 60_000];

type Entry = {
  url?: string;
  intervalMs: number;
  onError: InstantGetOnError;

  timer?: NodeJS.Timeout;
  inFlight: boolean;

  last?: ResilientResponse;
  lastOkAt?: number;
  lastStatus?: number;

  lastErrorName?: string;
  consecutiveErrors: number;
  retriesRemaining: number; // Infinity allowed

  // backoff stage for infinite retry
  backoffStage: number;

  // next scheduled delay (for snapshot)
  nextDelayMs?: number;

  // readiness: becomes true after first successful fetch (2xx)
  ready: boolean;
};

function cloneResponse(res: ResilientResponse): ResilientResponse {
  return {
    status: res.status,
    headers: { ...res.headers },
    body: new Uint8Array(res.body),
  };
}

function headersToRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((v, k) => {
    out[k] = v;
  });
  return out;
}

function toRetryCount(onError?: InstantGetOnError): number {
  if (!onError) return Number.POSITIVE_INFINITY;
  if (onError === "stop") return 0;

  const n = onError.retry;
  if (!Number.isFinite(n)) return Number.POSITIVE_INFINITY;
  return Math.max(0, Math.floor(n));
}

function nextBackoffDelayMs(stage: number): number {
  const idx = Math.min(stage, RETRY_BACKOFF_MS.length - 1);
  return RETRY_BACKOFF_MS[idx];
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchGet(url: string): Promise<ResilientResponse> {
  const res = await fetch(url, { method: "GET" });

  const body = new Uint8Array(await res.arrayBuffer());
  return {
    status: res.status,
    headers: headersToRecord(res.headers),
    body,
  };
}

export class InstantGetStore {
  private state: Entry = {
    url: undefined,
    intervalMs: 5000,
    onError: { retry: Number.POSITIVE_INFINITY },

    timer: undefined,
    inFlight: false,

    last: undefined,
    lastOkAt: undefined,
    lastStatus: undefined,

    lastErrorName: undefined,
    consecutiveErrors: 0,
    retriesRemaining: Number.POSITIVE_INFINITY,

    backoffStage: 0,
    nextDelayMs: undefined,

    ready: false,
  };

  start(url: string, opts?: InstantGetOptions): void {
    // stop previous loop
    if (this.state.timer) this.stop();

    const intervalMs = opts?.intervalMs ?? 5000;
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
      throw new Error(`intervalMs must be > 0 (got ${intervalMs})`);
    }

    const onError = opts?.onError ?? { retry: Number.POSITIVE_INFINITY };

    this.state.url = url;
    this.state.intervalMs = intervalMs;
    this.state.onError = onError;
    this.state.retriesRemaining = toRetryCount(onError);

    // reset counters for new run
    this.state.backoffStage = 0;
    this.state.nextDelayMs = undefined;
    this.state.inFlight = false;

    // readiness reset for this run
    this.state.ready = false;

    // schedule immediate tick
    this.scheduleNext(0);
  }

  stop(): void {
    if (this.state.timer) clearTimeout(this.state.timer);
    this.state.timer = undefined;

    this.state.nextDelayMs = undefined;
    this.state.inFlight = false;
    this.state.ready = false;
  }

  /** Returns true only after first successful fetch (2xx) for the current run. */
  isReady(): boolean {
    return this.state.ready;
  }

  /**
   * Polls `ready` every 1 second.
   * Returns true if ready becomes true within timeoutSec (default 10), else false.
   * Never throws.
   */
  async waitReady(timeoutSec = 10): Promise<boolean> {
    if (!Number.isFinite(timeoutSec) || timeoutSec < 0) timeoutSec = 10;

    const timeoutMs = Math.floor(timeoutSec * 1000);
    const start = Date.now();

    while (true) {
      if (this.state.ready) return true;
      if (Date.now() - start >= timeoutMs) return false;
      await sleep(1000);
    }
  }

  /** Instant read: returns last successful response if <= 60s old, else undefined */
  get(): ResilientResponse | undefined {
    if (!this.state.last || !this.state.lastOkAt) return undefined;

    const age = Date.now() - this.state.lastOkAt;
    if (age > VALID_MS) return undefined;

    return cloneResponse(this.state.last);
  }

  snapshot(): InstantGetSnapshot | undefined {
    if (!this.state.url) return undefined;

    return {
      url: this.state.url,
      running: !!this.state.timer,
      intervalMs: this.state.intervalMs,

      lastOkAt: this.state.lastOkAt,
      lastStatus: this.state.lastStatus,

      lastErrorName: this.state.lastErrorName,
      consecutiveErrors: this.state.consecutiveErrors,

      inFlight: this.state.inFlight,
      ready: this.state.ready,
      nextDelayMs: this.state.nextDelayMs,
    };
  }

  /* ---------------- internals ---------------- */

  private scheduleNext(delayMs: number): void {
    const d = Math.max(0, delayMs);
    this.state.nextDelayMs = d;

    if (this.state.timer) clearTimeout(this.state.timer);
    this.state.timer = setTimeout(() => {
      void this.tick();
    }, d);
  }

  private async tick(): Promise<void> {
    if (!this.state.url) return;
    if (!this.state.timer) return; // stopped

    if (this.state.inFlight) {
      // should be rare with setTimeout loop, but keep safe
      this.scheduleNext(this.state.intervalMs);
      return;
    }

    this.state.inFlight = true;

    try {
      const res = await fetchGet(this.state.url);

      // Only 2xx counts as success
      if (res.status < 200 || res.status >= 300) {
        const err = new Error(`Non-2xx status=${res.status}`);
        (err as any).name = "InstantGetNon2xxError";
        throw err;
      }

      // success: store + mark ready
      this.state.last = cloneResponse(res);
      this.state.lastOkAt = Date.now();
      this.state.lastStatus = res.status;

      this.state.lastErrorName = undefined;
      this.state.consecutiveErrors = 0;

      // reset backoff + retry budget on success
      this.state.backoffStage = 0;
      this.state.retriesRemaining = toRetryCount(this.state.onError);

      // becomes ready after first success
      this.state.ready = true;

      // next normal interval
      this.scheduleNext(this.state.intervalMs);
    } catch (err) {
      this.state.lastErrorName = (err as any)?.name ?? "Error";
      this.state.consecutiveErrors += 1;

      // If onError=stop => stop immediately
      if (this.state.onError === "stop") {
        this.stop();
        return;
      }

      // Finite retry budget: fixed-interval retries, then stop
      if (Number.isFinite(this.state.retriesRemaining)) {
        if (this.state.retriesRemaining <= 0) {
          this.stop();
          return;
        }

        this.state.retriesRemaining -= 1;

        if (this.state.retriesRemaining <= 0) {
          this.stop();
          return;
        }

        // fixed retry interval
        this.state.backoffStage = 0;
        this.scheduleNext(this.state.intervalMs);
        return;
      }

      // Infinite retry uses backoff schedule
      const delay = nextBackoffDelayMs(this.state.backoffStage);
      this.state.backoffStage += 1;

      this.scheduleNext(delay);
    } finally {
      this.state.inFlight = false;
    }
  }
}
