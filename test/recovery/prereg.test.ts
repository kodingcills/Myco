/**
 * Track K: the pre-registration (`docs/product/capability-prereg/k-v1/prereg.json`, spec §3)
 * and its check (`src/recovery/prereg.ts`).
 *
 *  P1 the committed file passes the check, is a draft, and its stored hash is the SHA-256 of
 *     its canonical JSON without the hash member.
 *  P2 canonical JSON: key order and whitespace do not change it; values it cannot write
 *     canonically are refused.
 *  P3 any edit is caught: a field without a new hash, a pinned file, the spec's K section.
 *  P4 the lead's 06:21Z rulings are recorded (step budget 80 for both arms; ms-long-v1 n = 90,
 *     confirmatory, with the n = 40 exploratory fallback); what stays pending is the unbuilt
 *     manifest and the pre-freeze size check, and the file is not frozen.
 *  P5 the frozen rules: nothing pending, no lead ruling pending, status frozen, manifest
 *     SHA-256 set and matching.
 *  P6 the file agrees with the code it names: the bar's values, the arms, the fault kinds,
 *     the grader and renderer versions, and the pilot's model id.
 *  P7 `leadRulingsPending`: a lead-pending item, a "lead ruling pending" reason, an unruled
 *     §6 field or a malformed list each count as an open ruling.
 *  P8 designation and size: confirmatory at 90, exploratory at 40, nothing else.
 *  P9 the VM-hours estimate: required, and its arithmetic and step budget are checked.
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
  leadRulingsPending,
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
      // #647 round 1, N5: the transitive dependencies of the analysis and the grader.
      "src/recovery/trial.ts",
      "src/benchmark/grade/grade.ts",
      "src/benchmark/grade/sheet.ts",
      "src/benchmark/grade/zip.ts",
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

describe("P4: the lead's 06:21Z rulings are recorded; the manifest stays pending", () => {
  it("records both rulings at 06:21Z, each naming the fields it settles", () => {
    expect(PREREG.leadRulings.map((r) => r.at)).toEqual(["2026-11-27T06:21Z", "2026-11-27T06:21Z"]);
    const [budget, size] = PREREG.leadRulings;
    expect(budget?.fields).toEqual(["stepBudget"]);
    expect(budget?.ruling).toMatch(/step budget 80, the same for both arms/);
    expect(size?.fields).toContain("taskSet.size");
    expect(size?.ruling).toMatch(/n = 90 under the J rule/);
    expect(size?.ruling).toMatch(/fall back to n = 40 pre-registered as EXPLORATORY/);
    for (const r of PREREG.leadRulings) expect(r.source).toMatch(/PR #647, comment 7211428927/);
    expect(PREREG.leadRulingPending).toEqual([]);
    expect(leadRulingsPending(PREREG)).toEqual([]);
  });

  it("applies them: budget 80, n = 90 with 45 faulted, confirmatory, the spec section amended", () => {
    expect(PREREG.stepBudget).toBe(80);
    expect(PREREG.taskSet).toMatchObject({ size: 90, faultedTasks: 45 });
    expect(PREREG.designation).toBe("confirmatory");
    expect(PREREG.spec.amendedBy).toMatch(/^leadRulings: .*step budget is 80.*size is 90/);
  });

  it("pending is the unbuilt manifest and the pre-freeze size check, and nothing lead-pending", () => {
    expect(PREREG.pending.map((x) => x.field)).toEqual([
      "taskSet.manifestSha256",
      "sizeRule.applied",
    ]);
    for (const x of PREREG.pending) expect(x.reason).not.toMatch(/lead ruling pending/i);
    expect(PREREG.taskSet.manifestSha256).toBeNull();
    expect(PREREG.status).toBe("draft");
  });

  it("the VM-hours estimate: 180 trials at 600 s is 30 VM-hours; 102 at the timeout; 13.3 at n = 40", () => {
    expect(PREREG.vmHoursEstimate).toMatchObject({
      stepBudget: 80,
      tasks: 90,
      trials: 180,
      secondsPerTrial: 600,
      vmHours: 30,
      atTrialTimeout: { secondsPerTrial: 2040, vmHours: 102 },
      atFallback: { tasks: 40, trials: 80, vmHours: 13.3 },
    });
    expect(PREREG.vmHoursEstimate.basis).toMatch(/docs\/baseline\/screenshot-agent\.md/);
    expect(PREREG.vmHoursEstimate.basis).toMatch(/cold reset 140 s/);
    expect(PREREG.vmHoursEstimate.basis).toMatch(/80 x 4\.5 = 360 s/);
    expect(PREREG.sizeRule.rule).toMatch(/never reports the bar as shown/);
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

  it("frozen with a lead ruling pending is refused, even with pending empty", () => {
    const lead = rehashed((p) => {
      p.status = "frozen";
      p.pending = [];
      p.leadRulingPending = [{ field: "stepBudget", reason: "re-opened" }];
      (p.taskSet as Record<string, unknown>).manifestSha256 = MANIFEST;
    });
    const check = checkKPrereg(lead, withManifest);
    expect(check.problems).toEqual(["a frozen pre-registration has no lead ruling pending"]);
    expect(check.frozen).toBe(false);
  });
});

describe("P7: leadRulingsPending", () => {
  const base = structuredClone(PREREG) as unknown as Record<string, unknown>;
  const withPatch = (patch: (p: Record<string, unknown>) => void) => {
    const p = structuredClone(base);
    patch(p);
    return leadRulingsPending(p);
  };
  it("is empty for the committed file", () => {
    expect(leadRulingsPending(base)).toEqual([]);
  });
  it("counts each kind of open ruling", () => {
    expect(
      withPatch((p) => {
        p.leadRulingPending = [{ field: "k", reason: "x" }];
      }),
    ).toEqual(["k"]);
    expect(
      withPatch((p) => {
        (p.pending as unknown[]).push({ field: "seeds", reason: "LEAD RULING PENDING (§6)" });
      }),
    ).toEqual(["seeds"]);
    expect(
      withPatch((p) => {
        (p.pending as unknown[]).push({ field: "seeds" });
      }),
    ).toEqual(["seeds"]);
    expect(
      withPatch((p) => {
        p.leadRulings = [];
      }),
    ).toEqual(["stepBudget", "taskSet.size"]);
    expect(
      withPatch((p) => {
        (p.leadRulings as { fields: string[] }[])[0]!.fields = ["other"];
      }),
    ).toEqual(["stepBudget"]);
    expect(
      withPatch((p) => {
        p.leadRulings = "all";
      }),
    ).toEqual(["stepBudget", "taskSet.size"]);
  });
  it("fails closed on malformed lists and a non-object", () => {
    expect(
      withPatch((p) => {
        p.leadRulingPending = undefined;
      }),
    ).toEqual(["leadRulingPending (not a list)"]);
    expect(
      withPatch((p) => {
        p.pending = "none";
      }),
    ).toEqual(["pending (not a list)"]);
    expect(
      withPatch((p) => {
        p.leadRulingPending = [7];
      }),
    ).toEqual(["(malformed item)"]);
    expect(leadRulingsPending(null)).toEqual(["(not a pre-registration)"]);
  });
});

describe("P8: designation and size", () => {
  const sized = (designation: string, size: number) =>
    rehashed((p) => {
      p.designation = designation;
      const ts = p.taskSet as Record<string, unknown>;
      ts.size = size;
      ts.faultedTasks = size / 2;
      const vm = p.vmHoursEstimate as Record<string, unknown>;
      vm.tasks = size;
      vm.trials = size * 2;
      vm.vmHours = (size * 2 * 600) / 3600;
      (vm.atTrialTimeout as Record<string, unknown>).vmHours = (size * 2 * 2040) / 3600;
    });
  it("exploratory at 40 passes; confirmatory at 90 is the committed file", () => {
    expect(problemsOf(sized("exploratory", 40))).toEqual([]);
    expect(problemsOf(sized("confirmatory", 90))).toEqual([]);
  });
  for (const [d, n] of [
    ["exploratory", 90],
    ["confirmatory", 40],
    ["confirmatory", 60],
    ["pilot", 90],
  ] as const)
    it(`refuses ${d} at ${n}`, () => {
      expect(problemsOf(sized(d, n)).join("|")).toMatch(
        /designation and size must be confirmatory at 90/,
      );
    });
});

describe("P9: the VM-hours estimate", () => {
  const cases: [string, (p: Record<string, unknown>) => void, RegExp][] = [
    ["missing", (p) => delete p.vmHoursEstimate, /vmHoursEstimate is required/],
    ["no basis", set("vmHoursEstimate.basis", ""), /basis must state/],
    ["another budget", set("vmHoursEstimate.stepBudget", 30), /pre-registered step budget/],
    ["trials for one arm", set("vmHoursEstimate.trials", 90), /trials must be/],
    ["tasks not the size", set("vmHoursEstimate.tasks", 40), /trials must be/],
    ["zero seconds", set("vmHoursEstimate.secondsPerTrial", 0), /positive number/],
    ["wrong VM-hours", set("vmHoursEstimate.vmHours", 20), /vmHours must be trials x/],
    ["VM-hours off by 0.1", set("vmHoursEstimate.vmHours", 30.1), /vmHours must be trials x/],
    ["fallback off by 0.1", set("vmHoursEstimate.atFallback.vmHours", 13.4), /atFallback/],
    ["wrong timeout hours", set("vmHoursEstimate.atTrialTimeout.vmHours", 50), /atTrialTimeout/],
    ["no timeout", set("vmHoursEstimate.atTrialTimeout", null), /atTrialTimeout/],
    ["fallback at 30", set("vmHoursEstimate.atFallback.tasks", 30), /atFallback/],
    ["fallback trials", set("vmHoursEstimate.atFallback.trials", 40), /atFallback/],
    ["fallback hours", set("vmHoursEstimate.atFallback.vmHours", 30), /atFallback/],
  ];
  for (const [name, patch, re] of cases)
    it(`refuses: ${name}`, () => {
      expect(problemsOf(rehashed(patch)).join("|")).toMatch(re);
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

  const cases: [string, (p: Record<string, unknown>) => void, RegExp][] = [
    ["no amendment note", set("spec.amendedBy", "as written"), /spec\.amendedBy/],
    ["grader modules dropped", set("grader.modules", []), /grader\.modules must include/],
    [
      "trial.ts unpinned",
      (p) => {
        const a = p.analysis as { modules: { path: string }[] };
        a.modules = a.modules.filter((m) => m.path !== "src/recovery/trial.ts");
      },
      /analysis\.modules must include/,
    ],
    ["a ruling without minutes", set("leadRulings.0.at", "2026-11-27"), /a lead ruling needs at/],
    ["a ruling settling nothing", set("leadRulings.1.fields", []), /a lead ruling needs at/],
    ["a ruling without a source", set("leadRulings.0.source", ""), /a lead ruling needs at/],
    ["rulings not a list", set("leadRulings", {}), /leadRulings must be a list/],
    ["lead-pending not a list", set("leadRulingPending", "none"), /leadRulingPending must be/],
    ["no size rule", set("sizeRule", null), /sizeRule needs/],
    ["an empty applied", set("sizeRule.applied", ""), /sizeRule needs/],
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
