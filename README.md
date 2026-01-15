
# outbound-guard

A small, opinionated **Node.js HTTP client** that protects your service from slow or failing upstreams by enforcing:

- concurrency limits (in-flight cap)
- bounded queue (backpressure)
- request timeouts
- per-upstream circuit breaker

This is a **library**, not a service.  
It is **process-local**, **in-memory**, and intentionally simple.

---

## Why this exists

Most production outages don’t start inside your service.  
They start when you call **something you don’t control**:

- partner APIs
- payment gateways
- internal services under load
- flaky dependencies

Without protection, outbound calls cause:
- unbounded concurrency
- growing queues
- long tail latency
- cascading failures

`outbound-guard` puts **hard limits** around outbound HTTP calls so your Node.js process stays alive and predictable under stress.

---

## What this library does (in practice)

outbound-guard is built around a single idea:
collapse duplicate work first, then apply limits and breakers.

Most failures don’t come from too many different requests —
they come from too many identical requests hitting a slow dependency.

This library solves that problem before it escalates.

For every outbound HTTP request, it enforces:

### 1. GET micro-cache + request coalescing (core feature)

This is the most important feature in `outbound-guard`.

When enabled, identical GET requests are **collapsed into a single upstream call**.

- One request becomes the **leader**
- All others become **followers**
- Only **one upstream request** is ever in flight
- Followers either:
  - receive cached data immediately, or
  - fail fast when limits are reached

This prevents the most common real-world failure mode:
**thundering herds on slow but healthy upstreams**.

This is not long-lived caching.
It is **short-lived, in-process, burst protection**.


### 2. Concurrency limits
- At most `maxInFlight` requests execute at once.
- Prevents connection exhaustion and event-loop overload.

### 3. Bounded queue (backpressure)
- Excess requests wait in a FIFO queue (up to `maxQueue`).
- If the queue is full → **reject immediately**.
- If waiting too long → **reject with a timeout**.

Failing early is a feature.

### 4. Request timeouts
- Every request has a hard timeout via `AbortController`.
- No hanging promises.

### 5. Circuit breaker (per upstream)
For each upstream (by default, per host):

- **CLOSED** → normal operation
- **OPEN** → fail fast during cooldown
- **HALF_OPEN** → limited probe requests to test recovery

This prevents hammering unhealthy dependencies.

### 6. Observability hooks
- Emits lifecycle events (queueing, failures, breaker transitions)
- Exposes a lightweight `snapshot()` for debugging

No metrics backend required.


---
## The failure mode this library is designed to stop

#### Thundering herd on slow GET requests

This is how many production incidents start:

- Traffic spikes
- Many requests trigger the **same GET**
- The upstream slows down (not down — just slow)
- Node starts N identical outbound requests
- Queues grow, retries multiply, latency explodes
- Eventually the process collapses

Timeouts and retries don’t fix this.
They **amplify it**.

### What outbound-guard does differently

With `microCache` enabled:

- Only **one upstream GET** is ever in flight per key
- All concurrent identical requests share it
- While refreshing:
  - previous data is served (within bounds)
  - or failures surface quickly
- Retries happen **once**, not per caller

This keeps:
- upstream traffic flat
- latency predictable
- failures visible instead of hidden

This is **request coalescing**, not caching.

## Why the micro-cache is intentionally different

Most HTTP clients do one of two things:

1. Cache aggressively and risk serving bad data
2. Don’t cache at all and collapse under burst load

`outbound-guard` does neither.

Its micro-cache is:
- GET-only
- short-lived
- bounded by time and memory
- aware of in-flight requests
- coordinated with circuit breakers and queues

The goal is **operational stability**, not freshness guarantees.

If the upstream is:
- slow → callers don’t pile up
- failing → failures surface quickly
- recovered → traffic resumes cleanly

This design keeps failure behavior honest.


Got it 👍
You want **the same words**, just **clean structure + proper Markdown**, copy-paste ready.

Below is **exactly your text**, only reorganized into clear sections with headers and spacing.
No rewording, no meaning changes.

---

````md
## How to tune micro-cache safely

Most users only need to understand **two knobs**.

---

### `maxWaiters`

Controls how many concurrent callers are allowed to wait for the leader.

