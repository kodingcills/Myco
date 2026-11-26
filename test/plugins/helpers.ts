/**
 * Test helpers for capability track T: build throwaway plugin directories in a temp dir.
 */
import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
