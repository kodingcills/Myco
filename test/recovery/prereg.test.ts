/**
 * Track K: the pre-registration (`docs/product/capability-prereg/k-v1/prereg.json`, spec §3)
 * and its check (`src/recovery/prereg.ts`).
 *
 *  P1 the committed file passes the check, is a draft, and its stored hash is the SHA-256 of
 *     its canonical JSON without the hash member.
 *  P2 canonical JSON: key order and whitespace do not change it; values it cannot write
 *     canonically are refused.
 *  P3 any edit is caught: a field without a new hash, a pinned file, the spec's K section.
 *  P4 the open lead questions (§6: step budget 80, ms-long-v1 size 40) and the unbuilt
 *     manifest are listed as pending and the file is not frozen; a draft never claims them.
 *  P5 the frozen rules: nothing pending, status frozen, manifest SHA-256 set and matching.
 *  P6 the file agrees with the code it names: the bar's values, the arms, the fault kinds,
 *     the grader and renderer versions, and the pilot's model id.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { MULTI_STEP_GRADER_VERSION } from "../../src/benchmark/grade/multi-step.ts";
import { PILOT_MODEL } from "../../src/pilot/config.ts";
import { FAULT_KINDS } from "../../src/recovery/batch.ts";
import {
  canonicalJson,
  checkKPrereg,
  K_PREREG_PATH,
  K_SPEC_PATH,
  type KPrereg,
  type PreregFiles,
  preregHash,
  specSection,
} from "../../src/recovery/prereg.ts";
import { MULTI_STEP_TEXT_VERSION } from "../../src/tasks/multi-step-text.ts";

const ROOT = resolve(import.meta.dirname, "..", "..");
const RAW = readFileSync(resolve(ROOT, K_PREREG_PATH), "utf8");
const PREREG = JSON.parse(RAW) as KPrereg;

const disk: PreregFiles = {
  sha256: (p) =>
    existsSync(resolve(ROOT, p))
      ? createHash("sha256")
          .update(readFileSync(resolve(ROOT, p)))
          .digest("hex")
      : null,
  text: (p) => (existsSync(resolve(ROOT, p)) ? readFileSync(resolve(ROOT, p), "utf8") : null),
};

/** A copy of the pre-registration with `patch` applied and the hash recomputed. */
function rehashed(patch: (p: Record<string, unknown>) => void): Record<string, unknown> {
  const p = structuredClone(PREREG) as unknown as Record<string, unknown>;
  patch(p);
  p.preregistrationHash = preregHash(p);
  return p;
}

const problemsOf = (p: unknown, files: PreregFiles = disk) => checkKPrereg(p, files).problems;

describe("P1: the committed pre-registration", () => {
  it("passes the check and is a draft, not frozen", () => {
    const check = checkKPrereg(PREREG, disk);
    expect(check.problems).toEqual([]);
    expect(check.frozen).toBe(false);
    expect(PREREG.status).toBe("draft");
  });

  it("its stored hash is the SHA-256 of its canonical JSON without the hash member", () => {
    const { preregistrationHash, ...body } = PREREG as unknown as Record<string, unknown>;
    const expected = createHash("sha256").update(canonicalJson(body), "utf8").digest("hex");
    expect(preregistrationHash).toBe(expected);
    expect(preregHash(PREREG as unknown as Record<string, unknown>)).toBe(expected);
    expect(checkKPrereg(PREREG, disk).hash).toBe(expected);
  });

  it("holds every field §3.1 names", () => {
    expect(PREREG.spec.sectionSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(PREREG.taskSet.version).toBe("ms-long-v1");
    expect(Object.keys(PREREG.seeds).sort()).toEqual(["assignment", "bootstrap", "taskBuild"]);
    expect(PREREG.stepBudget).toBe(80);
    expect(PREREG.modelId).toMatch(/^claude-/);
    expect(PREREG.analysis.script).toEqual({
      path: "scripts/k-recovery-analysis.ts",
      sha256: disk.sha256("scripts/k-recovery-analysis.ts"),
    });
  });
});

describe("P2: canonical JSON", () => {
  it("is independent of key order and whitespace", () => {
    const a = { b: [1, { y: "x", a: null }], a: true, c: -0.5 };
    const b = JSON.parse(` { "c" : -0.5, "a": true,\n "b": [1, {"a": null, "y": "x"}] } `);
    expect(canonicalJson(a)).toBe('{"a":true,"b":[1,{"a":null,"y":"x"}],"c":-0.5}');
    expect(canonicalJson(b)).toBe(canonicalJson(a));
  });

  it("the file's hash does not depend on its formatting", () => {
    const compact = JSON.parse(JSON.stringify(PREREG));
    expect(preregHash(compact)).toBe(PREREG.preregistrationHash);
  });

  it("refuses what it cannot write canonically", () => {
    for (const bad of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      undefined,
      () => 1,
      new Date(0),
      new Map(),
    ])
      expect(() => canonicalJson({ x: bad })).toThrow(/canonical JSON/);
  });
});

