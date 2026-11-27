/**
 * Track C, structural guarantees (directory-scanning): an agent-written check shares no code
 * with the independent grader, no gate module can reach it, and the ledger checks reach only
 * its import-free label module. Walks the transitive relative-import graph, as
 * `test/benchmark/independence.test.ts` does for the grader.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "..", "..");
const SRC = join(ROOT, "src");
const AGENT = join(SRC, "agent-checks");
const GRADE = join(SRC, "benchmark", "grade");
const LABEL = join(AGENT, "label.ts");

const IMPORT =
  /(?:import|export)\s[^;]*?from\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|require\s*\(\s*["']([^"']+)["']\s*\)|import\s+["']([^"']+)["']/g;

function specifiers(source: string): string[] {
  return [...source.matchAll(IMPORT)].map((m) => (m[1] ?? m[2] ?? m[3] ?? m[4]) as string);
}

function walk(entry: string, seen = new Set<string>()): Set<string> {
  if (seen.has(entry)) return seen;
  seen.add(entry);
  for (const spec of specifiers(readFileSync(entry, "utf8")))
    if (spec.startsWith(".")) walk(resolve(dirname(entry), spec), seen);
  return seen;
}

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return tsFiles(p);
    return p.endsWith(".ts") ? [p] : [];
  });
}

const rel = (p: string) => relative(ROOT, p);
const agentFiles = tsFiles(AGENT);

describe("track C boundaries", () => {
  it("has the modules to check", () => {
    expect(agentFiles.map(rel).sort()).toEqual([
      "src/agent-checks/check.ts",
      "src/agent-checks/label.ts",
    ]);
  });

  it("an agent-written check never reaches the grader, or any benchmark module", () => {
    const reached = agentFiles.flatMap((f) =>
      [...walk(f)].filter((m) => m.startsWith(join(SRC, "benchmark"))).map(rel),
    );
    expect(reached).toEqual([]);
  });

  it("the grader never reaches an agent-written check", () => {
    const reached = tsFiles(GRADE).flatMap((f) =>
      [...walk(f)].filter((m) => m.startsWith(AGENT)).map(rel),
    );
    expect(reached).toEqual([]);
  });

  it("no gate module reaches an agent-written check (it cannot feed a verdict)", () => {
    const reached = tsFiles(join(SRC, "gate")).flatMap((f) =>
      [...walk(f)].filter((m) => m.startsWith(AGENT)).map((m) => `${rel(f)} -> ${rel(m)}`),
    );
    expect(reached).toEqual([]);
  });

  it("label.ts imports nothing, so the ledger checks stay off gate and sandbox code", () => {
    expect(specifiers(readFileSync(LABEL, "utf8"))).toEqual([]);
  });

  it("outside src/agent-checks, only the three ledger checks import it, and only its label", () => {
    const importers: string[] = [];
    for (const f of tsFiles(SRC)) {
      if (f.startsWith(AGENT)) continue;
      for (const spec of specifiers(readFileSync(f, "utf8")))
        if (spec.startsWith(".") && resolve(dirname(f), spec).startsWith(AGENT))
          importers.push(`${rel(f)} -> ${rel(resolve(dirname(f), spec))}`);
    }
    expect(importers.sort()).toEqual([
      "src/benchmark/check.ts -> src/agent-checks/label.ts",
      "src/m2/ab-pack.ts -> src/agent-checks/label.ts",
      "src/m2/evidence.ts -> src/agent-checks/label.ts",
    ]);
  });

  it("the walker sees a planted import (bite check)", () => {
    expect(
      specifiers('import { x } from "../benchmark/grade/grade.ts";\nimport "./y.ts";'),
    ).toEqual(["../benchmark/grade/grade.ts", "./y.ts"]);
  });
});
