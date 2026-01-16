// demo/loadgen.ts
import { ResilientHttpClient } from "../src/client.js";

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

const client = new ResilientHttpClient({
  maxInFlight: 5,
  maxQueue: 20,
  enqueueTimeoutMs: 100,
  requestTimeoutMs: 4000,

  microCache: {
    enabled: true,
    ttlMs: 1000,
    maxStaleMs: 800,
    maxEntries: 100,

    // ⭐ important demo knobs
    maxWaiters: 10,
    followerTimeoutMs: 5000,

    retry: {
      maxAttempts: 3,
      baseDelayMs: 50,
      maxDelayMs: 200,
      retryOnStatus: [503],
    },
  },
});

// Observe behavior
client.on("microcache:retry", (e) =>
  console.log("[retry]", e.reason, `attempt ${e.attempt}`)
);
client.on("microcache:waiters_full", () =>
  console.log("[shed] follower queue full")
);
client.on("microcache:follower_window_closed", () =>
  console.log("[shed] follower window closed")
);
client.on("breaker:state", (e) =>
  console.log(`[breaker] ${e.key}: ${e.from} -> ${e.to}`)
);

async function burst(label: string, n: number) {
  console.log(`\n=== burst: ${label} (${n} requests) ===`);

  await Promise.allSettled(
    Array.from({ length: n }, async (_, i) => {
      try {
        const res = await client.request({
          method: "GET",
          url: "http://localhost:3001/data",
        });

        console.log(
          `[${label} #${i}]`,
          res.status,
          Buffer.from(res.body).toString()
        );
      } catch (err: any) {
        console.log(`[${label} #${i}] ERROR`, err.name);
      }
    })
  );
}

(async () => {
  // Cold start: singleflight + slow upstream
  await burst("cold-start", 10);

  // Cached: zero upstream hits
  await sleep(500);
  await burst("cached", 10);

  // TTL expires → refresh with stale serve
  await sleep(1200);
  await burst("refresh-with-stale", 10);

  // Failure window → leader retries, followers protected
  await sleep(900);
  await burst("failure", 20);

  // Recovery
  await sleep(4000);
  await burst("recovered", 10);

  console.log("\nDone.");
})();
