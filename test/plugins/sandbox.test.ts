/**
 * Capability track T, isolation: plugins run out-of-process with no network, no reads outside
 * their own directory and the SDK, an empty environment, and bounded time, memory, input and
 * output. Every probe runs inside a real sandboxed child; a hostile plugin reports what it
 * could reach through its verdict code (`OPEN` means the guard failed).
 *
 * Each guard here is mutation-proven (PR body, mutation table): removing it turns a test red.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runInSandbox, type SandboxResult } from "../../src/plugins/host/sandbox.ts";
import { PLUGIN_SPEC } from "../../src/plugins/sdk/protocol.ts";
import { cleanupPlugins, makePlugin, tempDir, utf8 } from "./helpers.ts";

const PROBE = String.raw`
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function attempt(fn) {
  try { return (await fn()) ? "OPEN" : "DENIED"; } catch { return "DENIED"; }
}
function connected(socket) {
  return new Promise((res) => {
    socket.on("connect", () => { socket.destroy(); res(true); });
    socket.on("error", () => res(false));
    setTimeout(() => res(false), 1500);
  });
}
const probes = {
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
  builtin: async (i) => connected(process.getBuiltinModule("node:net").connect(i.port, "127.0.0.1")),
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
  env: async () => Object.keys(process.env).length > 0,
  hostPath: async (_i, doc) => /[\\/]/.test(doc.fileName),
  bytesSeen: async (_i, doc) => doc.bytes !== null && new TextDecoder().decode(doc.bytes) === "captured",
  write: async () => { const fs = await import("node:fs"); fs.writeFileSync("x.txt", "x"); return true; },
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
let port = 0;
let connections = 0;
let probe: ReturnType<typeof makePlugin>;
let secret = "";
let secretUrl = "";

beforeAll(async () => {
  server = createServer((s) => {
    connections++;
    s.destroy();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
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
  cleanupPlugins();
});

function runProbe(name: string, fileName = "doc.txt"): SandboxResult {
  return runInSandbox(probe.target, {
    spec: PLUGIN_SPEC,
    op: "verify",
    doc: { fileName, bytesB64: Buffer.from(utf8("captured")).toString("base64") },
    intent: { probe: name, port, secret, secretUrl },
  });
}

function codeOf(r: SandboxResult): string {
  if (!r.ok) return `FAULT:${r.code}`;
  return r.response.op === "verify" ? r.response.code : "WRONG_OP";
}

const flush = () => new Promise((r) => setTimeout(r, 100));

describe("plugin sandbox: no network", () => {
  it.each(["net", "netBare", "http", "fetch", "websocket", "builtin", "dns", "binding"])(
    "%s is denied and no connection reaches a local listener",
    async (name) => {
      const before = connections;
      expect(codeOf(runProbe(name))).toBe("DENIED");
      await flush();
      expect(connections - before).toBe(0);
    },
    15_000,
  );

  it("the probe can reach the listener when not sandboxed (bite check)", async () => {
    const { connect } = await import("node:net");
    const before = connections;
    await new Promise<void>((r) => connect(port, "127.0.0.1").on("connect", r));
    await flush();
    expect(connections - before).toBe(1);
  });
});

describe("plugin sandbox: no access outside the captured bytes", () => {
  it.each([
    "fsModule",
    "fsImport",
    "bindingFs",
    "child",
    "worker",
    "module",
    "os",
    "vm",
    "dataUrl",
    "kill",
    "write",
  ])(
    "%s is denied",
    (name) => {
      expect(codeOf(runProbe(name))).toBe("DENIED");
    },
    15_000,
  );

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

  it("output past the cap: PLUGIN_OUTPUT_TOO_LARGE", () => {
    const r = verify(
      `export default { oracle() { process.stdout.write("x".repeat(100000)); return { status: "verified", code: "OK" }; } };`,
    );
    expect(r).toEqual({ ok: false, code: "PLUGIN_OUTPUT_TOO_LARGE" });
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
      "stray output before the answer",
      `export default { oracle() { console.log("hi"); return { status: "verified", code: "OK" }; } };`,
      "PLUGIN_MALFORMED_OUTPUT",
    ],
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
      "a forged line with an extra key",
      `export default { oracle() { process.stdout.write(JSON.stringify({ spec: "myco.plugin/1", op: "verify", status: "verified", code: "OK", trusted: true }) + "\\n", () => process.exit(0)); return new Promise(() => {}); } };`,
      "PLUGIN_MALFORMED_OUTPUT",
    ],
    [
      "a forged answer for another op",
      `export default { oracle() { process.stdout.write(JSON.stringify({ spec: "myco.plugin/1", op: "read", status: "ok", code: "OK", state: { kind: "text", text: "" } }) + "\\n", () => process.exit(0)); return new Promise(() => {}); } };`,
      "PLUGIN_MALFORMED_OUTPUT",
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
