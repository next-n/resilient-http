// test/health.test.ts
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

function errName(e: unknown): string {
  return (e as any)?.name ?? "";
}

describe("health gate (CLOSED/HALF_OPEN) + limiter + microcache", () => {
  it("CLOSED fails fast after 3 consecutive hard failures (timeouts)", async () => {
    // server always hangs (no response)
    const { server, url } = await startServer((_req, _res) => {
      // intentionally never end()
    });

    const client = new ResilientHttpClient({
      maxInFlight: 10,
      requestTimeoutMs: 50,
      microCache: { enabled: false as any }, // keep it off explicitly if your types allow
    } as any);

    try {
      const req = { method: "POST" as const, url: `${url}/hang`, body: "x" };

      // 3 consecutive hard fails => CLOSE
      for (let i = 0; i < 3; i++) {
        await expect(client.request(req)).rejects.toBeTruthy();
      }

      const start = Date.now();
      await expect(client.request(req)).rejects.toMatchObject({ name: "UpstreamUnhealthyError" });
      const dur = Date.now() - start;

      // should be "fast" (not waiting for request timeout)
      expect(dur).toBeLessThan(30);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("after cooldown: a normal request is rejected (probe only), then a probe request can reopen on success", async () => {
    let mode: "hang" | "ok" = "hang";

    const { server, url } = await startServer((_req, res) => {
      if (mode === "hang") {
        // never respond => timeout
        return;
      }
      res.statusCode = 200;
      res.end("ok");
    });

    const client = new ResilientHttpClient({
      maxInFlight: 10,
      requestTimeoutMs: 50,
      microCache: { enabled: true, ttlMs: 10, maxStaleMs: 1000, maxEntries: 50 },
    });

    try {
      const post = { method: "POST" as const, url: `${url}/t`, body: "x" };

      // CLOSE it
      for (let i = 0; i < 3; i++) {
        await expect(client.request(post)).rejects.toBeTruthy();
      }

      // wait past cooldown (base is 1000ms with jitter)
      await sleep(1400);

      // first normal request should put it into HALF_OPEN internally and reject (probe only)
      await expect(client.request(post)).rejects.toMatchObject({ name: "HalfOpenRejectedError" });

      // now allow probe success via microcache GET (leader refresh becomes probe)
      mode = "ok";
      const get = { method: "GET" as const, url: `${url}/probe` };

      const r = await client.request(get);
      expect(r.status).toBe(200);

      // after reopen, POST should work (no more HalfOpenRejected)
      const r2 = await client.request({ ...post, url: `${url}/ok2` });
      // server responds 200 for any request in ok mode
      expect(r2.status).toBe(200);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("probe failure re-closes (soft failure status)", async () => {
    let mode: "hang" | "softfail" | "ok" = "hang";

    const { server, url } = await startServer((_req, res) => {
      if (mode === "hang") return; // timeout
      if (mode === "softfail") {
        res.statusCode = 503;
        res.end("busy");
        return;
      }
      res.statusCode = 200;
      res.end("ok");
    });

    const client = new ResilientHttpClient({
      maxInFlight: 10,
      requestTimeoutMs: 50,
      microCache: { enabled: true, ttlMs: 10, maxStaleMs: 1000, maxEntries: 50 },
    });

    try {
      const post = { method: "POST" as const, url: `${url}/t`, body: "x" };

      for (let i = 0; i < 3; i++) {
        await expect(client.request(post)).rejects.toBeTruthy();
      }

      await sleep(1400);

      // enter half-open
      await expect(client.request(post)).rejects.toMatchObject({ name: "HalfOpenRejectedError" });

      // probe returns 503 => should re-close
      mode = "softfail";
      const get = { method: "GET" as const, url: `${url}/probe` };

      const res = await client.request(get);
      expect(res.status).toBe(503);

      // immediately after, should be CLOSED again (fast fail)
      const start = Date.now();
      await expect(client.request(post)).rejects.toMatchObject({ name: "UpstreamUnhealthyError" });
      expect(Date.now() - start).toBeLessThan(30);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("does NOT poison health on overload (QueueFullError should not count as HARD_FAIL)", async () => {
    // server responds slowly, but within timeout (so upstream is actually healthy)
    const { server, url } = await startServer((_req, res) => {
      setTimeout(() => {
        res.statusCode = 200;
        res.end("ok");
      }, 200);
    });

    // maxInFlight=1 => internal maxQueue = 10 => capacity 11 total
    const client = new ResilientHttpClient({
      maxInFlight: 1,
      requestTimeoutMs: 1000,
      microCache: { enabled: false as any },
    } as any);

    try {
      const req = { method: "POST" as const, url: `${url}/slow`, body: "x" };

      // Create > 11 concurrent to force QueueFull
      const ps = Array.from({ length: 20 }, () =>
        client.request(req).catch((e) => e)
      );

      const results = await Promise.all(ps);

      const queueFullCount = results.filter((x) => errName(x) === "QueueFullError").length;
      expect(queueFullCount).toBeGreaterThan(0);

      // If overload incorrectly poisoned health, we'd see UpstreamUnhealthyError next.
      // But upstream is healthy; after some time, a request should succeed.
      await sleep(300);
      const r2 = await client.request(req);
      expect(r2.status).toBe(200);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("per-base-url isolation: one upstream closes, the other stays open", async () => {
    // A hangs => closes
    const A = await startServer((_req, _res) => {
      // never respond
    });

    // B ok
    const B = await startServer((_req, res) => {
      res.statusCode = 200;
      res.end("ok");
    });

    const client = new ResilientHttpClient({
      maxInFlight: 5,
      requestTimeoutMs: 50,
      microCache: { enabled: false as any },
    } as any);

    try {
      const reqA = { method: "POST" as const, url: `${A.url}/x`, body: "x" };
      for (let i = 0; i < 3; i++) {
        await expect(client.request(reqA)).rejects.toBeTruthy();
      }
      await expect(client.request(reqA)).rejects.toMatchObject({ name: "UpstreamUnhealthyError" });

      const reqB = { method: "POST" as const, url: `${B.url}/y`, body: "y" };
      const rb = await client.request(reqB);
      expect(rb.status).toBe(200);
    } finally {
      await new Promise<void>((r) => A.server.close(() => r()));
      await new Promise<void>((r) => B.server.close(() => r()));
    }
  });

  it("queue flush on close: queued waiters get rejected when health transitions to CLOSED", async () => {
    // Always hang => timeouts => close => flush queue
    const { server, url } = await startServer((_req, _res) => {
      // never respond
    });

    const client = new ResilientHttpClient({
      maxInFlight: 1,
      requestTimeoutMs: 50,
      microCache: { enabled: false as any },
    } as any);

    try {
      const req = { method: "POST" as const, url: `${url}/hang`, body: "x" };

      // Start a bunch; many will be queued.
      const ps = Array.from({ length: 8 }, () => client.request(req).catch((e) => e));

      const results = await Promise.all(ps);

      // Expect at least one UpstreamUnhealthyError due to flush after close.
      const unhealthyCount = results.filter((x) => errName(x) === "UpstreamUnhealthyError").length;
      expect(unhealthyCount).toBeGreaterThan(0);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("microcache + CLOSED: serves stale when available, otherwise fails fast", async () => {
    let mode: "ok" | "hang" = "ok";

    const { server, url } = await startServer((_req, res) => {
      if (mode === "hang") return; // timeout
      res.statusCode = 200;
      res.end("v1");
    });

    const client = new ResilientHttpClient({
      maxInFlight: 10,
      requestTimeoutMs: 50,
      microCache: { enabled: true, ttlMs: 50, maxStaleMs: 1000, maxEntries: 50 },
    });

    try {
      const getCached = { method: "GET" as const, url: `${url}/cached` };
      const r1 = await client.request(getCached);
      expect(Buffer.from(r1.body).toString("utf8")).toBe("v1");

      // expire ttl so it becomes stale, but still within maxStaleMs
      await sleep(80);

      // close the upstream using POST timeouts
      mode = "hang";
      const post = { method: "POST" as const, url: `${url}/close`, body: "x" };
      for (let i = 0; i < 3; i++) {
        await expect(client.request(post)).rejects.toBeTruthy();
      }

      // Request cached key: should serve stale (v1) even while CLOSED
      const r2 = await client.request(getCached);
      expect(Buffer.from(r2.body).toString("utf8")).toBe("v1");

      // Request uncached key: should fail fast (no stale available)
      const getMiss = { method: "GET" as const, url: `${url}/miss` };
      await expect(client.request(getMiss)).rejects.toMatchObject({ name: "UpstreamUnhealthyError" });
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
