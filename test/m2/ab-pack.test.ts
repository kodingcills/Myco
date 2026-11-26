/**
 * The corrections A/B evidence pack (src/m2/ab-pack.ts; schemas/m2-ab-pack.ts): a separate pack
 * kind for the scorecard's experiment row, never R1 evidence. Expected statistics are the
 * independent reference values pinned in test/m2/corrections-ab.test.ts.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { BenchmarkArmRow } from "../../src/benchmark/check.ts";
import { checkAbPack, readAbPack } from "../../src/m2/ab-pack.ts";
import { checkPack, readPack } from "../../src/m2/evidence.ts";
import {
  AB_TASKS,
  type AbArmFiles,
  abArm,
  abConfig,
  stage1Arms,
  writeAbPack,
} from "./ab-fixture.ts";
import { manifest, input as packInput, r1Trials, writePack } from "./pack-fixture.ts";

const fresh = () => mkdtempSync(join(tmpdir(), "m2-ab-"));
const check = (dir: string, repoRoot: string) => checkAbPack(readAbPack(dir, repoRoot));

describe("an A/B pack, Stage 1", () => {
  it("is checked by the A/B analysis with evidence on, and reports the pre-registered test", () => {
    const root = fresh();
    try {
      const r = check(writeAbPack("m2-ab-s1", { stage: 1 }, root), root);
      expect(r.errors).toEqual([]);
      expect(r.ok).toBe(true);
      expect(r.kind).toBe("ab");
      expect(r.evidenceUse).toBe("experiment-only (never R1 evidence)");
      expect(r.manifest).toMatchObject({ row: "AB", stage: 1 });
      expect(r.ab).toMatchObject({
        pairs: 100,
        table: { both: 50, onOnly: 12, offOnly: 3, neither: 35 },
        effect: "corrections-help",
      });
      expect(r.ab?.signTestOneSidedP).toBeCloseTo(0.017578125, 12);
      expect(r.ab?.difference.ci95?.[0]).toBeCloseTo(0.01621993526115577, 10);
      expect(r.ab?.difference.ci95?.[1]).toBeCloseTo(0.16157233386670558, 10);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("needs its pre-registration, and the committed file must hash to the declared sha256", () => {
    const root = fresh();
    try {
      const dir = writeAbPack("m2-ab-s1", { stage: 1 }, root);
      writeFileSync(join(root, "prereg", "m2-ab-s1.md"), "edited after the run\n");
      expect(check(dir, root).errors.join("\n")).toMatch(/pre-registration/i);
      const none = writeAbPack(
        "m2-ab-none",
        { stage: 1, manifest: { preregistration: undefined } },
        root,
      );
      const r = check(none, root);
      expect(r.ok).toBe(false);
      expect(r.errors).toContain(
        "pack.json: a Stage-1 pack names its pre-registration (file and sha256)",
      );
      const outside = writeAbPack(
        "m2-ab-out",
        { stage: 1, manifest: { preregistration: { file: "../x.md", sha256: "a".repeat(64) } } },
        root,
      );
      expect(check(outside, root).ok).toBe(false);
      // The reader never opens a file outside the repository, whatever the schema says later.
      expect(readAbPack(outside, root).readErrors).toContain(
        "preregistration.file ../x.md: outside the repository",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("a gate miss halts it: the pack is not ok, so the scorecard may not cite it", () => {
    const root = fresh();
    try {
      const { off } = stage1Arms();
      const sat = AB_TASKS.filter((t) => t.satisfiable).map((t) => t.taskId);
      const on = abArm("on", 1, AB_TASKS, (t) => (t.taskId === sat[0] ? "false-done" : "refuted"));
      const r = check(writeAbPack("m2-ab-miss", { stage: 1, arms: { on, off } }, root), root);
      expect(r.ok).toBe(false);
      expect(r.ab?.halted).toBe(true);
      expect(r.errors.join("\n")).toMatch(/A\/B: INTEGRITY INCIDENT/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("evidence provenance inside the pack check", () => {
  it("refuses a simulated planner even in a Stage-0 pack (the analysis runs with evidence on)", () => {
    const root = fresh();
    try {
      const dir = writeAbPack("m2-ab-sim", { stage: 0 }, root);
      for (const side of ["on", "off"]) {
        const f = join(dir, side, "arm.jsonl");
        writeFileSync(f, readFileSync(f, "utf8").replaceAll("claude-sonnet-5-5", "simulated:dry"));
        const c = join(dir, side, "run-config.json");
        writeFileSync(c, readFileSync(c, "utf8").replaceAll("claude-sonnet-5-5", "simulated:dry"));
      }
      const r = check(dir, root);
      expect(r.ok).toBe(false);
      expect(r.errors.join("\n")).toMatch(
        /A\/B: corrections-ON: 30 row\(s\) without evidence provenance/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("an A/B pack, Stage 0: plumbing, effect claim null", () => {
  it("never claims an effect, whatever the numbers", () => {
    const root = fresh();
    try {
      const r = check(writeAbPack("m2-ab-s0", { stage: 0 }, root), root);
      expect(r.errors).toEqual([]);
      expect(r.ok).toBe(true);
      expect(r.ab).toMatchObject({ pairs: 30, effect: "not-claimed" });
      expect(r.ab?.signTestOneSidedP).toBeLessThan(0.05);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("carries no pre-registration and no Stage-0 ledgers of its own", () => {
    const root = fresh();
    try {
      const pre = writeAbPack(
        "m2-ab-s0p",
        { stage: 0, manifest: { preregistration: { file: "p.md", sha256: "a".repeat(64) } } },
        root,
      );
      writeFileSync(join(root, "p.md"), "x");
      expect(check(pre, root).errors).toContain(
        "pack.json: a Stage-0 pack carries no pre-registration (Stage 0 claims nothing)",
      );
      const extra = writeAbPack("m2-ab-s0x", { stage: 0 }, root);
      mkdirSync(join(extra, "stage0", "on"), { recursive: true });
      expect(check(extra, root).errors).toContain(
        "stage0: not part of the A/B pack layout (schemas/m2-ab-pack.ts)",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("the manifest, layout and process rules", () => {
  it("the manifest is closed: the row is AB, the evidence use is experiment-only, and no R rows", () => {
    const root = fresh();
    try {
      for (const [name, over, msg] of [
        ["m2-ab-r1", { row: "R1" }, /pack.json: \$\.row/],
        ["m2-ab-use", { evidenceUse: "R1 evidence" }, /pack.json: \$\.evidenceUse/],
        ["m2-ab-rows", { rows: ["R1"] }, /pack.json: .*rows/],
        ["m2-ab-st", { stage: 2 }, /pack.json: \$\.stage/],
      ] as const) {
        const r = check(writeAbPack(name, { stage: 0, manifest: over }, root), root);
        expect(r.ok, name).toBe(false);
        expect(r.ab, name).toBeNull();
        expect(r.errors.join("\n"), name).toMatch(msg);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses files outside the layout, a missing ledger, and a non-object run config", () => {
    const root = fresh();
    try {
      const dir = writeAbPack("m2-ab-lay", { stage: 0 }, root);
      writeFileSync(join(dir, "arm.jsonl"), "");
      writeFileSync(join(dir, "on", "notes.txt"), "x");
      rmSync(join(dir, "off", "grades.jsonl"));
      const r = check(dir, root);
      expect(r.errors).toEqual(
        expect.arrayContaining([
          "arm.jsonl: not part of the A/B pack layout (schemas/m2-ab-pack.ts)",
          "on/notes.txt: not part of the A/B pack layout",
          "off/grades.jsonl: missing",
        ]),
      );
      const cfg = writeAbPack(
        "m2-ab-cfg",
        { stage: 0, configs: { on: null, off: abConfig("off") } },
        root,
      );
      expect(check(cfg, root).errors).toContain("on/run-config.json: not a JSON object");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("applies the R packs' per-trial process rules: load gate, cold boot, ops join, causes", () => {
    const root = fresh();
    try {
      const { on, off } = stage1Arms();
      const bad: AbArmFiles = {
        ...off,
        ops: off.ops.map((o, i) =>
          i === 0
            ? { ...o, hostLoad1mStart: 12 }
            : i === 1
              ? { ...o, resetBootClass: "fast" as const }
              : o,
        ),
      };
      bad.ops.pop();
      bad.ops.push({ ...(off.ops[0] as AbArmFiles["ops"][number]), trialKey: "stray" });
      const r = check(writeAbPack("m2-ab-ops", { stage: 1, arms: { on, off: bad } }, root), root);
      expect(r.ok).toBe(false);
      const text = r.errors.join("\n");
      expect(text).toMatch(/off: s1-off-fc-v1-001: started at host 1-minute load 12 >= 10/);
      expect(text).toMatch(/off: s1-off-fc-v1-002: its reset was a fast boot/);
      expect(text).toMatch(/off: s1-off-fc-v1-100 has no trial-ops row/);
      expect(text).toMatch(/off\/ops.jsonl: stray has no arm row/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("kept apart from R1", () => {
  it("the R-pack check refuses an A/B manifest, and A/B rows in an R1 pack", () => {
    const root = fresh();
    try {
      const dir = writeAbPack("m2-ab-as-r", { stage: 0 }, root);
      const asR = checkPack(readPack(dir, () => ({ ok: true, detail: "" })));
      expect(asR.ok).toBe(false);
      expect(asR.errors.join("\n")).toMatch(/pack.json: .*schema/);
      // A/B-marked rows in an otherwise valid R1 pack (#547's rule, unchanged here).
      const pack = packInput(r1Trials());
      const marked = {
        ...pack,
        arm: (pack.arm as BenchmarkArmRow[]).map((r) => ({
          ...r,
          experiment: {
            id: "corrections-ab" as const,
            stage: 1 as const,
            arm: "off" as const,
            seed: "s1-off",
          },
        })),
      };
      expect(checkPack(marked).errors.join("\n")).toMatch(/experiment-only, never evidence/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("the CLI picks the A/B check by manifest, applies provenance to both arms, and --all checks both kinds", () => {
    const root = fresh();
    try {
      writePack("m2-fx-r1", r1Trials(), manifest(), root);
      writeAbPack("m2-ab-s0", { stage: 0 }, root);
      const run = (...args: string[]) =>
        spawnSync(process.execPath, ["--import", "tsx", "scripts/m2-evidence-check.ts", ...args], {
          encoding: "utf8",
        });
      const all = run("--all", "--root", root);
      expect(all.status, all.stderr).toBe(0);
      const packs = JSON.parse(all.stdout).packs as {
        pack: string;
        result: Record<string, unknown>;
      }[];
      const ab = packs.find((p) => p.pack.endsWith("m2-ab-s0"));
      expect(ab?.result).toMatchObject({ kind: "ab", ok: true, ab: { effect: "not-claimed" } });
      const r1 = packs.find((p) => p.pack.endsWith("m2-fx-r1"));
      expect(r1?.result.kind).toBeUndefined();
      // A simulated planner in either arm is refused (provenance), as in an R pack.
      const sim = writeAbPack("m2-ab-sim", { stage: 0 }, root);
      const off = join(sim, "off", "arm.jsonl");
      writeFileSync(
        off,
        readFileSync(off, "utf8").replaceAll("claude-sonnet-5-5", "simulated:dry"),
      );
      const one = run(sim);
      expect(one.status).toBe(1);
      expect(one.stderr).toMatch(/provenance: 30 arm row\(s\) without evidence provenance/);
      const constants = JSON.parse(run("--constants").stdout);
      expect(constants).toMatchObject({
        abStage0Pairs: 30,
        abStage1Pairs: 100,
        abAlpha: 0.05,
        abEvidenceUse: "experiment-only (never R1 evidence)",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);
});
