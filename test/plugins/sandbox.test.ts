/**
 * Capability track T, isolation: plugins run out-of-process with no network, no reads outside
 * their own directory and the SDK, an empty environment, and bounded time, memory, input and
 * output. Every probe runs inside a real sandboxed child; a hostile plugin reports what it
 * could reach through its verdict code (`OPEN` means the guard failed).
 *
 * Each guard here is mutation-proven (PR body, mutation table): removing it turns a test red.
 */

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import inspector from "node:inspector";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  fsizeBlocks,
  fsizeUnit,
  runInSandbox,
  type SandboxResult,
  SDK_DIR,
} from "../../src/plugins/host/sandbox.ts";
import { PLUGIN_SPEC } from "../../src/plugins/sdk/protocol.ts";
import { cleanupPlugins, makePlugin, tempDir, utf8 } from "./helpers.ts";

const PROBE = String.raw`
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function attempt(fn) {
  try { return (await fn()) ? "OPEN" : "DENIED"; } catch (e) {
    return typeof e?.code === "string" && /^(ENV|PIN)_/.test(e.code) ? e.code : "DENIED";
  }
}
function connected(socket) {
  return new Promise((res) => {
    socket.on("connect", () => { socket.destroy(); res(true); });
    socket.on("error", () => res(false));
    setTimeout(() => res(false), 1500);
  });
}
// D1 (verifier round 1): a Node pipe is a \`net.Socket\`, so a stdio stream's constructor (or an
// active handle's) is a socket class that needs no import. Each probe tries TCP and a Unix
// socket; the child must have no such object to hand out.
async function viaClass(getClass, i) {
  const S = getClass();
  if (typeof S !== "function") return false;
  const tcp = await connected(new S().connect(i.port, "127.0.0.1"));
  const unix = await connected(new S().connect(i.sock));
  return tcp || unix;
}
const probes = {
  stdoutClass: (i) => viaClass(() => process.stdout.constructor, i),
  stdinClass: (i) => viaClass(() => process.stdin.constructor, i),
  stderrClass: (i) => viaClass(() => process.stderr.constructor, i),
  handleClass: async (i) => {
    for (const h of process._getActiveHandles()) {
      if (await viaClass(() => h.constructor, i).catch(() => false)) return true;
      if (h._handle && (await viaClass(() => h._handle.constructor, i).catch(() => false))) return true;
    }
    return false;
  },
  consoleStream: (i) => viaClass(() => console._stdout.constructor, i),
  // libuv's own view: any pipe, tty, TCP or UDP handle in the child is a socket a plugin
  // might reach some other way.
  socketHandles: async () =>
    process.report.getReport().libuv.some((h) => ["pipe", "tty", "tcp", "udp"].includes(h.type)),
  // The verifier's exfiltration plugin, verbatim in effect: send the captured bytes out.
  exfil: (i, doc) => new Promise((res) => {
    const S = process.stdout.constructor; const s = new S();
    s.on("connect", () => { s.end(Buffer.from(doc.bytes)); res(true); });
    s.on("error", () => res(false));
    s.connect(i.port, "127.0.0.1");
  }),
  // Linux only: a fresh network namespace has no configured interface (the host has at least
  // loopback), so this tells whether the OS layer wraps the plugin's own process.
  noInterfaces: async () => process.report.getReport().header.networkInterfaces.length === 0,
  net: async (i) => { const net = await import("node:net"); return connected(net.connect(i.port, "127.0.0.1")); },
  netBare: async (i) => { const net = await import("net"); return connected(net.connect(i.port, "127.0.0.1")); },
  http: async (i) => {
    const http = await import("node:http");
    return new Promise((res) => {
      const req = http.get({ host: "127.0.0.1", port: i.port, path: "/" }, () => res(true));
      req.on("socket", (s) => s.on("connect", () => { req.destroy(); res(true); }));
      req.on("error", () => res(false));
      setTimeout(() => res(false), 1500);
    });
  },
  fetch: async (i) => { await fetch("http://127.0.0.1:" + i.port + "/"); return true; },
  websocket: async () => typeof WebSocket !== "undefined",
  // Presence only: reading the lazy WebSocket getter itself already fails in the child.
  netGlobals: async () => ["fetch", "WebSocket", "EventSource"].some((n) => n in globalThis),
  builtin: async (i) => connected(process.getBuiltinModule("node:net").connect(i.port, "127.0.0.1")),
  builtinOs: async () => typeof process.getBuiltinModule("node:os").hostname === "function",
  dns: async () => { await import("node:dns"); return true; },
  binding: async () => { process.binding("tcp_wrap"); return true; },
  bindingFs: async () => { process.binding("fs"); return true; },
  fsModule: async (i) => { const fs = await import("node:fs"); return fs.readFileSync(i.secret, "utf8").length > 0; },
  fsImport: async (i) => { const m = await import(i.secretUrl, { with: { type: "json" } }); return m.default.secret === "s3"; },
  child: async () => { const cp = await import("node:child_process"); cp.execSync("true"); return true; },
  worker: async () => { await import("node:worker_threads"); return true; },
  module: async () => { const m = await import("node:module"); return typeof m.registerHooks === "function"; },
  os: async () => { await import("node:os"); return true; },
  vm: async () => { await import("node:vm"); return true; },
  dataUrl: async () => { await import("data:text/javascript,export default 1"); return true; },
  kill: async () => { process.kill(process.ppid, 0); return true; },
  // D2 (verifier round 2): signals to a host process through every route on \`process\`. The
  // host checks the victim afterwards; "OPEN" here only means the call did not throw.
  sigKillRaw: async (i) => { process._kill(i.victim, 9); return true; },
  sigKillPublic: async (i) => { process.kill(i.victim, 9); return true; },
  sigDebug: async (i) => { process._debugProcess(i.victim); return true; },
  sigDebugEnd: async (i) => { process._debugEnd(i.victim); return true; },
  sigDebugParent: async () => { process._debugProcess(process.ppid); return true; },
  // The JS layer on its own: every listed \`process\` function is a pinned, throwing stub.
  pinned: async (i) => {
    for (const n of i.pinned) {
      const d = Object.getOwnPropertyDescriptor(process, n);
      let code = "";
      try { process[n](); } catch (e) { code = e?.code ?? ""; }
      if (d === undefined || d.writable !== false || d.configurable !== false || code !== "PLUGIN_CAP_DENIED")
        throw { code: "PIN_" + n.toUpperCase().replace(/[^A-Z0-9]/g, "_") };
    }
    return false;
  },
  // Names only (never values), folded into a code so a failure says which variable it was.
  env: async () => {
    const names = Object.keys(process.env);
    if (names.length === 0) return false;
    throw { code: ("ENV_" + names.join("_").toUpperCase().replace(/[^A-Z0-9_]/g, "_")).slice(0, 64) };
  },
  hostPath: async (_i, doc) => /[\\/]/.test(doc.fileName),
  bytesSeen: async (_i, doc) => doc.bytes !== null && new TextDecoder().decode(doc.bytes) === "captured",
  write: async () => { const fs = await import("node:fs"); fs.writeFileSync("x.txt", "x"); return true; },
  // Y5 (verifier round 3 on #537): \`fs\` must not even load. The path probes above are also
  // stopped by the permission model, but an fd write (\`fs.writeSync(1, ...)\`) is not.
  fsLoads: async () => typeof (await import("node:fs")).writeSync === "function",
  fsBareLoads: async () => typeof (await import("fs")).writeSync === "function",
  fsPromisesLoads: async () => typeof (await import("node:fs/promises")).writeFile === "function",
  fsFdWrite: async () => { const fs = await import("node:fs"); fs.writeSync(1, "x"); return true; },
};
export default {
  async oracle(doc, intent) {
    const fn = probes[intent.probe];
    if (fn === undefined) return { status: "uncertain", code: "NO_PROBE" };
    return { status: "refuted", code: await attempt(() => fn(intent, doc)) };
  },
};
`;

