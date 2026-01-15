// demo/upstream.ts
import http from "node:http";

let hits = 0;
const start = Date.now();

/**
 * Deterministic phases (time-based):
 * 0s..4s    : slow OK (shows singleflight + microcache)
 * 4s..9s    : fail (503) (shows leader-only retry + breaker + shedding)
 * 9s..      : recover OK (shows recovery + fresh cache)
 */
function modeNow(): "slow-ok" | "fail" | "recover" {
  const t = Date.now() - start;
  if (t < 4000) return "slow-ok";
  if (t < 9000) return "fail";
  return "recover";
}

const server = http.createServer((_, res) => {
  hits += 1;
  const mode = modeNow();

  console.log(`[upstream] hit #${hits} mode=${mode}`);

  if (mode === "fail") {
    // Return 503 quickly (retryable)
    setTimeout(() => {
      res.statusCode = 503;
      res.setHeader("content-type", "text/plain");
      res.end("upstream failing");
    }, 100);
    return;
  }

  const delay = mode === "slow-ok" ? 1500 : 200;

  setTimeout(() => {
    res.statusCode = 200;
    res.setHeader("content-type", "text/plain");
    res.end(`ok-${mode}-#${hits}`);
  }, delay);
});

server.listen(3001, () => {
  console.log("🚧 upstream listening on http://localhost:3001");
  console.log("phases: 0-4s slow-ok | 4-9s fail(503) | 9s+ recover");
});