describe("P3: any edit is caught", () => {
  it("a field changed without a new hash", () => {
    const p = { ...structuredClone(PREREG), stepBudget: 30 };
    expect(problemsOf(p).join("|")).toMatch(/preregistrationHash is not the hash/);
  });

  it("a pinned file whose bytes changed", () => {
    for (const path of [
      "scripts/k-recovery-analysis.ts",
      "src/recovery/analysis.ts",
      "src/recovery/batch.ts",
      "src/recovery/prereg.ts",
      "src/tasks/multi-step-text.ts",
      "src/benchmark/grade/multi-step.ts",
    ]) {
      const files: PreregFiles = {
        ...disk,
        sha256: (p) => (p === path ? "0".repeat(64) : disk.sha256(p)),
      };
      expect(problemsOf(PREREG, files), path).toContain(
        `${path}: sha256 does not match the committed file`,
      );
    }
  });

  it("the spec's K section changed (the bar as written)", () => {
    const files: PreregFiles = {
      ...disk,
      text: (p) =>
        p === K_SPEC_PATH
          ? (disk.text(p) as string).replace(
              "K better than no-recovery, p ≤ 0.05",
              "K better than no-recovery, p ≤ 0.10",
            )
          : disk.text(p),
    };
    expect(problemsOf(PREREG, files).join("|")).toMatch(/sectionSha256/);
  });

  it("the K section ends at the next heading (an edit to L does not touch K)", () => {
    const spec = disk.text(K_SPEC_PATH) as string;
    const k = specSection(spec) as string;
    expect(k.startsWith("### K. Recovery\n")).toBe(true);
    expect(k).toContain(
      "**Pre-registered bar.** Exact one-sided McNemar, K better than no-recovery",
    );
    expect(k).not.toContain("### L.");
    const files: PreregFiles = {
      ...disk,
      text: (p) =>
        p === K_SPEC_PATH
          ? spec.replace("### L. Safe parallelism", "### L. Safe parallelism!")
          : disk.text(p),
    };
    expect(problemsOf(PREREG, files)).toEqual([]);
  });
});

describe("P4: the open lead questions are pending, not ratified", () => {
  it("lists the step budget, the task set size and the manifest as pending", () => {
    expect(PREREG.pending.map((x) => x.field)).toEqual([
      "stepBudget",
      "taskSet.size",
      "taskSet.manifestSha256",
    ]);
    for (const x of PREREG.pending.slice(0, 2)) {
      expect(x.reason).toMatch(/lead ruling pending \(capability-spec §6\)/);
      expect(x.reason).toMatch(/not ratified/);
    }
    expect(PREREG.taskSet.manifestSha256).toBeNull();
  });

  it("a draft that lists nothing pending, or drops the manifest item, is refused", () => {
    const empty = rehashed((p) => {
      p.pending = [];
    });
    expect(problemsOf(empty).join("|")).toMatch(/draft lists/);
    const dropManifest = rehashed((p) => {
      p.pending = (p.pending as { field: string }[]).filter(
        (x) => x.field !== "taskSet.manifestSha256",
      );
    });
    expect(problemsOf(dropManifest).join("|")).toMatch(
      /null manifest SHA-256 must be listed as pending/,
    );
  });
});

