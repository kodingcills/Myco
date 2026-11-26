/**
 * Track M isolation: skills can never become gate or grader input.
 *  - nothing under src/gate, src/benchmark (grader included), src/m2, src/integrity,
 *    src/verify or src/core imports src/skills;
 *  - src/skills imports the gate and the grader for TYPES only (`import type`), so no gate
 *    or grader code runs inside the skill store (the arm imports the published task set and
 *    nothing else from src/benchmark at runtime).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { ROOT } from "./helpers.ts";

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...tsFiles(p));
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

const IMPORT_LINE = /^\s*(import|export)\s[^;]*?from\s*["']([^"']+)["']/gms;

function imports(file: string): { spec: string; typeOnly: boolean }[] {
  const src = readFileSync(file, "utf8");
  return [...src.matchAll(IMPORT_LINE)].map((m) => ({
    spec: m[2] as string,
    typeOnly: /^\s*(import|export)\s+type\s/.test(m[0]),
  }));
}

describe("skills isolation", () => {
  it("no gate, grader, evidence, integrity, verify or core module imports src/skills", () => {
    const offenders: string[] = [];
    for (const d of ["gate", "benchmark", "m2", "integrity", "verify", "core"]) {
      for (const f of tsFiles(join(ROOT, "src", d)))
        for (const { spec } of imports(f))
          if (/(^|\/)skills\//.test(spec)) offenders.push(relative(ROOT, f));
    }
    expect(offenders).toEqual([]);
  });

  it("src/skills imports gate and grader modules for types only", () => {
    const offenders: string[] = [];
    for (const f of tsFiles(join(ROOT, "src", "skills")))
      for (const { spec, typeOnly } of imports(f)) {
        if (/\/(gate|benchmark\/grade|integrity|verify)\//.test(spec) && !typeOnly)
          offenders.push(`${relative(ROOT, f)} -> ${spec}`);
        if (/\/benchmark\//.test(spec) && !typeOnly && !spec.endsWith("/benchmark/taskset.ts"))
          offenders.push(`${relative(ROOT, f)} -> ${spec}`);
      }
    expect(offenders).toEqual([]);
  });

  it("the import scanner sees value imports (bite check)", () => {
    const fake =
      'import { gate } from "../gate/gate.ts";\nimport type { X } from "../gate/api.ts";\n';
    const found = [...fake.matchAll(IMPORT_LINE)].map((m) => [
      m[2],
      /^\s*(import|export)\s+type\s/.test(m[0]),
    ]);
    expect(found).toEqual([
      ["../gate/gate.ts", false],
      ["../gate/api.ts", true],
    ]);
  });
});
