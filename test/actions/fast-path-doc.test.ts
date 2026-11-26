/**
 * Track J: docs/product/fast-path.md is the feature's security model and its proposed
 * pre-registered bar. Pin the lines that must not drift, and check that every source and
 * test file it names exists.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ROUTE_PREFERENCE, ROUTE_TABLE } from "../../src/actions/router.ts";

const ROOT = resolve(import.meta.dirname, "..", "..");
const DOC = readFileSync(join(ROOT, "docs/product/fast-path.md"), "utf8");

describe("fast-path doc", () => {
  it.each([
    "**app API > script/shell > GUI**",
    "**A denial never falls back.**",
    "**It never decides completion.**",
    "`myco.gate/v1` is unchanged: still `taskId`, `runId`,\n  `claim`.",
    "`evidence: false` as a literal. They are never R1 evidence",
    "1. **No drop in verified rate (non-inferiority).**",
    "2. **Lower wall time per verified task.**",
    "3. **Fewer steps per verified task.**",
    "null never 0, never billed USD",
    "no result is claimed",
    "Claude Ultra only",
  ])("keeps %j", (line) => {
    expect(DOC).toContain(line);
  });

  it("describes the surface the launch plan actually has (D3)", () => {
    expect(DOC).toContain("**What is built here is the cap-only surface, not yet `hcu+shell+J`.**");
    expect(DOC).toContain('launches Claude Code with `--tools ""`');
    expect(DOC).not.toContain("Its surface is the paired baseline's surface plus");
  });

  it("states the soffice rule the policy enforces (D1)", () => {
    expect(DOC).toContain(
      "`soffice --headless --convert-to csv --outdir <scratch…> <the trial document>`",
    );
    expect(DOC).toContain("so `--accept=…` is `OPERAND_SHAPE`");
    expect(DOC).toContain("soffice runs with the resolved absolute paths");
    expect(DOC).not.toContain("--outdir <scratch…> <file>`");
  });

  it("states kernel-faithful path resolution and resolved operands (E1)", () => {
    expect(DOC).toContain("no lexical `..` collapsing first");
    expect(DOC).toContain("a `..` after a symlinked directory are `PATH_OUTSIDE_WORKSPACE`");
    expect(DOC).toContain("Every program then runs on the resolved absolute operands");
    expect(DOC).toContain("bounded to 4,096 characters");
  });

  it("the UNO API script's docstring matches what it calls (N1)", () => {
    const py = readFileSync(join(ROOT, "scripts/linux/calc_uno_api.py"), "utf8");
    expect(py).not.toContain("setFormula");
    for (const call of ["detectNumberFormat(", "convertStringToNumber(", "setValue(", "setString("])
      expect(py).toContain(call);
  });

  it("states the route preference the code uses", () => {
    expect(ROUTE_PREFERENCE).toEqual(["api", "script", "gui"]);
    expect(ROUTE_TABLE["calc.set-cell"]).toEqual(["api", "gui"]);
  });

  it("the sample-size arithmetic is right", () => {
    const z = 1.645;
    expect((90 * (0.05 / z) ** 2).toFixed(3)).toBe("0.083");
    expect((180 * (0.05 / z) ** 2).toFixed(3)).toBe("0.166");
    expect(DOC).toContain("p_d < n · (0.05 / 1.645)² ≈ 0.083 at n = 90");
    expect(DOC).toContain("allows p_d up to about 0.166");
  });

  it("every repo file it names in backticks exists", () => {
    const named = [
      ...DOC.matchAll(/`((?:src|test|scripts)\/[A-Za-z0-9_./-]+\.(?:ts|py|sh))`/g),
    ].map((m) => m[1] as string);
    expect(named.length).toBeGreaterThan(8);
    for (const path of named) expect(existsSync(join(ROOT, path)), path).toBe(true);
  });
});
