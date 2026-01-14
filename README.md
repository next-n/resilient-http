
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

## What this library does

For every outbound HTTP request, it enforces:

### 1. Concurrency limits
- At most `maxInFlight` requests execute at once.
- Prevents connection exhaustion and event-loop overload.

### 2. Bounded queue (backpressure)
- Excess requests wait in a FIFO queue (up to `maxQueue`).
- If the queue is full → **reject immediately**.
- If waiting too long → **reject with a timeout**.

Failing early is a feature.

### 3. Request timeouts
- Every request has a hard timeout via `AbortController`.
- No hanging promises.

### 4. Circuit breaker (per upstream)
For each upstream (by default, per host):

- **CLOSED** → normal operation
- **OPEN** → fail fast during cooldown
- **HALF_OPEN** → limited probe requests to test recovery

This prevents hammering unhealthy dependencies.

### 5. Observability hooks
- Emits lifecycle events (queueing, failures, breaker transitions)
- Exposes a lightweight `snapshot()` for debugging

No metrics backend required.

---

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
  maxInFlight: 10,
  maxQueue: 50,
  enqueueTimeoutMs: 200,
  requestTimeoutMs: 150,
  breaker: {
    windowSize: 30,
    minRequests: 10,
    failureThreshold: 0.5,
    cooldownMs: 800,
    halfOpenProbeCount: 3,
  },
});

// Use it instead of fetch/axios directly
const res = await client.request({
  method: "GET",
  url: "https://api.example.com/data",
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

This repo includes a demo that **visibly shows** backpressure and circuit breaking.

### Terminal A — flaky upstream

```bash
npm run demo:upstream
```

### Terminal B — load generator

```bash
npm run demo:loadgen
```

You will see:

* queue growth and drain
* request rejections under load
* circuit breaker opening and half-opening
* recovery when upstream improves

This demo is intentionally noisy to make behavior obvious.

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
