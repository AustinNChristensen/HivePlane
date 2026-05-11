import { createServer, type Server } from "node:http";
import { describe, expect, it } from "vitest";
import { probeHiveVersion, probePortInUse } from "./port-probe.js";

function listenOnFreePort(handler?: (req: unknown, res: { end: (b: string) => void }) => void): {
  server: Server;
  port: Promise<number>;
} {
  const server = createServer((req, res) => {
    if (handler) {
      handler(req, res as never);
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ service: "hiveplane-hive", version: "0.0.4" }));
  });
  const port = new Promise<number>((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr !== "object") {
        reject(new Error("no address"));
        return;
      }
      resolve(addr.port);
    });
  });
  return { server, port };
}

describe("probePortInUse", () => {
  it("detects a bound TCP port", async () => {
    const { server, port: portPromise } = listenOnFreePort();
    const port = await portPromise;
    try {
      const result = probePortInUse(port);
      // On a system without lsof OR ss the result is `null` — skip the
      // assertion in that environment rather than failing spuriously.
      if (result.listening === null) return;
      expect(result.listening).toBe(true);
      expect(result.details).toContain(String(port));
    } finally {
      server.close();
    }
  });

  it("returns false for a port nothing is listening on", () => {
    // Pick a port high enough to be unused even on a busy CI box. Port 0 is
    // not a valid TCP port for this check — use a fixed high port instead.
    const result = probePortInUse(54321);
    if (result.listening === null) return;
    expect(result.listening).toBe(false);
    expect(result.details).toBe("");
  });
});

describe("probeHiveVersion", () => {
  it("recognises the Hive's own /version response", async () => {
    const { server, port: portPromise } = listenOnFreePort();
    const port = await portPromise;
    try {
      const result = await probeHiveVersion("127.0.0.1", port);
      expect(result).toEqual({ kind: "hive", version: "0.0.4" });
    } finally {
      server.close();
    }
  });

  it("flags a stranger that returns the wrong JSON", async () => {
    const { server, port: portPromise } = listenOnFreePort((_req, res) => {
      res.end(JSON.stringify({ error: "not_found" }));
    });
    const port = await portPromise;
    try {
      const result = await probeHiveVersion("127.0.0.1", port);
      expect(result.kind).toBe("stranger");
      if (result.kind === "stranger") {
        expect(result.body).toContain("not_found");
      }
    } finally {
      server.close();
    }
  });

  it("flags a stranger that returns non-JSON", async () => {
    const { server, port: portPromise } = listenOnFreePort((_req, res) => {
      res.end("hello from some other server");
    });
    const port = await portPromise;
    try {
      const result = await probeHiveVersion("127.0.0.1", port);
      expect(result.kind).toBe("stranger");
    } finally {
      server.close();
    }
  });

  it("returns 'unreachable' when nothing is listening", async () => {
    const result = await probeHiveVersion("127.0.0.1", 54322);
    expect(result.kind).toBe("unreachable");
  });

  it("substitutes localhost for an unroutable wildcard host", async () => {
    const { server, port: portPromise } = listenOnFreePort();
    const port = await portPromise;
    try {
      // 0.0.0.0 isn't a routable destination — the probe should rewrite it
      // to 127.0.0.1 and successfully reach the bound server.
      const result = await probeHiveVersion("0.0.0.0", port);
      expect(result.kind).toBe("hive");
    } finally {
      server.close();
    }
  });
});