```ts
maxWaiters: 10
````

* Low value → aggressive load shedding
* High value → tolerate more fan-in

If this fills quickly, it means:

> “This upstream is too slow for current traffic.”

That’s a signal, not a bug.

---

### `followerTimeoutMs`

Controls how long followers are willing to wait once.

```ts
followerTimeoutMs: 5000
```

* Followers wait at most once
* No per-request retries
* No silent backlog growth

If this expires:

* followers fail fast
* queues drain
* breakers can trip
* the system stays responsive

This prevents **“slow death by waiting”**.

---

## Retry settings (leader-only)

Retries apply **only to the leader**.

```ts
retry: {
  maxAttempts: 3,
  baseDelayMs: 50,
  maxDelayMs: 200,
  retryOnStatus: [503],
}
```

### What this means

* **`maxAttempts`**
  total leader tries (including first)

* **`baseDelayMs`**
  initial backoff

* **`maxDelayMs`**
  cap on exponential backoff

* **`retryOnStatus`**
  retry only when the upstream explicitly signals trouble

Followers never retry.
Retries never multiply under load.

```
```


### How outbound-guard helps

When `microCache` is enabled:

- **Only one real GET request** is sent upstream.
- All concurrent identical GETs **share the same in-flight request**.
- If the upstream takes 5 seconds, deduplication lasts for the full 5 seconds.
- After success, the response is cached briefly (default: 1 seconds).
- Requests during that window are served immediately — no new upstream calls.

This dramatically reduces:
- outbound request count
- upstream pressure
- cost
- tail latency
- failure amplification

This is **request coalescing**, not long-lived caching.

It is intentionally:
- GET-only
- short-lived
- in-memory
- process-local

The goal is load shedding and cost reduction by collapsing duplicate work under concurrent load — not durability guarantees.


-------------

## What this library does NOT do (by design)

- ❌ No persistence
- ❌ No Redis / Kafka
- ❌ No retries by default
- ❌ No distributed coordination
- ❌ No service discovery

This library provides **resilience**, not **durability**.

If you need guaranteed delivery, pair it with:
- a database outbox
- a job queue
- a message broker

---

## Installation

```bash
npm install outbound-guard
````

(Node.js ≥ 20)

---

## Basic usage

```ts
import { ResilientHttpClient } from "outbound-guard";

const client = new ResilientHttpClient({
  maxInFlight: 20,
  maxQueue: 100,
  enqueueTimeoutMs: 200,
  requestTimeoutMs: 5000,

  breaker: {
    windowSize: 50,
    minRequests: 10,
    failureThreshold: 0.5,
    cooldownMs: 3000,
    halfOpenProbeCount: 3,
  },

  microCache: {
    enabled: true,

    // short-lived cache window
    ttlMs: 1000,
    maxStaleMs: 800,

    // protect against fan-in explosions
    maxWaiters: 10,
    followerTimeoutMs: 5000,

    // leader-only retries
    retry: {
      maxAttempts: 3,
      baseDelayMs: 50,
      maxDelayMs: 200,
      retryOnStatus: [503],
    },
  },
});


// Use it instead of fetch/axios directly
await client.request({
  method: "GET",
  url: "https://third-party.example.com/config",
});

console.log(res.status, res.body);
```

That’s it.
Everything else happens automatically.

---

## Error handling

Errors are **explicit and typed**:

* `QueueFullError`
* `QueueTimeoutError`
* `RequestTimeoutError`
* `CircuitOpenError`

Example:

```ts
try {
  await client.request({ method: "GET", url });
} catch (err) {
  if (err instanceof CircuitOpenError) {
    // upstream is unhealthy → fail fast
  }
}
```

---

## Observability

### Events

```ts
client.on("breaker:state", (e) => {
  console.log(`breaker ${e.key}: ${e.from} -> ${e.to}`);
});

client.on("request:failure", (e) => {
  console.error("request failed", e.error);
});
```

### Snapshot

```ts
const snap = client.snapshot();

console.log(snap.inFlight);
console.log(snap.queueDepth);
console.log(snap.breakers);
```

Useful for logs, debugging, or ad-hoc metrics.

---

## Demo (local, no deployment)

This repo includes a demo that visibly shows request coalescing, backpressure, and recovery under load.

### Terminal A — flaky upstream

```bash
npm run demo:upstream
```

### Terminal B — load generator

```bash
npm run demo:loadgen
```

You will see patterns like:

=== burst: cold-start ===
ok-1 ok-1 ok-1 ...

=== burst: cached ===
ok-1 ok-1 ok-1 ...

=== burst: refresh-with-stale ===
ok-1 ok-1 ok-2

=== burst: failure ===
ok-2 ok-2 ok-2

=== burst: recovered ===
ok-3 ok-3 ok-4


This shows:

only one upstream hit per burst

cached responses during spikes

safe reuse during refresh

fast recovery without restart

---

## When should you use this?

Good fit if you:

* call external APIs from Node.js
* run BFFs or API gateways
* send webhooks
* run background workers
* want predictable failure under load

---

## When should you NOT use this?

Not a good fit if you need:

* durable delivery across restarts
* distributed rate limiting
* cross-process coordination
* heavy retry orchestration

This library is **not** a service mesh.

---

## Design philosophy

* Explicit > clever
* Fail fast > degrade silently
* Small surface area > feature creep
* In-process resilience first

See `docs/DESIGN.md` for details.

---

## License

MIT


```
