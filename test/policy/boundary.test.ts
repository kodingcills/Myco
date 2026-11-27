/**
 * Track O guardrails: the policy engine has no reference to the gate, vault, task registry,
 * grader or evidence root (capability spec 2 Part 1 section 1.2 rule 3), adds no `myco.gate/v1`
 * field, and the gate never imports it. Walks the transitive relative-import graph.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "..", "..");
const POLICY = join(ROOT, "src", "policy");

const IMPORT =
  /(?:import|export)\s[^;]*?from\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|require\s*\(\s*["']([^"']+)["']\s*\)|import\s+["']([^"']+)["']/g;

function specifiers(source: string): string[] {
  return [...source.matchAll(IMPORT)].map((m) => (m[1] ?? m[2] ?? m[3] ?? m[4]) as string);
}

function walk(entry: string, seen = new Map<string, string[]>()): Map<string, string[]> {
  if (seen.has(entry)) return seen;
  const specs = specifiers(readFileSync(entry, "utf8"));
  seen.set(entry, specs);
  for (const spec of specs) if (spec.startsWith(".")) walk(resolve(dirname(entry), spec), seen);
  return seen;
}

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...tsFiles(p));
    else if (name.endsWith(".ts")) out.push(p);
  }
  return out;
}

const policyFiles = tsFiles(POLICY);
const graph = new Map<string, string[]>();
for (const f of policyFiles) walk(f, graph);

/** Modules the engine must never reach. */
const FORBIDDEN_MODULE =
  /src\/(gate|vault|benchmark|registry|episode|proof|violations|m2)\/|src\/core\/(evidence|verify)|src\/tasks\/|src\/integrity\/|schemas\//;
const FORBIDDEN_BUILTIN = /^node:(child_process|net|http|https|worker_threads)$/;

describe("policy engine boundary (track O, Part 1 section 1.2 rule 3)", () => {
  it("has modules to check", () => {
    expect(policyFiles.length).toBeGreaterThanOrEqual(6);
  });

  it("reaches no gate, vault, registry, grader, evidence, episode or proof module", () => {
    const bad = [...graph.keys()]
      .map((m) => relative(ROOT, m))
      .filter((m) => FORBIDDEN_MODULE.test(m));
    expect(bad).toEqual([]);
  });

  it("imports no process launcher or network module, transitively", () => {
    const bad: string[] = [];
    for (const [mod, specs] of graph)
      for (const s of specs) if (FORBIDDEN_BUILTIN.test(s)) bad.push(`${relative(ROOT, mod)}: ${s}`);
    expect(bad).toEqual([]);
  });

  it("names no gate schema, vault, registry or evidence root in its code", () => {
    for (const f of policyFiles) {
      const code = readFileSync(f, "utf8").replace(/^\s*(\/\/|\*|\/\*\*).*$/gm, "");
      expect(code, relative(ROOT, f)).not.toMatch(
        /myco\.gate\/v1|evidenceRoot|EVIDENCE_ROOT|vault|registry|benchmark\/grade/i,
      );
    }
  });

  it("the gate never imports the policy engine (no gate field added)", () => {
    const gateFiles = tsFiles(join(ROOT, "src", "gate"));
    const gateGraph = new Map<string, string[]>();
    for (const f of gateFiles) walk(f, gateGraph);
    const reached = [...gateGraph.keys()]
      .map((m) => relative(ROOT, m))
      .filter((m) => m.startsWith("src/policy/"));
    expect(reached).toEqual([]);
  });
});