describe("P5: the frozen rules", () => {
  const MANIFEST = "a".repeat(64);
  const withManifest: PreregFiles = {
    ...disk,
    sha256: (p) => (p === PREREG.taskSet.manifestPath ? MANIFEST : disk.sha256(p)),
  };
  const frozen = rehashed((p) => {
    p.status = "frozen";
    p.pending = [];
    (p.taskSet as Record<string, unknown>).manifestSha256 = MANIFEST;
  });

  it("frozen: nothing pending, status frozen, the manifest SHA-256 set and matching", () => {
    const check = checkKPrereg(frozen, withManifest);
    expect(check.problems).toEqual([]);
    expect(check.frozen).toBe(true);
  });

  it("a manifest SHA-256 that is not the committed manifest's is refused", () => {
    expect(problemsOf(frozen, disk).join("|")).toMatch(/not the SHA-256 of the committed manifest/);
  });

  it("frozen with something pending, or with a null manifest, is refused", () => {
    const pending = rehashed((p) => {
      p.status = "frozen";
      (p.taskSet as Record<string, unknown>).manifestSha256 = MANIFEST;
    });
    expect(problemsOf(pending, withManifest).join("|")).toMatch(/has nothing pending/);
    const nullManifest = rehashed((p) => {
      p.status = "frozen";
      p.pending = [];
    });
    expect(problemsOf(nullManifest).join("|")).toMatch(/needs the task set's manifest SHA-256/);
  });
});

describe("P6: the file agrees with the code it names", () => {
  it("the grader and renderer versions, fault kinds and model id", () => {
    expect(PREREG.grader.version).toBe(MULTI_STEP_GRADER_VERSION);
    expect(PREREG.instruction.version).toBe(MULTI_STEP_TEXT_VERSION);
    expect(PREREG.taskSet.faultKinds).toEqual([...FAULT_KINDS]);
    // The same model as the trial run's pilot, so both are priced at the same frozen rates.
    expect(PREREG.modelId).toBe(PILOT_MODEL);
  });

  /** A patch that sets the value at a dotted path (arrays and objects alike). */
  const set =
    (path: string, value: unknown) =>
    (p: Record<string, unknown>): void => {
      const keys = path.split(".");
      const last = keys.pop() as string;
      let at = p;
      for (const k of keys) at = at[k] as Record<string, unknown>;
      at[last] = value;
    };
  const cases: [string, (p: Record<string, unknown>) => void, RegExp][] = [
    ["alpha 0.10", set("bar.alpha", 0.1), /alpha/],
    ["two-sided", set("bar.sided", "two-sided"), /one-sided/],
    ["4 discordant", set("bar.minDiscordant", 4), /discordant/],
    [
      "a metric from the gate",
      set("bar.primaryMetric", "gate verified rate"),
      /independent grader/,
    ],
    ["no guardrails", set("bar.guardrails", []), /guardrails/],
    ["K without corrections", set("arms.K.corrections", "off"), /arms\.K/],
    ["no-recovery with a retry", set("arms.no-recovery.retryBudget", 1), /arms\.no-recovery/],
    ["a third arm", set("arms.extra", {}), /exactly two arms/],
    ["contrast", set("contrast", "corrections"), /contrast/],
    ["another task set", set("taskSet.version", "fc-v1"), /taskSet\.version/],
    ["faulted not half", set("taskSet.faultedTasks", 10), /half/],
    ["fault kinds", set("taskSet.faultKinds", ["kill-app"]), /faultKinds/],
    ["equal seeds", set("seeds.bootstrap", PREREG.seeds.assignment), /seeds must differ/],
    ["short seed", set("seeds.taskBuild", "x"), /seeds/],
    ["step budget 0", set("stepBudget", 0), /stepBudget/],
    ["k 2", set("k", 2), /k must be 1/],
    ["a scripted model", set("modelId", "simulated:scripted"), /modelId/],
    ["another script", set("analysis.script.path", "scripts/other.ts"), /analysis\.script/],
    ["a module dropped", set("analysis.modules", []), /analysis\.modules/],
    ["another command", set("analysis.command", "npx tsx other.ts"), /analysis\.command/],
    ["wrong schema", set("schema", "x"), /schema/],
    ["unknown status", set("status", "ratified"), /status/],
  ];
  for (const [name, patch, re] of cases)
    it(`refuses: ${name}`, () => {
      expect(problemsOf(rehashed(patch)).join("|")).toMatch(re);
    });

  it("refuses a non-object", () => {
    expect(problemsOf(null)).toEqual(["the pre-registration is not an object"]);
    expect(problemsOf([])).toEqual(["the pre-registration is not an object"]);
  });
});
