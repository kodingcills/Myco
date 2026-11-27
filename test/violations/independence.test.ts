/**
 * Track O: the violation checker shares no code with the policy engine (an import-graph test,
 * as for the grader), so the engine never grades itself. Both directions are walked.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "..", "..");
const CHECKER = join(ROOT, "src", "violations");
const ENGINE = join(ROOT, "src", "policy");
const ALLOWED_BUILTINS = new Set(["node:path"]);

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

describe("violation checker independence (track O)", () => {
  it("the checker imports nothing outside src/violations/ except allowed builtins", () => {
    const files = tsFiles(CHECKER);
    expect(files.length).toBeGreaterThanOrEqual(1);
    const bad: string[] = [];
    for (const f of files)
      for (const [mod, specs] of walk(f)) {
        if (!mod.startsWith(`${CHECKER}/`)) bad.push(`${relative(ROOT, mod)} reached`);
        for (const s of specs)
          if (!s.startsWith(".") && !ALLOWED_BUILTINS.has(s)) bad.push(`${relative(ROOT, mod)}: ${s}`);
      }
    expect(bad).toEqual([]);
  });

  it("the policy engine never reaches the checker", () => {
    const reached: string[] = [];
    for (const f of tsFiles(ENGINE))
      for (const mod of walk(f).keys())
        if (mod.startsWith(`${CHECKER}/`)) reached.push(relative(ROOT, mod));
    expect(reached).toEqual([]);
  });

  it("the checker names no policy-engine module or vocabulary", () => {
    for (const f of tsFiles(CHECKER)) {
      const code = readFileSync(f, "utf8").replace(/^\s*(\/\/|\*|\/\*\*).*$/gm, "");
      expect(code, relative(ROOT, f)).not.toMatch(/policy\/|POLICY_|PolicyGuard|createPolicyEngine/);
    }
  });
});