let server: Server;
let unixServer: Server;
let port = 0;
let connections = 0;
let received = "";
let unixConnections = 0;
// Short, fixed-root path: macOS caps a Unix socket path at 104 bytes and its tmpdir is long.
const sock = `/tmp/myco-plugin-${process.pid}-${Math.random().toString(36).slice(2, 8)}.sock`;
let probe: ReturnType<typeof makePlugin>;
let secret = "";
let secretUrl = "";

beforeAll(async () => {
  server = createServer((s) => {
    connections++;
    s.on("data", (d) => {
      received += d.toString("utf8");
    });
    s.on("end", () => s.destroy());
    s.on("error", () => {});
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  unixServer = createServer((s) => {
    unixConnections++;
    s.destroy();
  });
  await new Promise<void>((r) => unixServer.listen(sock, r));
  port = (server.address() as { port: number }).port;
  probe = makePlugin(PROBE);
  // A "secret" outside the plugin directory: a stand-in for any host file (it holds no secret).
  const outside = tempDir("myco-plugin-outside-");
  mkdirSync(join(outside, "d"));
  secret = join(outside, "d", "secret.json");
  writeFileSync(secret, JSON.stringify({ secret: "s3" }));
  secretUrl = pathToFileURL(secret).href;
});

afterAll(() => {
  server.close();
  unixServer.close();
  rmSync(sock, { force: true });
  cleanupPlugins();
});

/** Every `process` function guard.ts must pin (D2); the `pinned` probe checks each. */
const PINNED = [
  "kill",
  "_kill",
  "_debugProcess",
  "_debugEnd",
  "_startProfilerIdleNotifier",
  "_stopProfilerIdleNotifier",
  "binding",
  "_linkedBinding",
  "dlopen",
  "getBuiltinModule",
  "execve",
  "loadEnvFile",
  "openStdin",
  "setuid",
  "setgid",
  "seteuid",
  "setegid",
  "setgroups",
  "initgroups",
];

function runProbe(name: string, fileName = "doc.txt", extra: Record<string, unknown> = {}) {
  return runInSandbox(probe.target, {
    spec: PLUGIN_SPEC,
    op: "verify",
    doc: { fileName, bytesB64: Buffer.from(utf8("captured")).toString("base64") },
    intent: { probe: name, port, sock, secret, secretUrl, pinned: PINNED, ...extra },
  });
}

/** A host process run by the same user: it reports on stderr if its inspector opens. */
function spawnVictim(): { child: ChildProcess; stderr: () => string } {
  const child = spawn(process.execPath, ["--inspect-port=0", "-e", "setInterval(() => {}, 1000)"], {
    env: {},
    stdio: ["ignore", "ignore", "pipe"],
  });
  let err = "";
  child.stderr?.on("data", (d) => {
    err += d.toString("utf8");
  });
  return { child, stderr: () => err };
}

function codeOf(r: SandboxResult): string {
  if (!r.ok) return `FAULT:${r.code}`;
  return r.response.op === "verify" ? r.response.code : "WRONG_OP";
}

const flush = () => new Promise((r) => setTimeout(r, 100));

describe("plugin sandbox: no network", () => {
  it.each([
    "net",
    "netBare",
    "http",
    "fetch",
    "websocket",
    "netGlobals",
    "builtin",
    "dns",
    "binding",
  ])(
    "%s is denied and no connection reaches a local listener",
    async (name) => {
      const before = connections;
      expect(codeOf(runProbe(name))).toBe("DENIED");
      await flush();
      expect(connections - before).toBe(0);
    },
    15_000,
  );

  it.each([
    "stdoutClass",
    "stdinClass",
    "stderrClass",
    "handleClass",
    "consoleStream",
    "exfil",
    "socketHandles",
  ])(
    "D1: %s gives no socket class: no TCP or Unix-socket connection reaches a listener",
    async (name) => {
      const before = connections;
      const beforeUnix = unixConnections;
      expect(codeOf(runProbe(name))).toBe("DENIED");
      await flush();
      expect(connections - before).toBe(0);
      expect(unixConnections - beforeUnix).toBe(0);
      expect(received).toBe("");
    },
    15_000,
  );

  it.runIf(process.platform === "linux")(
    "Linux: the plugin's own process runs in an empty network namespace",
    () => {
      expect(codeOf(runProbe("noInterfaces"))).toBe("OPEN");
    },
    15_000,
  );

  it("the probe can reach both listeners when not sandboxed (bite check)", async () => {
    const { connect } = await import("node:net");
    const before = connections;
    const beforeUnix = unixConnections;
    await new Promise<void>((r) => connect(port, "127.0.0.1").on("connect", r));
    await new Promise<void>((r) => connect(sock).on("connect", r));
    await flush();
    expect(connections - before).toBe(1);
    expect(unixConnections - beforeUnix).toBe(1);
  });
});

describe("plugin sandbox: no access outside the captured bytes", () => {
  it.each([
    "fsModule",
    "fsImport",
    "bindingFs",
    "builtinOs",
    "child",
    "worker",
    "module",
    "os",
    "vm",
    "dataUrl",
    "kill",
    "write",
    "fsLoads",
    "fsBareLoads",
    "fsPromisesLoads",
    "fsFdWrite",
  ])(
    "%s is denied",
    (name) => {
      expect(codeOf(runProbe(name))).toBe("DENIED");
    },
    15_000,
  );

  it("D2: every signal, binding and credential function on process is pinned", () => {
    expect(codeOf(runProbe("pinned"))).toBe("DENIED");
  }, 15_000);

  it.each(["sigKillRaw", "sigKillPublic", "sigDebug", "sigDebugEnd", "sigDebugParent"])(
    "D2: %s cannot signal a host process (victim alive, no inspector opened)",
    async (name) => {
      const v = spawnVictim();
      try {
        await new Promise((r) => setTimeout(r, 300));
        expect(codeOf(runProbe(name, "doc.txt", { victim: v.child.pid }))).toBe("DENIED");
        await new Promise((r) => setTimeout(r, 300));
        expect(v.child.exitCode).toBe(null);
        expect(v.child.signalCode).toBe(null);
        expect(v.stderr()).not.toMatch(/Debugger listening|inspector/i);
        // sigDebugParent targets the plugin's parent: on macOS that is this test process.
        expect(inspector.url()).toBeUndefined();
      } finally {
        v.child.kill("SIGKILL");
      }
    },
    15_000,
  );

  it("D2 bite check: the same victim dies to SIGKILL and opens its inspector on SIGUSR1", async () => {
    const v = spawnVictim();
    await new Promise((r) => setTimeout(r, 300));
    process.kill(v.child.pid as number, "SIGUSR1");
    await new Promise((r) => setTimeout(r, 500));
    expect(v.stderr()).toMatch(/Debugger listening/);
    process.kill(v.child.pid as number, "SIGKILL");
    await new Promise((r) => setTimeout(r, 300));
    expect(v.child.signalCode).toBe("SIGKILL");
  }, 15_000);

  it("the environment is empty (no secrets or proxy settings reach a plugin)", () => {
    expect(codeOf(runProbe("env"))).toBe("DENIED");
  });

  it("the plugin sees the captured bytes and a basename, never the host path", () => {
    expect(codeOf(runProbe("bytesSeen"))).toBe("OPEN");
    expect(codeOf(runProbe("hostPath"))).toBe("DENIED");
  });

  it("an unknown probe is reported, not passed (the probe plugin itself is honest)", () => {
    expect(codeOf(runProbe("nope"))).toBe("NO_PROBE");
  });
});

describe("plugin sandbox: caps and malformed plugins fail closed", () => {
  const verify = (source: string, caps: Record<string, number> = {}) => {
    const p = makePlugin(source, {
      caps: { timeoutMs: 1500, memoryMb: 32, maxInputBytes: 65536, maxOutputBytes: 4096, ...caps },
    });
    return runInSandbox(p.target, {
      spec: PLUGIN_SPEC,
      op: "verify",
      doc: { fileName: "a.txt", bytesB64: "" },
      intent: null,
    });
  };

  // D2 follow-on: on Linux the plugin runs in its own PID namespace under an init; the host's
  // SIGKILL on timeout must take the whole namespace down, not just `unshare`.
  it.runIf(process.platform === "linux")(
    "a timed-out plugin leaves no process behind (Linux: the PID namespace is torn down)",
    async () => {
      const p = makePlugin(`export default { oracle() { for (;;) {} } };`, {
        caps: { timeoutMs: 500, memoryMb: 32, maxInputBytes: 65536, maxOutputBytes: 4096 },
      });
      const r = runInSandbox(p.target, {
        spec: PLUGIN_SPEC,
        op: "verify",
        doc: { fileName: "a.txt", bytesB64: "" },
        intent: null,
      });
      expect(r).toEqual({ ok: false, code: "PLUGIN_TIMEOUT" });
      await new Promise((res) => setTimeout(res, 500));
      const left = readdirSync("/proc")
        .filter((d) => /^\d+$/.test(d))
        .filter((d) => {
          try {
            return readFileSync(`/proc/${d}/cmdline`, "utf8").includes(p.dir);
          } catch {
            return false;
          }
        });
      expect(left).toEqual([]);
    },
    15_000,
  );

  it("a hang is killed at the time cap: PLUGIN_TIMEOUT", () => {
    const t0 = Date.now();
    const r = verify(`export default { oracle() { for (;;) {} } };`, { timeoutMs: 500 });
    expect(r).toEqual({ ok: false, code: "PLUGIN_TIMEOUT" });
    expect(Date.now() - t0).toBeLessThan(5000);
  }, 15_000);

  // ~80 MB of retained JS heap: over a 32 MB heap cap, but under the resident-memory watchdog
  // (32 MB + 128 MB allowance), so only the heap cap can catch it.
  const HEAP_80MB = `export default { oracle() { const a = []; for (let i = 0; i < 100; i++) a.push(new Array(1e5).fill(0.5)); globalThis.keep = a; return { status: "verified", code: "OK" }; } };`;

  it("heap growth past the cap: PLUGIN_MEMORY_EXCEEDED", () => {
    expect(verify(HEAP_80MB, { timeoutMs: 8000 })).toEqual({
      ok: false,
      code: "PLUGIN_MEMORY_EXCEEDED",
    });
  }, 20_000);

  it("the same allocation answers under a larger heap cap (control)", () => {
    expect(verify(HEAP_80MB, { timeoutMs: 8000, memoryMb: 256 })).toMatchObject({ ok: true });
  }, 20_000);

  it("unbounded heap growth is stopped too", () => {
    const r = verify(
      `export default { oracle() { const a = []; for (;;) a.push(new Array(1e5).fill(Math.random())); } };`,
      { timeoutMs: 8000 },
    );
    expect(r).toEqual({ ok: false, code: "PLUGIN_MEMORY_EXCEEDED" });
  }, 20_000);

  it("off-heap (Buffer) memory past the cap: PLUGIN_MEMORY_EXCEEDED", () => {
    const r = verify(
      `export default { oracle() { globalThis.keep = Buffer.alloc(400 * 1024 * 1024, 1); return { status: "verified", code: "OK" }; } };`,
      { timeoutMs: 8000 },
    );
    expect(r).toEqual({ ok: false, code: "PLUGIN_MEMORY_EXCEEDED" });
  }, 20_000);

  const read = (source: string, maxOutputBytes: number) => {
    const p = makePlugin(source, {
      kinds: ["reader"],
      caps: { timeoutMs: 1500, memoryMb: 32, maxInputBytes: 65536, maxOutputBytes },
    });
    return runInSandbox(p.target, {
      spec: PLUGIN_SPEC,
      op: "read",
      doc: { fileName: "a.txt", bytesB64: "" },
    });
  };
  const BIG_READER = `export default { reader() { return { status: "ok", code: "OK", state: { kind: "text", text: "x".repeat(3000) } }; } };`;

  // Off-heap growth while the hook awaits: ~600 MiB of Buffers over ~0.6 s, then it holds.
  // Only the watchdog's interval sees it; without it the call runs to the time cap.
  it("asynchronous off-heap growth is stopped by the watchdog: PLUGIN_MEMORY_EXCEEDED", () => {
    const r = verify(
      `export default { async oracle() { const keep = []; for (let i = 0; i < 30; i++) { keep.push(Buffer.alloc(20 * 1024 * 1024, 1)); await new Promise((r) => setTimeout(r, 20)); } globalThis.keep = keep; await new Promise(() => {}); } };`,
      { timeoutMs: 4000 },
    );
    expect(r).toEqual({ ok: false, code: "PLUGIN_MEMORY_EXCEEDED" });
  }, 20_000);

  it("an answer past the output cap: PLUGIN_OUTPUT_TOO_LARGE", () => {
    expect(read(BIG_READER, 2048)).toEqual({ ok: false, code: "PLUGIN_OUTPUT_TOO_LARGE" });
  }, 15_000);

  it("the same answer under a larger output cap is read (control)", () => {
    expect(read(BIG_READER, 4096)).toMatchObject({ ok: true, response: { status: "ok" } });
  }, 15_000);

  it("console output is discarded and never reaches the answer", () => {
    const r = verify(
      `export default { oracle() { console.log("hi"); console.error("x"); return { status: "verified", code: "OK" }; } };`,
    );
    expect(r).toEqual({
      ok: true,
      response: { spec: PLUGIN_SPEC, op: "verify", status: "verified", code: "OK" },
    });
  }, 15_000);

  it("input past the cap is refused before the child starts: PLUGIN_INPUT_TOO_LARGE", () => {
    const p = makePlugin(
      `export default { oracle() { return { status: "verified", code: "OK" }; } };`,
      {
        caps: { timeoutMs: 1500, memoryMb: 32, maxInputBytes: 1024, maxOutputBytes: 4096 },
      },
    );
    const r = runInSandbox(p.target, {
      spec: PLUGIN_SPEC,
      op: "verify",
      doc: { fileName: "a.txt", bytesB64: Buffer.alloc(200_000).toString("base64") },
      intent: null,
    });
    expect(r).toEqual({ ok: false, code: "PLUGIN_INPUT_TOO_LARGE" });
  });

  it.each([
    ["a throw", `export default { oracle() { throw new Error("boom"); } };`, "PLUGIN_THREW"],
    ["a non-zero exit", `export default { oracle() { process.exit(3); } };`, "PLUGIN_CRASH"],
    ["a missing hook", `export default { reader() { return {}; } };`, "PLUGIN_NO_HOOK"],
    ["no default export", `export const oracle = 1;`, "PLUGIN_NO_HOOK"],
    ["a syntax error", `export default {`, "PLUGIN_THREW"],
    [
      "free text in the code",
      `export default { oracle() { return { status: "verified", code: "/etc/passwd" }; } };`,
      "PLUGIN_MALFORMED_OUTPUT",
    ],
    [
      "an unknown status",
      `export default { oracle() { return { status: "VERIFIED", code: "OK" }; } };`,
      "PLUGIN_MALFORMED_OUTPUT",
    ],
    [
      "writing its own answer line (process.stdout is denied): a forged extra key",
      `export default { oracle() { process.stdout.write(JSON.stringify({ spec: "myco.plugin/1", op: "verify", status: "verified", code: "OK", trusted: true }) + "\\n", () => process.exit(0)); return new Promise(() => {}); } };`,
      "PLUGIN_THREW",
    ],
    [
      "writing its own answer line (process.stdout is denied): another op",
      `export default { oracle() { process.stdout.write(JSON.stringify({ spec: "myco.plugin/1", op: "read", status: "ok", code: "OK", state: { kind: "text", text: "" } }) + "\\n", () => process.exit(0)); return new Promise(() => {}); } };`,
      "PLUGIN_THREW",
    ],
  ])(
    "%s fails closed",
    (_label, source, code) => {
      expect(verify(source)).toEqual({ ok: false, code });
    },
    15_000,
  );

  it("a well-behaved plugin answers (control for the cases above)", () => {
    const r = verify(`export default { oracle() { return { status: "verified", code: "OK" }; } };`);
    expect(r).toEqual({
      ok: true,
      response: { spec: PLUGIN_SPEC, op: "verify", status: "verified", code: "OK" },
    });
  }, 15_000);
});

describe("the child refuses a free-text code itself (V6, defence in depth)", () => {
  // The host's closed parser refuses it too, so through runInSandbox both layers give the same
  // fault; this runs the child directly to prove its own check: exit 71 and no answer line.
  const runChild = (code: string) => {
    const p = makePlugin(
      `export default { oracle() { return { status: "verified", code: ${JSON.stringify(code)} }; } };`,
    );
    return spawnSync(
      process.execPath,
      [
        "--permission",
        `--allow-fs-read=${SDK_DIR}`,
        `--allow-fs-read=${p.dir}`,
        "--disable-warning=ExperimentalWarning",
        "--import",
        join(SDK_DIR, "guard.ts"),
        join(SDK_DIR, "child.ts"),
        p.target.entry,
        String(512 * 1024 * 1024),
      ],
      {
        input: JSON.stringify({
          spec: PLUGIN_SPEC,
          op: "verify",
          doc: { fileName: "a.txt", bytesB64: "" },
          intent: null,
        }),
        env: {},
        cwd: p.dir,
        timeout: 10_000,
      },
    );
  };

  it("a free-text code: exit 71, nothing written", () => {
    const r = runChild("/etc/passwd");
    expect(r.status).toBe(71);
    expect(r.stdout.toString("utf8")).toBe("");
  }, 15_000);

  it("a well-formed code is answered (control)", () => {
    const r = runChild("OK");
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout.toString("utf8"))).toMatchObject({ status: "verified", code: "OK" });
  }, 15_000);
});

