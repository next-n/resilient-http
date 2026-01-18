// src/limiter.ts
import { QueueFullError } from "./errors.js";

type ResolveFn = () => void;
type RejectFn = (err: unknown) => void;

interface Waiter {
  resolve: ResolveFn;
  reject: RejectFn;
}

/**
 * Process-local concurrency limiter with bounded FIFO queue.
 *
 * - maxInFlight: concurrent permits
 * - maxQueue: bounded burst buffer
 * - No enqueue-timeout by design.
 *
 * Also supports:
 * - flush(err): reject all queued waiters immediately
 * - acquireNoQueue(): for probes (must start now or fail)
 */
export class ConcurrencyLimiter {
  private readonly maxInFlight: number;
  private readonly maxQueue: number;

  private inFlight = 0;
  private queue: Waiter[] = [];

  constructor(opts: { maxInFlight: number; maxQueue: number }) {
    if (!Number.isFinite(opts.maxInFlight) || opts.maxInFlight <= 0) {
      throw new Error(`maxInFlight must be > 0 (got ${opts.maxInFlight})`);
    }
    if (!Number.isFinite(opts.maxQueue) || opts.maxQueue < 0) {
      throw new Error(`maxQueue must be >= 0 (got ${opts.maxQueue})`);
    }

    this.maxInFlight = opts.maxInFlight;
    this.maxQueue = opts.maxQueue;
  }

  acquire(): Promise<void> {
    if (this.inFlight < this.maxInFlight) {
      this.inFlight += 1;
      return Promise.resolve();
    }

    if (this.maxQueue === 0 || this.queue.length >= this.maxQueue) {
      return Promise.reject(new QueueFullError(this.maxQueue));
    }

    return new Promise<void>((resolve, reject) => {
      this.queue.push({ resolve, reject });
    });
  }

  /**
   * Acquire without queueing: either start now or fail.
   * Used for HALF_OPEN probes so recovery never waits behind backlog.
   */
  acquireNoQueue(): Promise<void> {
    if (this.inFlight < this.maxInFlight) {
      this.inFlight += 1;
      return Promise.resolve();
    }
    // treat as queue full (we don't want a new error type)
    return Promise.reject(new QueueFullError(0));
  }

  release(): void {
    if (this.inFlight <= 0) {
      throw new Error("release() called when inFlight is already 0");
    }

    const next = this.queue.shift();
    if (next) {
      next.resolve(); // transfer permit
      return;
    }

    this.inFlight -= 1;
  }

  flush(err: unknown): void {
    const q = this.queue;
    this.queue = [];
    for (const w of q) w.reject(err);
  }

  snapshot(): { inFlight: number; queueDepth: number; maxInFlight: number; maxQueue: number } {
    return {
      inFlight: this.inFlight,
      queueDepth: this.queue.length,
      maxInFlight: this.maxInFlight,
      maxQueue: this.maxQueue,
    };
  }
}
