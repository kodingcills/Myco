/**
 * The corrections A/B evidence pack (src/m2/ab-pack.ts; schemas/m2-ab-pack.ts): a separate pack
 * kind for the scorecard's experiment row, never R1 evidence. Expected statistics are the
 * independent reference values pinned in test/m2/corrections-ab.test.ts.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { m2AbPackManifestSchema } from "../../schemas/m2-ab-pack.ts";
import { validateSchema } from "../../schemas/validate.ts";
import type { BenchmarkArmRow } from "../../src/benchmark/check.ts";
import {
  checkAbPack,
  EVIDENCE_TREE,
  PREREG_FILES,
  preregLocation,
  preregSha256,
  readAbPack,
} from "../../src/m2/ab-pack.ts";
import { checkPack, readPack } from "../../src/m2/evidence.ts";
import { PREREG_JSON, PREREG_MD } from "../../src/pilot/ab-prereg.ts";
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
      writeFileSync(join(root, PREREG_MD), "edited after the run\n");
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
      // Since #554 S1 it is refused by the pin, before the location check could open anything.
      expect(readAbPack(outside, root).readErrors).toContain(
        `preregistration.file ../x.md: not the pre-registration (it must be exactly ${PREREG_MD} or ${PREREG_JSON})`,
      );
      expect(preregLocation(outside, root, "../x.md").error).toBe("outside the repository");
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
        { stage: 0, manifest: { preregistration: { file: PREREG_MD, sha256: "a".repeat(64) } } },
        root,
      );
      mkdirSync(join(root, "docs", "benchmark"), { recursive: true });
      writeFileSync(join(root, PREREG_MD), "x");
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

describe("#554 round 1 fixes", () => {
  const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
  /** Re-point a written pack's pre-registration at `file` with the sha256 of `text`. */
  const setPrereg = (dir: string, file: string, text: string) => {
    const m = JSON.parse(readFileSync(join(dir, "pack.json"), "utf8"));
    m.preregistration = { file, sha256: sha256(text) };
    writeFileSync(join(dir, "pack.json"), `${JSON.stringify(m, null, 2)}\n`);
  };

  it("V11: a Stage-1 pack whose trial reuses a Stage-0 seed is refused (the exclusion, end to end)", () => {
    const root = fresh();
    try {
      const { on, off } = stage1Arms();
      const row = on.arm[0] as BenchmarkArmRow;
      on.arm[0] = {
        ...row,
        experiment: { ...(row.experiment as object), seed: "s0-on" },
      } as BenchmarkArmRow;
      const r = check(writeAbPack("m2-ab-reuse", { stage: 1, arms: { on, off } }, root), root);
      expect(r.ok).toBe(false);
      expect(r.errors.join("\n")).toMatch(/reuse Stage-0 trials/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("V3: two trial-ops rows for one trial are refused", () => {
    const root = fresh();
    try {
      const { on, off } = stage1Arms();
      off.ops.push({ ...(off.ops[0] as AbArmFiles["ops"][number]) });
      const r = check(writeAbPack("m2-ab-dupops", { stage: 1, arms: { on, off } }, root), root);
      expect(r.errors).toContain("off/ops.jsonl: duplicate row for s1-off-fc-v1-001");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("V5: a file other than arm.jsonl under stage0/<side>/ is refused", () => {
    const root = fresh();
    try {
      const dir = writeAbPack("m2-ab-s0leaf", { stage: 1 }, root);
      writeFileSync(join(dir, "stage0", "on", "grades.jsonl"), "");
      expect(check(dir, root).errors).toContain(
        "stage0/on/grades.jsonl: not part of the A/B pack layout",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("V2: a row the grader passes but the gate refuted is non-verified, so it needs a cause", () => {
    const root = fresh();
    try {
      const { on, off } = stage1Arms();
      const k = on.arm.findIndex((r) => r.gate?.called === true && r.accepted === false);
      const row = on.arm[k] as BenchmarkArmRow;
      on.arm[k] = { ...row, cause: null };
      on.grades[k] = {
        ...on.grades[k]!,
        status: "pass",
        reasons: [],
        mismatchCount: 0,
        targetSatisfied: true,
      };
      const r = check(writeAbPack("m2-ab-cause", { stage: 1, arms: { on, off } }, root), root);
      expect(r.errors).toContain(`on: ${row.trialKey}: non-verified row has no cause`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // Since #554 S1 the bound file is pinned to PREREG_MD or PREREG_JSON (the pin tests are in
  // "the pre-registration path is pinned" below). The location rules still apply to the pinned
  // path itself, so each case here makes `<repo>/<PREREG_MD>` the offending object.
  const pinned = (root: string) => join(root, PREREG_MD);
  const replacePinned = (root: string) => {
    rmSync(pinned(root), { recursive: true, force: true });
    mkdirSync(dirname(pinned(root)), { recursive: true });
    return pinned(root);
  };
  const LOCATED = `preregistration.file ${PREREG_MD}`;

  describe("D2: the pre-registration must be a repository file the pack cannot have written", () => {
    it("the pack's own README (written after the run, hash matching) is refused", () => {
      const root = fresh();
      try {
        const dir = writeAbPack("m2-ab-self", { stage: 1 }, root);
        const text = "# the design, written after the run\n";
        writeFileSync(join(dir, "README.md"), text);
        symlinkSync(join(dir, "README.md"), replacePinned(root));
        setPrereg(dir, PREREG_MD, text);
        const r = check(dir, root);
        expect(r.ok).toBe(false);
        expect(r.errors).toContain(
          `${LOCATED}: inside the pack (a pack cannot certify its own pre-registration)`,
        );
        // preregLocation itself, on the README's own spelling (no pin at this layer).
        expect(preregLocation(dir, root, "m2-ab-self/README.md").error).toBe(
          "inside the pack (a pack cannot certify its own pre-registration)",
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("a file anywhere under the evidence tree (another pack's README) is refused", () => {
      const root = fresh();
      try {
        const dir = writeAbPack("m2-ab-tree", { stage: 1 }, root);
        const other = join(root, "docs", "research", "experiments", "m2-other");
        mkdirSync(other, { recursive: true });
        const text = "# a design inside the evidence tree\n";
        writeFileSync(join(other, "README.md"), text);
        symlinkSync(join(other, "README.md"), replacePinned(root));
        setPrereg(dir, PREREG_MD, text);
        expect(check(dir, root).errors.join("\n")).toContain(
          `${LOCATED}: inside the evidence tree`,
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("an in-repo link to a file outside the repository is refused (realpath, not the declared path)", () => {
      const root = fresh();
      const outside = fresh();
      try {
        const dir = writeAbPack("m2-ab-link", { stage: 1 }, root);
        const text = "# a design outside the repository\n";
        writeFileSync(join(outside, "design.md"), text);
        symlinkSync(join(outside, "design.md"), replacePinned(root));
        setPrereg(dir, PREREG_MD, text);
        expect(check(dir, root).errors).toContain(
          `${LOCATED}: outside the repository (through a link)`,
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
        rmSync(outside, { recursive: true, force: true });
      }
    });

    it("a link into a sibling directory whose name starts with the repository's is outside it", () => {
      const parent = fresh();
      const root = join(parent, "repo");
      const sibling = join(parent, "repo-evil");
      try {
        mkdirSync(root);
        mkdirSync(sibling);
        const dir = writeAbPack("m2-ab-sib", { stage: 1 }, root);
        const text = "# a design next door\n";
        writeFileSync(join(sibling, "design.md"), text);
        symlinkSync(join(sibling, "design.md"), replacePinned(root));
        setPrereg(dir, PREREG_MD, text);
        expect(check(dir, root).errors).toContain(
          `${LOCATED}: outside the repository (through a link)`,
        );
      } finally {
        rmSync(parent, { recursive: true, force: true });
      }
    });

    it("a declared file that is not in the repository is reported, not read", () => {
      const root = fresh();
      try {
        const dir = writeAbPack("m2-ab-missing", { stage: 1 }, root);
        rmSync(pinned(root));
        setPrereg(dir, PREREG_JSON, "x");
        expect(check(dir, root).errors).toContain(
          `preregistration.file ${PREREG_JSON}: not committed`,
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("a directory is not a pre-registration; the committed pre-registration outside the pack is bound", () => {
      const root = fresh();
      try {
        const dir = writeAbPack("m2-ab-dir", { stage: 1 }, root);
        mkdirSync(replacePinned(root));
        setPrereg(dir, PREREG_MD, "");
        expect(check(dir, root).errors).toContain(`${LOCATED}: not a file`);
        const text = "# corrections A/B pre-registration\n";
        rmSync(pinned(root), { recursive: true });
        writeFileSync(pinned(root), text);
        setPrereg(dir, PREREG_MD, text);
        const r = check(dir, root);
        expect(r.errors).toEqual([]);
        expect(r.ok).toBe(true);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  describe("#554 round 3: location by identity, never by spelling", () => {
    it("D1: the upper-case spelling of the pack's own README is refused on every file system", () => {
      const root = fresh();
      try {
        const dir = writeAbPack("m2-ab-case", { stage: 1 }, join(root, EVIDENCE_TREE), root);
        const text = "# the design, written after the run\n";
        writeFileSync(join(dir, "README.md"), text);
        // Case-insensitive (macOS APFS): the spelling names the pack's own README; elsewhere none.
        const folds = existsSync(join(root, "Docs"));
        for (const spelling of [
          "Docs/research/experiments/m2-ab-case/README.md",
          "docs/research/experiments/M2-AB-CASE/README.md",
          "docs/research/experiments/m2-ab-case/readme.md",
        ]) {
          setPrereg(dir, spelling, text);
          const r = check(dir, root);
          expect(r.ok, spelling).toBe(false);
          // Refused by the pin before it is opened; the location layer alone refuses it too.
          expect(r.errors.join("\n"), spelling).toContain(
            `preregistration.file ${spelling}: not the pre-registration`,
          );
          expect(preregLocation(dir, root, spelling).error, spelling).toBe(
            folds
              ? "inside the pack (a pack cannot certify its own pre-registration)"
              : "not committed",
          );
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("the evidence tree reached through a link is still the evidence tree", () => {
      const root = fresh();
      try {
        const store = join(root, "store", "experiments");
        mkdirSync(join(store, "m2-other"), { recursive: true });
        mkdirSync(join(root, "docs", "research"), { recursive: true });
        symlinkSync(store, join(root, EVIDENCE_TREE));
        const dir = writeAbPack("m2-ab-tl", { stage: 1 }, root);
        const text = "# a design inside the evidence tree\n";
        writeFileSync(join(store, "m2-other", "README.md"), text);
        symlinkSync(join(store, "m2-other", "README.md"), replacePinned(root));
        setPrereg(dir, PREREG_MD, text);
        const r = check(dir, root);
        expect(r.ok).toBe(false);
        expect(r.errors.join("\n")).toContain(`${LOCATED}: inside the evidence tree`);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("a hard-linked file is refused: its other names (the pack's README here) are invisible", () => {
      const root = fresh();
      try {
        const dir = writeAbPack("m2-ab-hl", { stage: 1 }, root);
        const text = "# the design, written after the run\n";
        writeFileSync(join(dir, "README.md"), text);
        linkSync(join(dir, "README.md"), replacePinned(root));
        setPrereg(dir, PREREG_MD, text);
        const r = check(dir, root);
        expect(r.ok).toBe(false);
        expect(r.errors).toContain(
          `${LOCATED}: a file with 2 hard links (its other names are invisible to realpath, so its location cannot be checked)`,
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("the bound file is the one checked: the hash is read from the checked real path", () => {
      const root = fresh();
      try {
        const dir = writeAbPack("m2-ab-real", { stage: 1 }, root);
        const text = "# corrections A/B pre-registration\n";
        // The pinned path reached through a directory link (docs/benchmark -> real/benchmark).
        rmSync(dirname(pinned(root)), { recursive: true });
        mkdirSync(join(root, "real", "benchmark"), { recursive: true });
        writeFileSync(join(root, "real", "benchmark", basename(PREREG_MD)), text);
        symlinkSync(join(root, "real", "benchmark"), dirname(pinned(root)));
        setPrereg(dir, PREREG_MD, text);
        const input = readAbPack(dir, root);
        expect(input.readErrors).toEqual([]);
        expect(input.preregCommittedSha256).toBe(sha256(text));
        expect(checkAbPack(input).ok).toBe(true);
        // A file replaced between the check and the read is not bound (one descriptor, same inode).
        const where = preregLocation(dir, root, PREREG_MD);
        expect(where.error).toBeNull();
        if (where.error !== null) return;
        expect(preregSha256(where)).toBe(sha256(text));
        writeFileSync(join(root, "real", "benchmark", "swap.md"), "# a different design\n");
        renameSync(join(root, "real", "benchmark", "swap.md"), where.real);
        expect(preregSha256(where)).toBeNull();
        // And a pre-registration left unread (null hash) never passes on its own.
        const unread = checkAbPack({ ...input, preregCommittedSha256: null });
        expect(unread.ok).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("M4: an accepted row the grader cannot grade is non-verified, so it needs a cause", () => {
      const root = fresh();
      try {
        const { on, off } = stage1Arms();
        const k = on.arm.findIndex((r) => r.accepted === true);
        const row = on.arm[k] as BenchmarkArmRow;
        on.arm[k] = { ...row, cause: null };
        on.grades[k] = { ...on.grades[k]!, status: "ungradable" };
        const r = check(writeAbPack("m2-ab-ungr", { stage: 1, arms: { on, off } }, root), root);
        expect(r.ok).toBe(false);
        expect(r.errors).toContain(`on: ${row.trialKey}: non-verified row has no cause`);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });
});

describe("#554 S1: the pre-registration path is pinned to track E's file", () => {
  const sha256 = (b: string | Buffer) => createHash("sha256").update(b).digest("hex");
  const TEXT = "# corrections A/B pre-registration (pinned)\n";
  const JSON_TEXT = '{"schema":"myco.pilot.corrections-ab-prereg/1"}\n';
  /** A fixture repository with both pinned files committed, and one Stage-1 pack in it. */
  const repo = (name: string) => {
    const root = fresh();
    const dir = writeAbPack(name, { stage: 1, prereg: TEXT }, root);
    writeFileSync(join(root, PREREG_JSON), JSON_TEXT);
    return { root, dir };
  };
  const bind = (dir: string, file: string, digest: string) => {
    const m = JSON.parse(readFileSync(join(dir, "pack.json"), "utf8"));
    m.preregistration = { file, sha256: digest };
    writeFileSync(join(dir, "pack.json"), `${JSON.stringify(m, null, 2)}\n`);
  };
  const pinError = (file: string) =>
    `preregistration.file ${file}: not the pre-registration (it must be exactly ${PREREG_MD} or ${PREREG_JSON})`;

  it("the pinned paths are the constants of src/pilot/ab-prereg.ts, and both bind with a matching hash", () => {
    expect(PREREG_FILES).toEqual([PREREG_MD, PREREG_JSON]);
    const { root, dir } = repo("m2-ab-pin-ok");
    try {
      for (const [file, text] of [
        [PREREG_MD, TEXT],
        [PREREG_JSON, JSON_TEXT],
      ] as const) {
        bind(dir, file, sha256(text));
        const input = readAbPack(dir, root);
        expect(input.readErrors, file).toEqual([]);
        expect(input.preregCommittedSha256, file).toBe(sha256(text));
        const r = checkAbPack(input);
        expect(r.errors, file).toEqual([]);
        expect(r.ok, file).toBe(true);
        // The hash is still enforced on the pinned path.
        bind(dir, file, sha256(`${text}edited`));
        expect(check(dir, root).ok, `${file} with another hash`).toBe(false);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("every other path is refused, hash matching or not, and is never opened", () => {
    const { root, dir } = repo("m2-ab-pin-other");
    try {
      // A copy of the pre-registration elsewhere, a link to it, the pack's README, another file.
      mkdirSync(join(root, "docs", "other"), { recursive: true });
      writeFileSync(join(root, "docs", "other", basename(PREREG_MD)), TEXT);
      symlinkSync(join(root, PREREG_MD), join(root, "docs", "benchmark", "prereg-link.md"));
      symlinkSync(join(root, "docs", "benchmark"), join(root, "bench"));
      writeFileSync(join(dir, "README.md"), TEXT);
      writeFileSync(join(root, "docs", "design.md"), TEXT);
      const upper = PREREG_MD.replace("corrections-ab-prereg", "Corrections-AB-Prereg");
      for (const file of [
        "docs/other/corrections-ab-prereg.md",
        upper,
        PREREG_MD.toUpperCase(),
        `./${PREREG_MD}`,
        PREREG_MD.replace("docs/", "docs//"),
        "docs/benchmark/prereg-link.md",
        `bench/${basename(PREREG_MD)}`,
        "m2-ab-pin-other/README.md",
        "docs/design.md",
        "docs/benchmark/corrections-ab-prereg",
      ]) {
        bind(dir, file, sha256(TEXT));
        const input = readAbPack(dir, root);
        expect(input.readErrors, file).toContain(pinError(file));
        // Never opened: no hash is computed for an unpinned path.
        expect(input.preregCommittedSha256, file).toBeNull();
        const r = checkAbPack(input);
        expect(r.ok, file).toBe(false);
        // The schema refuses it independently of the reader.
        expect(
          validateSchema(
            JSON.parse(readFileSync(join(dir, "pack.json"), "utf8")),
            m2AbPackManifestSchema,
          )
            .map((i) => i.path)
            .join(),
          file,
        ).toContain("preregistration");
      }
      // The pinned spellings pass the schema.
      for (const file of [PREREG_MD, PREREG_JSON]) {
        bind(dir, file, sha256(TEXT));
        expect(
          validateSchema(
            JSON.parse(readFileSync(join(dir, "pack.json"), "utf8")),
            m2AbPackManifestSchema,
          ),
          file,
        ).toEqual([]);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("P3: the CLI's R path applies the experiment-label refusal (an R pack with one labelled row, no marker)", () => {
    const root = fresh();
    try {
      const trials = r1Trials();
      const first = trials[0];
      if (first === undefined) throw new Error("no trial");
      trials[0] = {
        ...first,
        arm: {
          ...(first.arm as BenchmarkArmRow),
          experiment: { id: "corrections-ab", stage: 1, arm: "off", seed: "s1-off" },
        } as BenchmarkArmRow,
      };
      const dir = writePack("m2-fx-labelled", trials, manifest(), root);
      expect(existsSync(join(dir, "EXPERIMENT"))).toBe(false);
      expect(existsSync(join(dir, "SIMULATED"))).toBe(false);
      const r = spawnSync(
        process.execPath,
        ["--import", "tsx", "scripts/m2-evidence-check.ts", "--all", "--root", root],
        { encoding: "utf8" },
      );
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(
        /ERROR \S*m2-fx-labelled: provenance: 1 arm row\(s\) labelled experiment-only: experiment rows are never R1 evidence/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);
});
