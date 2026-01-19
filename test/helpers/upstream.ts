// test/helpers/upstream.ts
import http from "node:http";

export async function startUpstream() {
  let mode: "ok" | "fail" = "ok";
  let hits = 0;

  const server = http.createServer((_req, res) => {
    hits++;

    if (mode === "ok") {
      res.statusCode = 200;
      res.end("OK");
      return;
    }

    res.statusCode = 500;
    res.end("FAIL");
  });

  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address() as any;

  return {
    url: `http://127.0.0.1:${addr.port}`,
    setMode(m: "ok" | "fail") {
      mode = m;
    },
    hits() {
      return hits;
    },
    close() {
      return new Promise<void>((r) => server.close(() => r()));
    },
  };
}
