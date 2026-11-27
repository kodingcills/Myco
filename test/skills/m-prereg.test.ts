/**
 * Track M's frozen pre-registration (capability-spec §3): the committed
 * `docs/product/capability-prereg/m-v1/prereg.json` holds every §3.1 item, its analysis files
 * are pinned by SHA-256 (and are exactly the analysis's runtime import closure), the open
 * questions are marked proposed (not ratified), the base-surface rule records M's place after
 * I and J, and the seeded ABBA schedule is derived from the assignment seed only.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { STEP_BUDGET } from "../../src/baseline/c1-trial.ts";
import { PILOT_MODEL } from "../../src/pilot/config.ts";
import {
  type BaseSurfaceBasis,
  type CapabilityOutcome,
  type LoadedMPrereg,
  M_PREREG_PATH,
  mSchedule,
  preregHash,
  preregProblems,
  readMPrereg,
  repoFileSha256,
  resolveBaseSurface,
} from "../../src/skills/m-prereg.ts";
import { canonicalJson } from "../../src/skills/record.ts";
import { ROOT, TASKS } from "./helpers.ts";

const LOADED = readMPrereg(ROOT);
const FILES = repoFileSha256(ROOT);

const withPrereg = (f: (p: Record<string, unknown>) => void): LoadedMPrereg => {
  const prereg = structuredClone(LOADED.prereg) as unknown as Record<string, unknown>;
  f(prereg);
  return {
    ...LOADED,
    prereg: prereg as unknown as LoadedMPrereg["prereg"],
    hash: preregHash(prereg),
  };
};

describe("m-v1 pre-registration", () => {
  it("is valid against the spec, the committed manifest and the analysis files", () => {
    expect(preregProblems(LOADED, FILES)).toEqual([]);
  });

  it("holds every capability-spec §3.1 item", () => {
    const p = LOADED.prereg;
    expect(p.bar).toMatchObject({ sided: "one-sided", alpha: 0.05, minDiscordant: 5 });
    expect(p.taskSet.version).toBe("rep-v1");
    expect(p.taskSet.manifestSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.keys(p.seeds).sort()).toEqual(["assignment", "bootstrap", "taskBuild"]);
    expect(p.stepBudget).toBe(STEP_BUDGET);
    expect(p.modelId).toBe(PILOT_MODEL);
    expect(p.analysis.command.startsWith("npx tsx scripts/m-learning-analysis.ts")).toBe(true);
    expect(p.analysis.files.map((f) => f.path)).toContain("scripts/m-learning-analysis.ts");
  });

  it("the pre-registration hash is SHA-256 over canonical JSON (key order does not matter)", () => {
    const text = readFileSync(join(ROOT, M_PREREG_PATH), "utf8");
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const reversed = Object.fromEntries(Object.entries(parsed).reverse());
    expect(preregHash(reversed)).toBe(LOADED.hash);
    expect(LOADED.hash).toBe(createHash("sha256").update(canonicalJson(parsed)).digest("hex"));
    expect(preregHash({ ...parsed, stepBudget: 31 })).not.toBe(LOADED.hash);
  });

  it("records the 06:21Z lead rulings; only n stays pending, so it is not ratified", () => {
    const p = LOADED.prereg as unknown as {
      ratification: { status: string; pending: { id: string; proposed: string }[] };
      leadRulings: { id: string; time: string; ruling: string; applied: string }[];
    };
    expect(p.ratification.status).toBe("proposed");
    expect(p.ratification.pending.map((x) => x.id)).toEqual(["n"]);
    expect(p.ratification.pending[0]?.proposed).toMatch(/caps? n at 60/);
    expect(p.leadRulings.map((r) => r.id).sort()).toEqual([
      "advice-delivery",
      "base-surface-both-shown",
      "learn-families",
      "model-id",
      "n",
    ]);
    for (const r of p.leadRulings) expect(r.time).toBe("2026-11-27T06:21Z");
    expect(p.leadRulings.find((r) => r.id === "n")?.applied).toMatch(/^Not yet/);
  });

  it("the n ceiling is real: rep-v1's rules allow at most 30 learn + 30 similar from fc-v1", () => {
    const pool = TASKS.filter((t) => t.faultClass === "none" && t.satisfiable);
    const seeds = new Set(pool.map((t) => t.fixtureSeed));
    expect(pool.length).toBe(60);
    expect(seeds.size).toBe(20);
    // Learn and similar tasks come from disjoint fixture seeds; each seed has 3 tasks.
    expect(Math.floor(seeds.size / 2) * 3).toBe(30);
  });

  it("the VM-hours estimate follows 375 s per trial, learn + 2 arms x test units", () => {
    const v = (
      LOADED.prereg as unknown as {
        vmHoursEstimate: {
          perTrialSeconds: number;
          options: { learn: number; testUnits: number; trials: number; vmHours: number }[];
        };
      }
    ).vmHoursEstimate;
    expect(v.perTrialSeconds).toBe(375);
    for (const o of v.options) {
      expect(o.trials).toBe(o.learn + 2 * o.testUnits);
      expect(o.vmHours).toBeCloseTo((o.trials * 375) / 3600, 1);
    }
    expect(v.options.map((o) => o.testUnits)).toEqual([90, 60, 40]);
  });

  it("records M's place after I and J", () => {
    expect(LOADED.prereg.baseSurface.measurementOrder).toEqual(["I", "J", "M"]);
    expect(
      preregProblems(
        withPrereg((p) => {
          (p.baseSurface as { measurementOrder: string[] }).measurementOrder = ["M", "I", "J"];
        }),
        FILES,
      ),
    ).toContain("baseSurface.measurementOrder is not I>J>M");
  });

  it("pins exactly the analysis's runtime import closure (fc-v1 sources are bound by the manifest)", () => {
    const IMPORT = /^\s*(import|export)\s[^;]*?from\s*["']([^"']+)["']/gms;
    const seen = new Set<string>();
    const visit = (rel: string) => {
      if (seen.has(rel)) return;
      seen.add(rel);
      const src = readFileSync(join(ROOT, rel), "utf8");
      for (const m of src.matchAll(IMPORT)) {
        const spec = m[2] as string;
        if (!spec.startsWith(".") || /^\s*(import|export)\s+type\s/.test(m[0])) continue;
        const next = relative(ROOT, resolve(dirname(join(ROOT, rel)), spec));
        if (next.startsWith("src/benchmark/") || next.startsWith("src/tasks/")) continue;
        visit(next);
      }
    };
    visit("scripts/m-learning-analysis.ts");
    expect(LOADED.prereg.analysis.files.map((f) => f.path).sort()).toEqual([...seen].sort());
  });

  it("an analysis file changed since the freeze is reported", () => {
    const tampered = (path: string) =>
      path === "src/skills/m-analysis.ts" ? "0".repeat(64) : FILES(path);
    expect(preregProblems(LOADED, tampered)).toEqual([
      "analysis file src/skills/m-analysis.ts changed since the freeze",
    ]);
    expect(preregProblems(LOADED, () => null).length).toBe(LOADED.prereg.analysis.files.length);
  });

  it.each([
    ["the bar's alpha", (p: Record<string, unknown>) => ((p.bar as { alpha: number }).alpha = 0.1)],
    ["the step budget", (p: Record<string, unknown>) => (p.stepBudget = 40)],
    [
      "the manifest digest",
      (p: Record<string, unknown>) =>
        ((p.taskSet as { manifestSha256: string }).manifestSha256 = "0".repeat(64)),
    ],
    ["a non-model planner", (p: Record<string, unknown>) => (p.modelId = "simulated:scripted")],
    [
      "equal seeds",
      (p: Record<string, unknown>) =>
        ((p.seeds as { bootstrap: string }).bootstrap = (
          p.seeds as { assignment: string }
        ).assignment),
    ],
    [
      "the test unit count",
      (p: Record<string, unknown>) => ((p.taskSet as { testUnits: number }).testUnits = 60),
    ],
    [
      "ratified with rulings still pending",
      (p: Record<string, unknown>) => ((p.ratification as { status: string }).status = "ratified"),
    ],
  ])("refuses a changed %s", (_n, f) => {
    expect(preregProblems(withPrereg(f), FILES).length).toBeGreaterThan(0);
  });
});

describe("base surface rule: best shown of I, J, else C1", () => {
  const H = "a".repeat(64);
  const o = (
    status: CapabilityOutcome["status"],
    rate: number | null = null,
  ): CapabilityOutcome => ({
    status,
    verifiedRate: rate,
    preregHash: status === "not-run" ? null : H,
  });
  it.each<[string, BaseSurfaceBasis, string]>([
    ["neither shown", { I: o("not-shown"), J: o("not-shown") }, "C1"],
    ["I shown, J not run", { I: o("shown", 0.5), J: o("not-run") }, "C1+I"],
    ["only J shown", { I: o("not-shown"), J: o("shown", 0.4) }, "hcu+shell+J"],
    ["both shown, J higher", { I: o("shown", 0.5), J: o("shown", 0.6) }, "hcu+shell+J"],
    ["both shown, I higher", { I: o("shown", 0.7), J: o("shown", 0.6) }, "C1+I"],
    ["both shown, tie goes to I", { I: o("shown", 0.6), J: o("shown", 0.6) }, "C1+I"],
  ])("%s", (_n, basis, surface) => {
    expect(resolveBaseSurface(basis)).toEqual({ ok: true, surface });
  });
  it("M is not measured before I is decided", () => {
    expect(resolveBaseSurface({ I: o("not-run"), J: o("shown", 0.9) })).toEqual({
      ok: false,
      code: "I_NOT_DECIDED",
    });
  });
  it("a decided capability needs its pre-registration hash, and a shown one its rate", () => {
    expect(
      resolveBaseSurface({
        I: { status: "shown", verifiedRate: 0.5, preregHash: null },
        J: o("not-run"),
      }),
    ).toEqual({ ok: false, code: "I_PREREG_MISSING" });
    expect(resolveBaseSurface({ I: o("not-shown"), J: o("shown") })).toEqual({
      ok: false,
      code: "J_RATE_MISSING",
    });
  });
});

describe("schedule (seeded, ABBA over test units)", () => {
  const seed = LOADED.prereg.seeds.assignment;
  const s = mSchedule(LOADED.manifest, seed);
  it("runs every learn task once and every test unit once per arm", () => {
    expect([...s.learn].sort()).toEqual(LOADED.manifest.learn.map((l) => l.taskId).sort());
    expect(s.test).toHaveLength(80);
    for (const u of LOADED.manifest.test)
      expect(
        s.test
          .filter((t) => t.unitId === u.unitId)
          .map((t) => t.arm)
          .sort(),
      ).toEqual(["cold", "skills-on"]);
  });
  it("alternates arm order in ABBA blocks", () => {
    for (let i = 0; i < 80; i += 4) {
      const a = s.test.slice(i, i + 4).map((t) => t.arm);
      expect(a[0]).toBe(a[3]);
      expect(a[1]).toBe(a[2]);
      expect(a[0]).not.toBe(a[1]);
    }
  });
  it("is a function of the assignment seed only", () => {
    expect(mSchedule(LOADED.manifest, seed)).toEqual(s);
    expect(mSchedule(LOADED.manifest, "another-seed-1234")).not.toEqual(s);
  });
});
