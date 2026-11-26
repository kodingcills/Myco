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
import { spawn, spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  detectNetworkIsolation,
  fsizeBlocks,
  fsizeUnit,
  LIMIT_WRAPPER,
  type NetworkIsolation,
  networkIsolation,
  works,
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

/**
 * D3 (verifier round 3 on #537): detection runs every OS layer under the file-size limit and
 * refuses one under which node does not see exactly the expected limit, so a host where the
 * limit cannot reach the plugin never runs a plugin.
 */
describe("the output limit is part of the OS layer (D3)", () => {
  const passThrough = ["/bin/sh", "-c", 'exec "$@"', "sh"];

  it.runIf(SUPPORTED)(
    "a layer that leaves the limit alone is accepted (control)",
    () => {
      expect(works(passThrough)).toBe(true);
    },
    20_000,
  );

  it.runIf(SUPPORTED)(
    "a layer under which node sees another file-size limit is refused",
    () => {
      expect(works(["/bin/sh", "-c", 'ulimit -f 1; exec "$@"', "sh"])).toBe(false);
    },
    20_000,
  );

  /** The limits a plain node sees under `outer`, optionally followed by the limit wrapper. */
  const limitsSeen = (outer: string, wrapped: boolean) => {
    const script =
      "const u = process.report.getReport().userLimits;" +
      "process.stdout.write(JSON.stringify({ f: u.file_size_blocks.soft, c: u.core_file_size_blocks.soft }))";
    const r = spawnSync(
      "/bin/sh",
      [
        "-c",
        `${outer}; exec "$@"`,
        "sh",
        ...(wrapped ? [...LIMIT_WRAPPER, "9"] : []),
        process.execPath,
        "-e",
        script,
      ],
      { env: {}, encoding: "utf8" },
    );
    return JSON.parse(r.stdout || "{}") as { f?: number | string; c?: number | string };
  };

  it.runIf(SUPPORTED)(
    "the wrapper turns core dumps off and sets the file limit, whatever the host had",
    (ctx) => {
      const raise = "ulimit -c 1024";
      const bare = limitsSeen(raise, false);
      // Bite check: the host really had core dumps on for this child (skipped where the hard
      // limit is 0 and cannot be raised, so the case cannot be set up).
      if (bare.c === undefined || bare.c === 0) ctx.skip();
      expect(Number(bare.c)).toBeGreaterThan(0); // shell units differ (512 dash, 1024 macOS bash)
      expect(limitsSeen(raise, true)).toEqual({ f: 9 * (fsizeUnit() ?? Number.NaN), c: 0 });
    },
    20_000,
  );

  it.runIf(SUPPORTED)(
    "the shell's ulimit block size is measured as 512 or 1024 bytes",
    () => {
      expect([512, 1024]).toContain(fsizeUnit());
    },
    20_000,
  );

  it("the limit is the smallest whole number of blocks above the cap", () => {
    expect(fsizeBlocks(4096, 512)).toBe(9);
    expect(fsizeBlocks(4095, 512)).toBe(8);
    expect(fsizeBlocks(1, 512)).toBe(1);
    expect(fsizeBlocks(4096, 1024)).toBe(5);
    expect(fsizeBlocks(4095, 1024)).toBe(4);
  });
});

/**
 * D2 (verifier round 2): a plain child (no guard, no permission model) tries every `process`
 * route to signal a host process run by the same user. Linux: the PID namespace hides host
 * PIDs. macOS: Seatbelt denies signals to other processes.
 */
function trySignal(
  prefix: readonly string[],
  victim: number,
  routes: "debug" | "kill" | "all" = "all",
): Promise<string> {
  const debug = routes !== "kill" ? "() => process._debugProcess(v)," : "";
  const kill =
    routes !== "debug" ? '() => process._kill(v, 9), () => process.kill(v, "SIGKILL")' : "";
  const script = `const v = Number(process.argv[1]); const r = [];
for (const f of [${debug}${kill}]) {
  try { r.push(String(f())); } catch (e) { r.push(e.code || "THREW"); }
}
process.stdout.write(r.join(","));`;
  const [cmd, ...args] = [...prefix, process.execPath, "-e", script, String(victim)];
  return new Promise((resolve) => {
    const child = spawn(cmd as string, args, { env: {}, stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (d) => {
      out += d.toString("utf8");
    });
    child.on("close", () => resolve(out));
  });
}

/** `detached: false` puts the victim in this process's group, which the child shares too. */
function spawnVictim(detached = false) {
  const child = spawn(process.execPath, ["--inspect-port=0", "-e", "setInterval(() => {}, 1000)"], {
    env: {},
    stdio: ["ignore", "ignore", "pipe"],
    detached,
  });
  let err = "";
  child.stderr.on("data", (d) => {
    err += d.toString("utf8");
  });
  return { child, stderr: () => err };
}

describe("the OS layer alone blocks signals to host processes (D2)", () => {
  it.runIf(SUPPORTED).each([
    ["in the child's own process group", false],
    ["in another process group", true],
  ])(
    "_debugProcess, _kill and kill from inside it leave a host victim untouched (%s)",
    async (_where, detached) => {
      const v = spawnVictim(detached as boolean);
      try {
        await new Promise((r) => setTimeout(r, 300));
        await trySignal(prefixOf(networkIsolation()), v.child.pid as number);
        await new Promise((r) => setTimeout(r, 500));
        expect(v.stderr()).not.toMatch(/Debugger listening|inspector/i);
        expect(v.child.exitCode).toBe(null);
        expect(v.child.signalCode).toBe(null);
      } finally {
        v.child.kill("SIGKILL");
      }
    },
    20_000,
  );

  it.runIf(SUPPORTED)(
    "the same child kills the victim without it (bite check)",
    async () => {
      const v = spawnVictim();
      await new Promise((r) => setTimeout(r, 300));
      await trySignal([], v.child.pid as number, "debug");
      await new Promise((r) => setTimeout(r, 500));
      expect(v.stderr()).toMatch(/Debugger listening/);
      await trySignal([], v.child.pid as number, "kill");
      await new Promise((r) => setTimeout(r, 300));
      expect(v.child.signalCode).toBe("SIGKILL");
    },
    20_000,
  );

  it.runIf(process.platform === "linux")(
    "Linux: the child runs in its own PID namespace (its parent is the namespace init)",
    async () => {
      const [cmd, ...args] = [
        ...prefixOf(networkIsolation()),
        process.execPath,
        "-e",
        "process.stdout.write(process.pid + ',' + process.ppid)",
      ];
      const out = await new Promise<string>((resolve) => {
        const c = spawn(cmd as string, args, { env: {}, stdio: ["ignore", "pipe", "ignore"] });
        let o = "";
        c.stdout.on("data", (d) => {
          o += d.toString("utf8");
        });
        c.on("close", () => resolve(o));
      });
      expect(out).toBe("2,1");
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