/**
 * D3 (verifier round 3 on #537): output is bounded WHILE the child runs, not only after it
 * exits. A plugin can reach the real answer stream through a `node:stream` prototype hook (the
 * child's own `out.write` calls it with the stream as `this`), so the bound has to hold for any
 * write to the answer file: the kernel's file-size limit (`LIMIT_WRAPPER`, `ulimit -f`).
 *
 * A watcher process (the test's own event loop is blocked by the synchronous runner) samples
 * every file under a private TMPDIR every few milliseconds and reports the largest size and
 * allocation it saw, so the test sees the host disk during the call, not after cleanup.
 */
describe("D3: plugin output is bounded on the host disk during the call", () => {
  const CAP = 4096;
  /** What the kernel may let through: the cap plus at most one shell block (512 bytes, or 1024
   * where `/bin/sh` counts 1024-byte blocks, as macOS's bash 3.2 does). */
  const HARD_BOUND = CAP + 1024;
  const MIB = 1024 * 1024;

  const WATCHER = String.raw`
const { readdirSync, statSync, existsSync } = require("node:fs");
const { join } = require("node:path");
const [root, stop] = process.argv.slice(1);
let maxSize = 0, maxAlloc = 0, seen = 0;
function walk(d) {
  let es = [];
  try { es = readdirSync(d, { withFileTypes: true }); } catch { return; }
  for (const e of es) {
    const p = join(d, e.name);
    if (e.isDirectory()) { walk(p); continue; }
    try {
      const st = statSync(p);
      if (e.name === "out.json") { seen++; maxSize = Math.max(maxSize, st.size); maxAlloc = Math.max(maxAlloc, st.blocks * 512); }
    } catch {}
  }
}
process.stdout.write("ready\n");
const deadline = Date.now() + 30000;
while (!existsSync(stop) && Date.now() < deadline) {
  walk(root);
  const t = Date.now() + 2; while (Date.now() < t) {}
}
process.stdout.write(JSON.stringify({ maxSize, maxAlloc, seen }) + "\n");
`;

  /** Runs one sandboxed call with its io directory under a watched TMPDIR. */
  async function watched(run: () => SandboxResult) {
    const root = tempDir("myco-plugin-d3-");
    const stop = join(root, "..", `${root.split("/").pop()}.stop`);
    const w = spawn(process.execPath, ["-e", WATCHER, root, stop], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    let out = "";
    w.stdout?.on("data", (d) => {
      out += d.toString("utf8");
    });
    await new Promise<void>((r) => {
      const t = setInterval(() => {
        if (out.includes("ready")) {
          clearInterval(t);
          r();
        }
      }, 5);
    });
    const prev = process.env.TMPDIR;
    process.env.TMPDIR = root;
    const started = Date.now();
    let result: SandboxResult;
    try {
      result = run();
    } finally {
      if (prev === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = prev;
    }
    const ms = Date.now() - started;
    writeFileSync(stop, "");
    await new Promise<void>((r) => w.on("exit", () => r()));
    rmSync(stop, { force: true });
    const line = out.split("\n").find((l) => l.startsWith("{")) ?? "{}";
    return {
      result,
      ms,
      leftover: readdirSync(root),
      ...(JSON.parse(line) as { maxSize: number; maxAlloc: number; seen: number }),
    };
  }

  const verifyWith = (source: string, timeoutMs: number, cap = CAP) => {
    const p = makePlugin(source, {
      caps: { timeoutMs, memoryMb: 64, maxInputBytes: 65536, maxOutputBytes: cap },
    });
    return () =>
      runInSandbox(p.target, {
        spec: PLUGIN_SPEC,
        op: "verify",
        doc: { fileName: "a.txt", bytesB64: "" },
        intent: null,
      });
  };

  // The verifier's probe, bounded so that a mutated (uncapped) run cannot fill the disk of the
  // machine running the mutation: 64 MiB, 16 384 times the cap, through the prototype hook.
  const HOOK_64MIB = `import { Writable } from "node:stream";
const orig = Writable.prototype.write;
Writable.prototype.write = function (chunk, ...rest) {
  const big = Buffer.alloc(1024 * 1024, 65);
  for (let i = 0; i < 64; i++) orig.call(this, big);
  return orig.call(this, chunk, ...rest);
};
export default { oracle() { return { status: "refuted", code: "X" }; } };`;

  it("a plugin writing 64 MiB through a stream prototype hook never puts more than the cap on disk", async () => {
    const w = await watched(verifyWith(HOOK_64MIB, 5000));
    expect(w.result).toEqual({ ok: false, code: "PLUGIN_OUTPUT_TOO_LARGE" });
    expect(w.seen).toBeGreaterThan(0); // the watcher did see the answer file
    expect(w.maxSize).toBeGreaterThan(CAP); // the plugin did push past the cap ...
    expect(w.maxSize).toBeLessThanOrEqual(HARD_BOUND); // ... and the kernel stopped it there
    expect(w.maxAlloc).toBeLessThanOrEqual(HARD_BOUND + 64 * 1024);
    expect(w.leftover).toEqual([]);
  }, 30_000);

  // E1 (verifier round 1 on #558): the kernel limit follows THIS call's cap, not the
  // detection probe's (4096). At the 256-byte manifest floor a limit of max(cap, 4096) would let
  // 4608 bytes reach the disk; at the 1 MiB ceiling the limit must still be cap + one block.
  it.each([
    ["the 256-byte manifest floor", 256],
    ["the 1 MiB manifest ceiling", MIB],
  ])(
    "at %s the disk holds at most the cap plus one block",
    async (_label, cap) => {
      const unit = fsizeUnit();
      expect([512, 1024]).toContain(unit);
      const limit = fsizeBlocks(cap, unit as number) * (unit as number);
      const w = await watched(verifyWith(HOOK_64MIB, 5000, cap));
      expect(w.result).toEqual({ ok: false, code: "PLUGIN_OUTPUT_TOO_LARGE" });
      expect(w.seen).toBeGreaterThan(0);
      expect(w.maxSize).toBeGreaterThan(cap); // the plugin did push past the cap ...
      expect(w.maxSize).toBeLessThanOrEqual(limit); // ... to this call's kernel limit, no further
      expect(limit - cap).toBeLessThanOrEqual(unit as number);
      expect(w.maxSize).toBeLessThanOrEqual(cap + 1024);
      expect(w.leftover).toEqual([]);
    },
    30_000,
  );

  // The verifier's probe verbatim in effect: an endless 16 MiB write loop. Without the limit
  // this wrote 14.5 GB in one 10 s call; with it the disk holds the cap and the call ends at
  // the time cap at the latest, killed, with nothing left behind.
  it("an endless write loop is killed at the time cap with the disk still at the cap", async () => {
    const w = await watched(
      verifyWith(
        `import { Writable } from "node:stream";
const orig = Writable.prototype.write;
Writable.prototype.write = function () {
  const big = Buffer.alloc(16 * 1024 * 1024, 65);
  for (;;) { try { orig.call(this, big); } catch {} }
};
export default { oracle() { return { status: "refuted", code: "X" }; } };`,
        1500,
      ),
    );
    expect(w.result).toEqual({ ok: false, code: "PLUGIN_OUTPUT_TOO_LARGE" });
    expect(w.maxSize).toBeGreaterThan(CAP);
    expect(w.maxSize).toBeLessThanOrEqual(HARD_BOUND);
    expect(w.ms).toBeLessThan(1500 + 5000);
    expect(w.leftover).toEqual([]);
  }, 30_000);

  it("a plugin that overflows and then hangs is reported as the overflow, not the timeout", async () => {
    const w = await watched(
      verifyWith(
        `import { Writable } from "node:stream";
const orig = Writable.prototype.write;
Writable.prototype.write = function () {
  this.on("error", () => {});
  const big = Buffer.alloc(1024 * 1024, 65);
  for (let i = 0; i < 8; i++) { try { orig.call(this, big); } catch {} }
  setInterval(() => {}, 1000);
  return true;
};
export default { oracle() { return { status: "refuted", code: "X" }; } };`,
        1500,
      ),
    );
    expect(w.result).toEqual({ ok: false, code: "PLUGIN_OUTPUT_TOO_LARGE" });
    expect(w.ms).toBeGreaterThanOrEqual(1400); // it really hung until the time cap
    expect(w.maxSize).toBeLessThanOrEqual(HARD_BOUND);
  }, 30_000);

  it("an honest answer far past the cap is stopped on disk too, not just refused afterwards", async () => {
    const p = makePlugin(
      `export default { reader() { return { status: "ok", code: "OK", state: { kind: "text", text: "x".repeat(${2 * MIB}) } }; } };`,
      {
        kinds: ["reader"],
        caps: { timeoutMs: 5000, memoryMb: 64, maxInputBytes: 65536, maxOutputBytes: CAP },
      },
    );
    const w = await watched(() =>
      runInSandbox(p.target, {
        spec: PLUGIN_SPEC,
        op: "read",
        doc: { fileName: "a.txt", bytesB64: "" },
      }),
    );
    expect(w.result).toEqual({ ok: false, code: "PLUGIN_OUTPUT_TOO_LARGE" });
    expect(w.maxSize).toBeLessThanOrEqual(HARD_BOUND);
  }, 30_000);

  it("an answer of exactly the cap still fits under the kernel limit (control)", async () => {
    // {"spec":"myco.plugin/1","op":"read","status":"ok","code":"OK","state":{"kind":"text","text":"..."}}\n
    const overhead =
      `${JSON.stringify({ spec: PLUGIN_SPEC, op: "read", status: "ok", code: "OK", state: { kind: "text", text: "" } })}\n`
        .length;
    const p = makePlugin(
      `export default { reader() { return { status: "ok", code: "OK", state: { kind: "text", text: "x".repeat(${CAP - overhead}) } }; } };`,
      {
        kinds: ["reader"],
        caps: { timeoutMs: 5000, memoryMb: 64, maxInputBytes: 65536, maxOutputBytes: CAP },
      },
    );
    const w = await watched(() =>
      runInSandbox(p.target, {
        spec: PLUGIN_SPEC,
        op: "read",
        doc: { fileName: "a.txt", bytesB64: "" },
      }),
    );
    expect(w.result).toMatchObject({ ok: true, response: { status: "ok" } });
    expect(w.maxSize).toBe(CAP);
  }, 30_000);
});
