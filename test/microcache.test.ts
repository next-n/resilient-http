// test/microcache.test.ts
import { describe, expect, it } from "vitest";
import http from "node:http";
import { ResilientHttpClient } from "../src/client.js";

function startServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void
) {
  return new Promise<{ server: http.Server; url: string }>((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr === "object")
        resolve({ server, url: `http://127.0.0.1:${addr.port}` });
    });
  });
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

describe("micro-cache + singleflight", () => {
  it("dedupes concurrent identical GETs and caches 2xx for ttlMs (fresh window)", async () => {
    let hits = 0;

    const { server, url } = await startServer((_req, res) => {
      hits += 1;
      setTimeout(() => {
        res.statusCode = 200;
        res.setHeader("content-type", "text/plain");
        res.end("ok");
      }, 50);
    });

    const client = new ResilientHttpClient({
      maxInFlight: 10,
      maxQueue: 100,
      enqueueTimeoutMs: 500,
      requestTimeoutMs: 500,
      breaker: {
        windowSize: 50,
        minRequests: 20,
        failureThreshold: 0.5,
        cooldownMs: 5000,
        halfOpenProbeCount: 3,
      },
      microCache: { enabled: true, ttlMs: 200, maxStaleMs: 1000, maxEntries: 50 },
    });

    try {
      const req = { method: "GET" as const, url: `${url}/x?a=1` };

      // 1) singleflight: 10 concurrent calls -> 1 upstream hit
      await Promise.all(Array.from({ length: 10 }, () => client.request(req)));
      expect(hits).toBe(1);

      // 2) within ttlMs: cache hit -> still 1
      await client.request(req);
      expect(hits).toBe(1);

      // 3) after ttlMs: next call becomes leader and refreshes -> new hit
      await sleep(250);
      await client.request(req);
      expect(hits).toBe(2);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("after ttlMs, serves previous value while refresh is in-flight, then replaces cache on success", async () => {
    let hits = 0;
    let mode: "fast" | "slow" = "fast";

    const { server, url } = await startServer((_req, res) => {
      hits += 1;
      const delay = mode === "fast" ? 10 : 200;

      setTimeout(() => {
        res.statusCode = 200;
        res.setHeader("content-type", "text/plain");
        res.end(mode === "fast" ? "v1" : "v2");
      }, delay);
    });

    const client = new ResilientHttpClient({
      maxInFlight: 10,
      maxQueue: 100,
      enqueueTimeoutMs: 500,
      requestTimeoutMs: 1000,
      breaker: {
        windowSize: 50,
        minRequests: 20,
        failureThreshold: 0.5,
        cooldownMs: 5000,
        halfOpenProbeCount: 3,
      },
      microCache: { enabled: true, ttlMs: 100, maxStaleMs: 1000, maxEntries: 50 },
    });

    try {
      const req = { method: "GET" as const, url: `${url}/x` };

      // Prime cache with v1
      const r1 = await client.request(req);
      expect(Buffer.from(r1.body).toString("utf8")).toBe("v1");
      expect(hits).toBe(1);

      // Let ttl expire
      await sleep(130);

      // Switch to slow response producing v2
      mode = "slow";

      // Trigger refresh (leader). Don't await yet.
      const leaderPromise = client.request(req);

      await Promise.resolve(); // yield one tick
      // While refresh in-flight, other requests should return previous v1 immediately.
      // (They should NOT wait for v2)
      const follower = await client.request(req);
      expect(Buffer.from(follower.body).toString("utf8")).toBe("v1");

      // Now leader finishes and returns v2
      const leaderRes = await leaderPromise;
      expect(Buffer.from(leaderRes.body).toString("utf8")).toBe("v2");

      // After refresh success, cache should now be v2 (fresh window)
      const after = await client.request(req);
      expect(Buffer.from(after.body).toString("utf8")).toBe("v2");

      // Upstream hits: v1 prime + v2 refresh => 2 (followers did not add hits)
      expect(hits).toBe(2);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("if refresh fails within maxStaleMs, returns previous cached value (does not delete it)", async () => {
    let hits = 0;
    let failRefresh = false;

    const { server, url } = await startServer((_req, res) => {
      hits += 1;

      if (failRefresh) {
        setTimeout(() => {
          res.statusCode = 500;
          res.end("boom");
        }, 50);
        return;
      }

      res.statusCode = 200;
      res.setHeader("content-type", "text/plain");
      res.end("ok");
    });

    const client = new ResilientHttpClient({
      maxInFlight: 10,
      maxQueue: 100,
      enqueueTimeoutMs: 500,
      requestTimeoutMs: 500,
      breaker: {
        windowSize: 50,
        minRequests: 20,
        failureThreshold: 0.5,
        cooldownMs: 5000,
        halfOpenProbeCount: 3,
      },
      microCache: { enabled: true, ttlMs: 100, maxStaleMs: 300, maxEntries: 50 },
    });

    try {
      const req = { method: "GET" as const, url: `${url}/x` };

      // Prime cache with "ok"
      const r1 = await client.request(req);
      expect(Buffer.from(r1.body).toString("utf8")).toBe("ok");
      expect(hits).toBe(1);

      // ttl expires, refresh should be attempted
      await sleep(130);
      failRefresh = true;

      // This request triggers refresh, but since refresh fails and we're within maxStaleMs,
      // we should still get previous "ok".
      const r2 = await client.request(req);
      expect(Buffer.from(r2.body).toString("utf8")).toBe("ok");

      // We did attempt refresh (one more hit)
      expect(hits).toBe(2);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("after maxStaleMs, old cached value is not served; behavior resets to start", async () => {
    let hits = 0;
    let fail = false;

    const { server, url } = await startServer((_req, res) => {
      hits += 1;

      if (fail) {
        res.statusCode = 500;
        res.end("boom");
        return;
      }

      res.statusCode = 200;
      res.setHeader("content-type", "text/plain");
      res.end("ok");
    });

    const client = new ResilientHttpClient({
      maxInFlight: 10,
      maxQueue: 100,
      enqueueTimeoutMs: 500,
      requestTimeoutMs: 500,
      breaker: {
        windowSize: 50,
        minRequests: 20,
        failureThreshold: 0.5,
        cooldownMs: 5000,
        halfOpenProbeCount: 3,
      },
      microCache: { enabled: true, ttlMs: 100, maxStaleMs: 300, maxEntries: 50 },
    });

    try {
      const req = { method: "GET" as const, url: `${url}/x` };

      // Prime cache
      await client.request(req);
      expect(hits).toBe(1);

      // Wait beyond maxStaleMs so old value is too old
      await sleep(350);
      fail = true;

      // Now old cache must NOT be served; request should return upstream response (500)
      const res = await client.request(req);
      expect(res.status).toBe(500);

      // This call tried upstream again
      expect(hits).toBe(2);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("does not cache non-GET", async () => {
    let hits = 0;

    const { server, url } = await startServer((_req, res) => {
      hits += 1;
      res.statusCode = 200;
      res.end("ok");
    });

    const client = new ResilientHttpClient({
      maxInFlight: 10,
      maxQueue: 100,
      enqueueTimeoutMs: 500,
      requestTimeoutMs: 500,
      breaker: {
        windowSize: 50,
        minRequests: 20,
        failureThreshold: 0.5,
        cooldownMs: 5000,
        halfOpenProbeCount: 3,
      },
      microCache: { enabled: true, ttlMs: 100, maxStaleMs: 300, maxEntries: 50 },
    });

    try {
      const req = { method: "POST" as const, url: `${url}/x`, body: "hi" };
      await client.request(req);
      await client.request(req);
      expect(hits).toBe(2);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

it("shared follower window: after window closes, late followers fail fast until leader completes", async () => {
  let hits = 0;

  const { server, url } = await startServer((_req, res) => {
    hits += 1;
    // Leader takes 6s (longer than follower window 5s)
    setTimeout(() => {
      res.statusCode = 200;
      res.end("ok");
    }, 6000);
  });

  const client = new ResilientHttpClient({
    maxInFlight: 10,
    maxQueue: 100,
    enqueueTimeoutMs: 500,
    requestTimeoutMs: 10_000,
    breaker: {
      windowSize: 50,
      minRequests: 20,
      failureThreshold: 0.5,
      cooldownMs: 5000,
      halfOpenProbeCount: 3,
    },
    microCache: {
      enabled: true,
      ttlMs: 100,
      maxStaleMs: 200, // keep stale window small so we quickly get "no cache allowed" behavior
      maxEntries: 50,
      maxWaiters: 1000,
      followerTimeoutMs: 5000, // shared window
    },
  });

  try {
    const req = { method: "GET" as const, url: `${url}/slow` };

    // Start leader (no cache yet)
    const leader = client.request(req);

    // Wait > 5s so follower window should be closed, but leader still running (6s total)
    await sleep(5200);

    // Late follower should fail fast (no waiting)
    const start = Date.now();
    await expect(client.request(req)).rejects.toBeTruthy();
    const dur = Date.now() - start;
    expect(dur).toBeLessThan(200); // "fail fast" check; keep loose to avoid flakes

    // Leader completes eventually
    const leaderRes = await leader;
    expect(leaderRes.status).toBe(200);

    // Only 1 upstream hit (singleflight)
    expect(hits).toBe(1);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

it("follower cap: rejects immediately when maxWaiters is exceeded (no allowed cache)", async () => {
  let hits = 0;

  const { server, url } = await startServer((_req, res) => {
    hits += 1;
    // Leader takes 2s so followers are waiting
    setTimeout(() => {
      res.statusCode = 200;
      res.end("ok");
    }, 2000);
  });

  const client = new ResilientHttpClient({
    maxInFlight: 10,
    maxQueue: 100,
    enqueueTimeoutMs: 500,
    requestTimeoutMs: 10_000,
    breaker: {
      windowSize: 50,
      minRequests: 20,
      failureThreshold: 0.5,
      cooldownMs: 5000,
      halfOpenProbeCount: 3,
    },
    microCache: {
      enabled: true,
      ttlMs: 100,
      maxStaleMs: 200, // no cache allowed during this test
      maxEntries: 50,
      maxWaiters: 5, // small so test is fast
      followerTimeoutMs: 5000,
    },
  });

  try {
    const req = { method: "GET" as const, url: `${url}/cap` };

    // Start leader
    const leader = client.request(req);

    // Give it a tick so leader is registered inFlight
    await Promise.resolve();

    // Join 5 waiters (allowed)
    const followers = Array.from({ length: 5 }, () => client.request(req));

    // 6th follower should reject immediately
    await expect(client.request(req)).rejects.toBeTruthy();

    // Others should succeed when leader completes
    const res = await Promise.all([leader, ...followers]);
    for (const r of res) expect(r.status).toBe(200);

    // Single upstream hit
    expect(hits).toBe(1);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
it("leader-only retry: retryable statuses are retried by the leader, followers do not amplify retries", async () => {
  let hits = 0;

  const { server, url } = await startServer((_req, res) => {
    hits += 1;

    // 1st + 2nd attempt fail (retryable), 3rd succeeds
    if (hits <= 2) {
      res.statusCode = 503;
      res.end("busy");
      return;
    }

    res.statusCode = 200;
    res.setHeader("content-type", "text/plain");
    res.end("ok");
  });

  const client = new ResilientHttpClient({
    maxInFlight: 10,
    maxQueue: 100,
    enqueueTimeoutMs: 500,
    requestTimeoutMs: 2000,
    breaker: {
      windowSize: 50,
      minRequests: 20,
      failureThreshold: 0.5,
      cooldownMs: 5000,
      halfOpenProbeCount: 3,
    },
    microCache: {
      enabled: true,
      ttlMs: 200,
      maxStaleMs: 1000,
      maxEntries: 50,

      // 👇 ensure retry is enabled and deterministic for the test
      retry: {
        maxAttempts: 3, // leader does 1 + 2 retries
        baseDelayMs: 1, // keep the test fast
        maxDelayMs: 2,
        retryOnStatus: [503],
      },
    },
  });

  try {
    const req = { method: "GET" as const, url: `${url}/retry` };

    // 10 concurrent identical GETs:
    // - only ONE leader performs retries
    // - followers do not issue their own retries
    const results = await Promise.all(
      Array.from({ length: 10 }, () => client.request(req))
    );

    for (const r of results) {
      expect(r.status).toBe(200);
      expect(Buffer.from(r.body).toString("utf8")).toBe("ok");
    }

    // Upstream hits should be exactly 3 (503, 503, 200)
    expect(hits).toBe(3);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});