import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Invariant for the additive `claim` trace event (gui-spec §6.4): claims are display and
 * audit evidence only. No verifier, adapter, task, or Foundry oracle may read trace events
 * or the evidence module, so a claim can never raise a verdict. This test enforces it
 * rather than leaving it a convention.
 */
const ROOT = join(import.meta.dirname, "..");
const GUARDED = ["src/verify", "src/win", "src/tasks", "src/foundry/oracles"];

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".ts")) out.push(path);
  }
  return out;
}

describe("claim isolation", () => {
  const files = GUARDED.flatMap((d) => {
    try {
      return tsFiles(join(ROOT, d));
    } catch {
      return [];
    }
  });

  it("guards a non-empty set of files", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it("no verifier/oracle code imports the evidence module or the trace schema", () => {
    const imports = /from\s+["'][^"']*(core\/evidence|schemas\/trace-events)(\.ts)?["']/;
    expect(files.filter((f) => imports.test(readFileSync(f, "utf8")))).toEqual([]);
  });

  it("no verifier/oracle code reads a trace event of type claim", () => {
    const reads = /type\s*[=!]==?\s*["']claim["']|["']claim["']\s*:/;
    expect(files.filter((f) => reads.test(readFileSync(f, "utf8")))).toEqual([]);
  });
});
