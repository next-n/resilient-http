// test/instant_get.test.ts
import { describe, it, expect } from "vitest";
import http from "node:http";
import { InstantGetStore } from "../src/instant_get.js";

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

function withMockedNow<T>(fakeNowMs: number, fn: () => T): T {
  const realNow = Date.now;
  Date.now = () => fakeNowMs;
  try {
    return fn();
  } finally {
    Date.now = realNow;
  }
}

describe("InstantGetStore", () => {
  it("waitReady returns true after first successful fetch (2xx)", async () => {
    let hits = 0;

    const { server, url } = await startServer((_req, res) => {
      hits += 1;
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
    });

    const store = new InstantGetStore();
    store.start(url, { intervalMs: 50 });

    const ready = await store.waitReady(3);
    expect(ready).toBe(true);
    expect(store.isReady()).toBe(true);

    const cached = store.get();
    expect(cached).toBeDefined();
    expect(Buffer.from(cached!.body).toString()).toBe("ok");

    const snap = store.snapshot();
    expect(snap).toBeDefined();
    expect(snap!.running).toBe(true);
    expect(snap!.ready).toBe(true);
    expect(snap!.url).toBe(url);

    store.stop();
    server.close();

    expect(hits).toBeGreaterThanOrEqual(1);
  });

  it("waitReady returns false when upstream never becomes healthy (in time)", async () => {
    let hits = 0;

    const { server, url } = await startServer((_req, res) => {
      hits += 1;
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("fail");
    });

    const store = new InstantGetStore();
    store.start(url, { intervalMs: 50 });

    const ready = await store.waitReady(1);
    expect(ready).toBe(false);
    expect(store.isReady()).toBe(false);

    // never cached (2xx only)
    expect(store.get()).toBeUndefined();

    store.stop();
    server.close();

    expect(hits).toBeGreaterThanOrEqual(1);
  });

  it("onError=stop stops polling after first failure", async () => {
    let hits = 0;

    const { server, url } = await startServer((_req, res) => {
      hits += 1;
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("fail");
    });

    const store = new InstantGetStore();
    store.start(url, { intervalMs: 50, onError: "stop" });

    const ready = await store.waitReady(1);
    expect(ready).toBe(false);
    expect(store.isReady()).toBe(false);

    // give it time; it should NOT keep retrying
    await sleep(250);
    expect(hits).toBe(1);

    const snap = store.snapshot();
    // stop() sets running=false by clearing timer
    expect(snap?.running ?? false).toBe(false);

    store.stop();
    server.close();
  });

  it("cache expires after 60 seconds (no real sleep; mock Date.now)", async () => {
    const { server, url } = await startServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
    });

    const store = new InstantGetStore();
    store.start(url, { intervalMs: 50 });

    const ready = await store.waitReady(3);
    expect(ready).toBe(true);

    const snap1 = store.snapshot();
    expect(snap1?.lastOkAt).toBeDefined();

    const t0 = snap1!.lastOkAt!;

    // fresh at t0 + 10s => still valid
    const v1 = withMockedNow(t0 + 10_000, () => store.get());
    expect(v1).toBeDefined();

    // expired at t0 + 61s => undefined
    const v2 = withMockedNow(t0 + 61_000, () => store.get());
    expect(v2).toBeUndefined();

    store.stop();
    server.close();
  });

  it("stop() resets running=false and ready=false", async () => {
    const { server, url } = await startServer((_req, res) => {
      res.writeHead(200);
      res.end("ok");
    });

    const store = new InstantGetStore();
    store.start(url, { intervalMs: 50 });

    const ready = await store.waitReady(3);
    expect(ready).toBe(true);
    expect(store.isReady()).toBe(true);

    store.stop();

    const snap = store.snapshot();
    // snapshot exists because url is set; but running should be false
    expect(snap).toBeDefined();
    expect(snap!.running).toBe(false);
    expect(snap!.ready).toBe(false);

    server.close();
  });
});
