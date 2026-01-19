````md
# outbound-guard

A **process-local Node.js library for safe outbound HTTP access**.

It provides **two independent tools**, each solving a different real-world problem when calling external services:

---

## What this library provides

### 1. Resilient HTTP Client (requests under load)

For **on-demand HTTP calls** made by your application (APIs, BFFs, workers).

It protects your service when traffic spikes or upstreams misbehave by combining:

- request coalescing (duplicate GET collapse)
- bounded concurrency + queueing
- per-attempt timeouts
- a small health gate (OPEN → CLOSED → HALF_OPEN)

This is what you use when **your code actively sends requests**.

---

### 2. Instant GET Store (background polling)

For **continuously polling a single GET endpoint** and serving its latest value instantly.

It runs in the background, fetches on a fixed interval, and lets your code read the most recent value with zero latency.

This is what you use when **your code consumes external state**.

---

These two features are independent but complementary.

---

## Feature overview

| Feature | Purpose | Typical use |
|------|------|------|
| **ResilientHttpClient** | Protect outbound requests under load | APIs, gateways, webhook senders |
| **InstantGetStore** | Continuously poll & cache one GET endpoint | config flags, prices, health endpoints |

---

## 1. Resilient HTTP Client

A guarded HTTP client that keeps your service predictable under pressure.

### What it does
- Collapses identical GETs into a single upstream call
- Enforces per-host concurrency limits
- Uses a bounded FIFO queue (no unbounded memory)
- Fails fast when an upstream becomes unhealthy
- Retries safely without amplification

### When to use
- Calling third-party APIs
- Partner integrations
- Webhooks and background jobs
- Any request-driven outbound traffic

(Details below ⬇)

---

## 2. Instant GET Store

A lightweight **background poller for a single GET URL**.

### What it does
- Polls one URL on a fixed interval
- Stores the latest successful response
- `get()` returns instantly (no network call)
- Handles retry or stop behavior on failure
- Optionally waits until first successful fetch

### When to use
- Remote config endpoints
- Feature flags
- Prices, rates, counters
- “Read often, update periodically” data

(Details below ⬇)

---

---

## Install

```bash
npm install @nextn/outbound-guard
````

Node 18+ required (tested on Node 20).

---

## Quick links

* **Demos & usage examples**
  [https://github.com/next-n/guardtest]

---

## ─────────────────────────────

## Resilient HTTP Client

## ─────────────────────────────


```
