# outbound-guard

Process-local Node.js HTTP client that collapses duplicate GETs and wraps every outbound call with per-host limits, bounded queueing, timeouts, and a small health gate. Its goal is simple: stop thundering herds and keep your service predictable when upstreams are slow or flaky.

## Highlights
- Request coalescing + short-lived GET micro-cache (leader/followers, stale-while-refresh)
- Per-base-URL limiter with bounded FIFO queue (maxQueue = maxInFlight * 10)
- Lightweight health gate (OPEN → CLOSED → HALF_OPEN probe) with queue flush on close
- Hard per-attempt timeouts and leader-only retries (no retry amplification)
- Zero deps beyond `undici`; entirely in-memory and process-local

## Install

```bash
npm install @nextn/outbound-guard
# Node 18+ (tested on 20)
```

## Quick start

```ts
import { ResilientHttpClient } from "@nextn/outbound-guard";

const client = new ResilientHttpClient({
  // applied per base URL (protocol + host + port)
  maxInFlight: 20,
  requestTimeoutMs: 5_000,

  microCache: {
    enabled: true,
    ttlMs: 1_000,          // fresh window
    maxStaleMs: 10_000,    // serve stale while refreshing
    maxEntries: 500,
    maxWaiters: 1_000,     // concurrent followers per key
    followerTimeoutMs: 5_000,
    retry: {
      maxAttempts: 3,
      baseDelayMs: 50,
      maxDelayMs: 200,
      retryOnStatus: [429, 502, 503, 504], // leader-only
    },
  },
});

const res = await client.request({
  method: "GET",
  url: "https://third-party.example.com/config",
});

console.log(res.status, Buffer.from(res.body).toString("utf8"));
```

`res.body` is a `Uint8Array`; convert with `Buffer.from(res.body)` or `TextDecoder` as needed.

## How it works

### Micro-cache and request coalescing (GET only)
- Keyed by `GET ${normalizedUrl}` by default (hostname lowercased, default ports stripped). Override via `microCache.keyFn`.
- One caller becomes **leader**; identical concurrent GETs become **followers** and wait for the leader result.
- Fresh window: successful 2xx responses are cached for `ttlMs`.
- Stale-while-refresh: after `ttlMs`, followers can be served from the previous value while a new leader refreshes, up to `maxStaleMs`.
- Follower guardrails: reject immediately when `maxWaiters` is exceeded or when waiting longer than `followerTimeoutMs`.
- Failure handling: if a refresh fails but stale data is within `maxStaleMs`, stale is served; otherwise the error is surfaced.
- Leader-only retry: optional exponential backoff for retryable statuses so retries do not multiply under fan-in.

### Concurrency and queueing
- Limits are per base URL (`protocol://host:port`).
- At most `maxInFlight` requests run at once; overflow enters a bounded FIFO queue sized at `maxInFlight * 10` (internal for now).
- If the queue is full, a `QueueFullError` is thrown immediately. Queued waiters are rejected if the upstream is marked unhealthy.

### Health gate (tiny circuit breaker)
- Tracks outcomes per base URL. Hard failures (request timeouts or unknown errors) and soft failures (429, 502, 503, 504) feed the window.
- Closes immediately after 3 consecutive hard failures, or when (with ≥10 samples) hard-fail rate ≥30% or total fail rate ≥50%.
- CLOSED: new requests fail fast with `UpstreamUnhealthyError` (micro-cache can still serve stale if available).
- Cooldown uses exponential backoff: starts at ~1s with jitter, doubles up to 30s. When cooldown elapses, the circuit moves to HALF_OPEN.
- HALF_OPEN: exactly one probe is allowed; other calls get `HalfOpenRejectedError`. A successful probe reopens; a failing probe recloses.
- Per-host isolation: a bad upstream does not poison other hosts.

### Timeouts and retries
- `requestTimeoutMs` is enforced per attempt with `AbortController`; hanging upstreams become `RequestTimeoutError`.
- Retries are opt-in and apply only to GET leaders via `microCache.retry`. Followers never retry, so retries cannot explode under load.

## API surface

```ts
await client.request({
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS",
  url: "https://example.com/resource",
  headers?: Record<string, string>,
  body?: string | Uint8Array | Buffer,
});

client.snapshot(); // { inFlight, queueDepth }
client.on(eventName, handler); // see below for event names
```

### Errors
All exported errors extend `ResilientHttpError`:
- `QueueFullError` – queue capacity hit for that base URL.
- `RequestTimeoutError` – per-attempt timeout exceeded.
- `UpstreamUnhealthyError` – circuit is CLOSED for the base URL.
- `HalfOpenRejectedError` – circuit is HALF_OPEN and the call was not the probe.

### Events
The client is an `EventEmitter`. Useful hooks:
- `request:start | request:success | request:failure | request:rejected`
- `health:closed | health:half_open | health:open`
- `microcache:retry | microcache:refresh_failed`

Event payloads include the request, requestId, status/duration when available, and error objects on failures.

## Demo (local)

Visualize coalescing and backpressure without deploying anything:

```bash
npm run demo:upstream   # terminal A: flaky upstream
npm run demo:loadgen    # terminal B: bursts against the client
```

Watch how bursts collapse to a single upstream hit, stale responses are served during refresh, and failures recover cleanly.

## When to use
- Calling external APIs or partner services from Node.js
- BFFs/API gateways that must isolate upstream slowness
- Webhook senders or background workers that need predictable failure behavior

## When not to use
- If you need durable delivery across restarts (use queues/outbox)
- If you need cross-process coordination or distributed rate limiting
- If you need a service mesh or long-lived caching

## Design stance
- Favor explicit limits over hidden buffers
- Fail fast instead of building invisible backlogs
- Keep the surface small; stay in-process and dependency-light
