// test/microcache.test.ts
import { describe, expect, it } from "vitest";
import http from "node:http";
import { ResilientHttpClient } from "../src/client.js";

function startServer(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void) {
  return new Promise<{ server: http.Server; url: string }>((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") resolve({ server, url: `http://127.0.0.1:${addr.port}` });
    });
  });
}

describe("micro-cache + singleflight", () => {
  it("dedupes concurrent identical GETs and caches 2xx for TTL", async () => {
    let hits = 0;

    const { server, url } = await startServer((_req, res) => {
      hits += 1;
      setTimeout(() => {
        res.statusCode = 200;
        res.setHeader("content-type", "text/plain");
        res.end("ok");
      }, 80);
    });

    const client = new ResilientHttpClient({
      maxInFlight: 10,
      maxQueue: 100,
      enqueueTimeoutMs: 500,
      requestTimeoutMs: 500,
      breaker: { windowSize: 50, minRequests: 20, failureThreshold: 0.5, cooldownMs: 5000, halfOpenProbeCount: 3 },
      microCache: { enabled: true, ttlMs: 300, maxEntries: 50 },
    });

    try {
      // 1) singleflight: 10 concurrent calls -> 1 upstream hit
      const req = { method: "GET" as const, url: `${url}/x?a=1` };
      await Promise.all(Array.from({ length: 10 }, () => client.request(req)));
      expect(hits).toBe(1);

      // 2) cache hit within TTL -> still 1
      await client.request(req);
      expect(hits).toBe(1);

      // 3) after TTL -> new hit
      await new Promise((r) => setTimeout(r, 350));
      await client.request(req);
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
      breaker: { windowSize: 50, minRequests: 20, failureThreshold: 0.5, cooldownMs: 5000, halfOpenProbeCount: 3 },
      microCache: { enabled: true, ttlMs: 300, maxEntries: 50 },
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
