/**
 * Capability track T, the OS network layer (verifier round 1, D1). The module guard alone did
 * not close the network: a stdio pipe is a `net.Socket`, whose class needs no import. So every
 * plugin child now runs under an OS layer that closes the network whatever JavaScript it runs:
 * an empty network namespace on Linux, a deny-network Seatbelt profile on macOS. Without one,
 * no plugin runs.
 *
 * These tests exercise the OS layer ALONE: a plain `node` child with no permission model, no
 * guard and ordinary pipes, so nothing but the OS layer stands between it and the listener.
 */
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  detectNetworkIsolation,
  type NetworkIsolation,
  networkIsolation,
} from "../../src/plugins/host/sandbox.ts";
import { PLUGIN_SPEC } from "../../src/plugins/sdk/protocol.ts";
import { cleanupPlugins, makePlugin } from "./helpers.ts";

const SUPPORTED = process.platform === "linux" || process.platform === "darwin";

let tcp: Server;
let unix: Server;
let port = 0;
let tcpConnections = 0;
let unixConnections = 0;
const sock = `/tmp/myco-plugin-os-${process.pid}-${Math.random().toString(36).slice(2, 8)}.sock`;

beforeAll(async () => {
  tcp = createServer((s) => {
    tcpConnections++;
    s.destroy();
  });
  await new Promise<void>((r) => tcp.listen(0, "127.0.0.1", r));
  port = (tcp.address() as { port: number }).port;
  unix = createServer((s) => {
    unixConnections++;
    s.destroy();
  });
  await new Promise<void>((r) => unix.listen(sock, r));
});

afterAll(() => {
  tcp.close();
  unix.close();
  rmSync(sock, { force: true });
  cleanupPlugins();
});

/** Runs a plain node child (optionally under `prefix`) that tries one connection. */
function tryConnect(prefix: readonly string[], target: "tcp" | "unix"): Promise<string> {
  const to = target === "tcp" ? `${port}, "127.0.0.1"` : JSON.stringify(sock);
  const script = `const s = require("node:net").connect(${to});
s.on("connect", () => { process.stdout.write("OPEN"); s.destroy(); });
s.on("error", () => process.stdout.write("DENIED"));
setTimeout(() => { process.stdout.write("TIMEOUT"); process.exit(0); }, 3000).unref();`;
  const [cmd, ...args] = [...prefix, process.execPath, "-e", script];
  return new Promise((resolve) => {
    const child = spawn(cmd as string, args, { env: {}, stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (d) => {
      out += d.toString("utf8");
    });
    child.on("close", () => resolve(out));
  });
}

const flush = () => new Promise((r) => setTimeout(r, 150));

function prefixOf(i: NetworkIsolation): readonly string[] {
  if (i.kind === "none") throw new Error("no OS network layer on this host");
  return i.prefix;
}

describe("the OS network layer", () => {
  it.runIf(SUPPORTED)("is available on this host (Linux netns, macOS Seatbelt)", () => {
    expect(networkIsolation().kind).toBe(process.platform === "linux" ? "netns" : "seatbelt");
  });

  it("is never claimed on a platform without one", () => {
    expect(detectNetworkIsolation("win32")).toEqual({ kind: "none" });
  });

  it.runIf(SUPPORTED)(
    "alone blocks TCP: no connection reaches a host listener",
    async () => {
      const before = tcpConnections;
      expect(await tryConnect(prefixOf(networkIsolation()), "tcp")).not.toBe("OPEN");
      await flush();
      expect(tcpConnections - before).toBe(0);
    },
    20_000,
  );

  it.runIf(SUPPORTED)(
    "the same child connects without it (bite check)",
    async () => {
      const before = tcpConnections;
      const beforeUnix = unixConnections;
      expect(await tryConnect([], "tcp")).toBe("OPEN");
      expect(await tryConnect([], "unix")).toBe("OPEN");
      await flush();
      expect(tcpConnections - before).toBe(1);
      expect(unixConnections - beforeUnix).toBe(1);
    },
    20_000,
  );

  it.runIf(process.platform === "darwin")(
    "macOS: Seatbelt alone also blocks Unix-domain sockets",
    async () => {
      const before = unixConnections;
      expect(await tryConnect(prefixOf(networkIsolation()), "unix")).not.toBe("OPEN");
      await flush();
      expect(unixConnections - before).toBe(0);
    },
    20_000,
  );

  // Stated residual (docs/security/plugin-sandbox.md, residual risk 2): a network namespace
  // does not cover path-based Unix sockets. On Linux the plugin child is kept off them by
  // having no socket object at all and by the module guard (sandbox.test.ts, D1 probes).
  it.runIf(process.platform === "linux")(
    "Linux residual: the namespace alone does not block a path-based Unix socket",
    async () => {
      const before = unixConnections;
      expect(await tryConnect(prefixOf(networkIsolation()), "unix")).toBe("OPEN");
      await flush();
      expect(unixConnections - before).toBe(1);
    },
    20_000,
  );
});

describe("no OS network layer, no plugin run (fail closed)", () => {
  it("runInSandbox refuses with PLUGIN_NO_NET_ISOLATION", async () => {
    const real = Object.getOwnPropertyDescriptor(process, "platform") as PropertyDescriptor;
    Object.defineProperty(process, "platform", { ...real, value: "win32" });
    try {
      vi.resetModules();
      const fresh = await import("../../src/plugins/host/sandbox.ts");
      const p = makePlugin(
        `export default { oracle() { return { status: "verified", code: "OK" }; } };`,
      );
      expect(
        fresh.runInSandbox(p.target, {
          spec: PLUGIN_SPEC,
          op: "verify",
          doc: { fileName: "a.txt", bytesB64: "" },
          intent: null,
        }),
      ).toEqual({ ok: false, code: "PLUGIN_NO_NET_ISOLATION" });
    } finally {
      Object.defineProperty(process, "platform", real);
      vi.resetModules();
    }
  });
});
