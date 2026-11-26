/**
 * Test helpers for capability track T: build throwaway plugin directories in a temp dir.
 */
import { spawn } from "node:child_process";
import {
  cpSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { SandboxTarget } from "../../src/plugins/host/sandbox.ts";

export const EXAMPLE_DIR = resolve(
  import.meta.dirname,
  "..",
  "..",
  "examples",
  "plugins",
  "csv-ledger",
);

const made: string[] = [];

export function cleanupPlugins(): void {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
}

export function tempDir(prefix = "myco-plugin-test-"): string {
  // realpath: on macOS tmpdir() is behind a symlink (/var -> /private/var), and the
  // permission model compares resolved paths.
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  made.push(d);
  return d;
}

export const BASE_MANIFEST = {
  spec: "myco.plugin/1",
  name: "hostile",
  version: "0.0.1",
  app: "hostile-app",
  kinds: ["oracle"],
  formats: [{ ext: ".txt", mediaType: "text/plain" }],
  claims: ["missing-file"],
  caps: { timeoutMs: 3000, memoryMb: 32, maxInputBytes: 65536, maxOutputBytes: 4096 },
  entry: "plugin.mjs",
};

/** A plugin directory with `source` as its entry (an ES module) and a manifest. */
export function makePlugin(
  source: string,
  manifest: Record<string, unknown> = {},
): { dir: string; target: SandboxTarget } {
  const dir = tempDir();
  const m = { ...BASE_MANIFEST, ...manifest };
  writeFileSync(join(dir, "myco-plugin.json"), JSON.stringify(m));
  writeFileSync(join(dir, m.entry as string), source);
  return {
    dir,
    target: {
      dir,
      entry: join(dir, m.entry as string),
      caps: m.caps as SandboxTarget["caps"],
    },
  };
}

/** A copy of the example plugin, with its manifest patched. */
export function copyExample(patch: Record<string, unknown> = {}): string {
  const dir = tempDir();
  cpSync(EXAMPLE_DIR, dir, { recursive: true });
  const path = join(dir, "myco-plugin.json");
  writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), ...patch }));
  return dir;
}

export const utf8 = (s: string) => new TextEncoder().encode(s);

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

/**
 * Runs `run` (synchronous sandboxed calls) with TMPDIR pointed at a private directory that a
 * watcher process samples every few milliseconds, and reports the largest `out.json` size and
 * allocation it saw (D3: the host disk during the call, not after cleanup). The test's own
 * event loop is blocked by the synchronous runner, so the watcher is another process.
 */
export async function watchDisk<T>(run: () => T) {
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
  let result: T;
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
