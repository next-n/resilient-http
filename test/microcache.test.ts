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
      if (addr && typeof addr === "object") {
        resolve({ server, url: `http://127.0.0.1:${addr.port}` });
      }
    });
  });
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

describe("micro-cache + coalescing", () => {
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
      requestTimeoutMs: 500,
      microCache: { enabled: true, ttlMs: 200, maxStaleMs: 1000, maxEntries: 50 },
    });


    try {
      const req = { method: "GET" as const, url: `${url}/x?a=1` };

      await Promise.all(Array.from({ length: 10 }, () => client.request(req)));
      expect(hits).toBe(1);

      await client.request(req);
      expect(hits).toBe(1);

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
      requestTimeoutMs: 1000,
      microCache: { enabled: true, ttlMs: 100, maxStaleMs: 1000, maxEntries: 50 },
    });

    try {
      const req = { method: "GET" as const, url: `${url}/x` };

      const r1 = await client.request(req);
      expect(Buffer.from(r1.body).toString("utf8")).toBe("v1");
      expect(hits).toBe(1);

      await sleep(130);
      mode = "slow";

      const leaderPromise = client.request(req);

      await Promise.resolve(); // yield
      const follower = await client.request(req);
      expect(Buffer.from(follower.body).toString("utf8")).toBe("v1");

      const leaderRes = await leaderPromise;
      expect(Buffer.from(leaderRes.body).toString("utf8")).toBe("v2");

      const after = await client.request(req);
      expect(Buffer.from(after.body).toString("utf8")).toBe("v2");

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
      requestTimeoutMs: 500,
      microCache: { enabled: true, ttlMs: 100, maxStaleMs: 300, maxEntries: 50 },
    });

    try {
      const req = { method: "GET" as const, url: `${url}/x` };

      const r1 = await client.request(req);
      expect(Buffer.from(r1.body).toString("utf8")).toBe("ok");
      expect(hits).toBe(1);

      await sleep(130);
      failRefresh = true;

      const r2 = await client.request(req);
      expect(Buffer.from(r2.body).toString("utf8")).toBe("ok");

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
       
      requestTimeoutMs: 500,
      microCache: { enabled: true, ttlMs: 100, maxStaleMs: 300, maxEntries: 50 },
    });

    try {
      const req = { method: "GET" as const, url: `${url}/x` };

      await client.request(req);
      expect(hits).toBe(1);

      await sleep(350);
      fail = true;

      const res = await client.request(req);
      expect(res.status).toBe(500);
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
       
      requestTimeoutMs: 500,
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

 
  it("follower cap: rejects immediately when maxWaiters is exceeded (no cache allowed)", async () => {
    let hits = 0;

    const { server, url } = await startServer((_req, res) => {
      hits += 1;
      setTimeout(() => {
        res.statusCode = 200;
        res.end("ok");
      }, 2000);
    });

    const client = new ResilientHttpClient({
      maxInFlight: 10,
       
      requestTimeoutMs: 10_000,
      microCache: {
        enabled: true,
        ttlMs: 100,
        maxStaleMs: 0, // ✅ no stale serving
        maxEntries: 50,
        maxWaiters: 5,
        followerTimeoutMs: 5000,
      },
    });

    try {
      const req = { method: "GET" as const, url: `${url}/cap` };

      const leader = client.request(req);
      await Promise.resolve();

      const followers = Array.from({ length: 5 }, () => client.request(req));

      await expect(client.request(req)).rejects.toBeTruthy();

      const res = await Promise.all([leader, ...followers]);
      for (const r of res) expect(r.status).toBe(200);

      expect(hits).toBe(1);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("leader-only retry: retryable statuses are retried by the leader, followers do not amplify retries", async () => {
    let hits = 0;

    const { server, url } = await startServer((_req, res) => {
      hits += 1;

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
       
      requestTimeoutMs: 2000,
      microCache: {
        enabled: true,
        ttlMs: 200,
        maxStaleMs: 1000,
        maxEntries: 50,
        retry: {
          maxAttempts: 3,
          baseDelayMs: 1,
          maxDelayMs: 2,
          retryOnStatus: [503],
        },
      },
    });

    try {
      const req = { method: "GET" as const, url: `${url}/retry` };

      const results = await Promise.all(
        Array.from({ length: 10 }, () => client.request(req))
      );

      for (const r of results) {
        expect(r.status).toBe(200);
        expect(Buffer.from(r.body).toString("utf8")).toBe("ok");
      }

      expect(hits).toBe(3);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
