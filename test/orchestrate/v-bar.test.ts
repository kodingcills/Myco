/**
 * Capability track V: the v-v1 bar as code (`src/orchestrate/v-bar.ts`). Every rule the PR
 * claims is pinned here on synthetic packs: verified per row kind, the fixed sequence
 * (control properties void; then exact one-sided McNemar V vs H with >= 5 discordant), the
 * false-done guardrail, the false-VERIFIED halt, V vs C1 reported but never deciding, cost
 * null never 0, limits read from the pre-registration only, and every structural refusal.
 * No row here is evidence: these are test fixtures (and `simulated: false` only so the
 * analysis will look at them).
 */
import { describe, expect, it } from "vitest";
import {
  analyseV,
  controlBreaches,
  mcnemarOneSidedP,
  type VArm,
  type VBarInput,
  type VBarRow,
  type VPrereg,
  type VTreeControls,
} from "../../src/orchestrate/v-bar.ts";

const MODEL = "claude-sonnet-5-5";
const HASH = "a".repeat(64);
const LIMITS = {
  maxTotalTokens: 400_000,
  maxTokensPerWorker: 100_000,
  maxEstimatedCostMicroUsd: 2_000_000,
  maxWallMs: 1_800_000,
  maxDepth: 2,
  maxConcurrentDesktops: 4,
  maxSpawnsPerPlanner: 8,
  maxTotalSpawns: 12,
};
const PREREG: VPrereg = {
  schema: "myco.capability.prereg/1",
  track: "V",
  version: "v-v1",
  modelId: MODEL,
  taskSet: { version: "orch-v1", tasks: 60 },
  test: { alpha: 0.05, minDiscordant: 5 },
  limits: LIMITS,
};
const TASKS = new Map(
  Array.from({ length: 60 }, (_, i) => {
    const id = `orch-v1-${String(i + 1).padStart(3, "0")}`;
    const parts = i < 20 ? 2 : i < 40 ? 3 : 4;
    return [id, Array.from({ length: parts }, (_, k) => `${id}-p${k + 1}`)] as const;
  }),
);
const TASK_IDS = [...TASKS.keys()];

const CLEAN: VTreeControls = {
  tokensUsed: 100_000,
  costEstimateMicroUsd: 500_000,
  wallMs: 600_000,
  maxDepthObserved: 1,
  maxConcurrentObserved: 2,
  maxSpawnsByOnePlanner: 3,
  totalSpawns: 3,
  unmetered: false,
  spawnsAdmittedAfterUnmetered: 0,
  killed: false,
  spawnsAdmittedAfterKill: 0,
  killLatencyMs: null,
  orphanedDesktops: 0,
  orphanedWorkerTrials: 0,
  openLedgerAttempts: 0,
  ledgerWriteFailed: false,
  haltedOnLedgerFailure: false,
  workerTrials: 3,
  ledgerWorkerAttempts: 3,
};

/** A row: verified (done, every part pass, V parts gate-verified) or not (not-done, fail). */
function row(arm: VArm, taskId: string, ok: boolean, over: Partial<VBarRow> = {}): VBarRow {
  const parts = (TASKS.get(taskId) ?? []).map((partId) => ({
    partId,
    grade: ok ? ("pass" as const) : ("fail" as const),
    ...(arm === "V" ? { gateVerdict: ok ? ("verified" as const) : ("refuted" as const) } : {}),
  }));
  return {
    arm,
    taskId,
    simulated: false,
    modelId: MODEL,
    claim: ok ? "done" : "not-done",
    parts,
    costEstimateMicroUsd: 1000,
    wallMs: 1000,
    ...(arm === "V" ? { controls: CLEAN } : {}),
    ...over,
  };
}

/** A full pack: `v`, `h`, `c1` give the indices (0-based) of tasks each arm verifies. */
function pack(
  v: Iterable<number>,
  h: Iterable<number>,
  c1: Iterable<number> = h,
  edit: (r: VBarRow) => VBarRow = (r) => r,
): VBarInput {
  const sets = { V: new Set(v), H: new Set(h), C1: new Set(c1) };
  const rows: VBarRow[] = [];
  for (const arm of ["V", "H", "C1"] as const)
    TASK_IDS.forEach((id, i) => {
      rows.push(edit(row(arm, id, sets[arm].has(i))));
    });
  return { prereg: PREREG, preregHash: HASH, tasks: TASKS, pack: { preregHash: HASH, rows } };
}
const range = (a: number, b: number) => Array.from({ length: b - a }, (_, i) => a + i);

describe("exact one-sided McNemar (Part 1 §1.5 critical values)", () => {
  it.each([
    [5, 0, 0.0313],
    [6, 0, 0.0156],
    [7, 1, 0.0352],
    [9, 1, 0.0107],
    [10, 2, 0.0193],
    [12, 3, 0.0176],
    [15, 5, 0.0207],
  ])("%i favouring V, %i favouring H: p = %s", (b, c, p) => {
    expect(Math.abs(mcnemarOneSidedP(b, c) - p)).toBeLessThan(0.0001);
  });
  it("4 of 4 cannot reach 0.05, and the next count down fails at each table row", () => {
    expect(mcnemarOneSidedP(4, 0)).toBeGreaterThan(0.05);
    expect(mcnemarOneSidedP(6, 2)).toBeGreaterThan(0.05);
    expect(mcnemarOneSidedP(11, 4)).toBeGreaterThan(0.05);
    expect(mcnemarOneSidedP(0, 0)).toBe(1);
  });
});

describe("decision", () => {
  it("shown: V verifies 30 tasks, H 20 of them plus 0 others (10 discordant, all V)", () => {
    const r = analyseV(pack(range(0, 30), range(0, 20)));
    expect(r.decision).toBe("shown");
    expect(r.primary).toMatchObject({ treatmentOnly: 10, baselineOnly: 0, discordant: 10 });
    expect(r.arms?.V.verified).toBe(30);
    expect(r.arms?.H.verified).toBe(20);
  });

  it("underpowered: 4 discordant tasks all favouring V is not shown, with the count", () => {
    const r = analyseV(pack(range(0, 24), range(0, 20)));
    expect(r.decision).toBe("not-shown");
    expect(r.reasons).toEqual(["UNDERPOWERED_AT_N:60:DISCORDANT:4"]);
  });

  it("not significant: 6 favour V and 4 favour H", () => {
    const r = analyseV(
      pack([...range(0, 20), ...range(30, 36)], [...range(0, 20), ...range(40, 44)]),
    );
    expect(r.primary).toMatchObject({ treatmentOnly: 6, baselineOnly: 4 });
    expect(r.decision).toBe("not-shown");
    expect(r.reasons).toEqual(["NOT_SIGNIFICANT"]);
  });

  it("the direction is one-sided: H better than V is never shown", () => {
    const r = analyseV(pack(range(0, 20), range(0, 30)));
    expect(r.decision).toBe("not-shown");
    expect(r.reasons).toEqual(["NOT_SIGNIFICANT"]);
  });

  it("V vs C1 is reported but never decides: C1 far ahead of V still leaves V vs H shown", () => {
    const r = analyseV(pack(range(0, 30), range(0, 20), range(0, 60)));
    expect(r.decision).toBe("shown");
    expect(r.secondary).toMatchObject({ treatmentOnly: 0, baselineOnly: 30 });
  });
});

describe("verified per row kind", () => {
  it("a V row needs every part gate-verified: grader pass with a refuted part is not verified", () => {
    const input = pack(range(0, 30), range(0, 20), range(0, 20), (r) =>
      r.arm === "V" && r.taskId === TASK_IDS[25]
        ? { ...r, parts: r.parts.map((p, k) => (k === 0 ? { ...p, gateVerdict: "refuted" } : p)) }
        : r,
    );
    const res = analyseV(input);
    expect(res.arms?.V.verified).toBe(29);
    expect(res.primary?.treatmentOnly).toBe(9);
  });

  it("an H or C1 row needs no gate verdict: done and every part pass is verified", () => {
    const res = analyseV(pack([], range(0, 7), range(0, 9)));
    expect(res.arms?.H.verified).toBe(7);
    expect(res.arms?.C1.verified).toBe(9);
  });

  it("every part must pass: one fail or ungradable part makes the task unverified", () => {
    for (const bad of ["fail", "ungradable"] as const) {
      const res = analyseV(
        pack([], range(0, 10), range(0, 10), (r) =>
          r.arm === "H" && r.taskId === TASK_IDS[45]
            ? {
                ...r,
                claim: "done",
                parts: r.parts.map((p, k) => ({ ...p, grade: k === 3 ? bad : "pass" })),
              }
            : r,
        ),
      );
      expect(res.arms?.H.verified, bad).toBe(10);
      expect(res.arms?.H.falseDone, bad).toBe(1);
    }
  });

  it("a done claim is required: every part pass without a done claim is not verified", () => {
    const res = analyseV(
      pack(range(0, 10), [], [], (r) =>
        r.arm === "V" && r.taskId === TASK_IDS[0] ? { ...r, claim: "none" } : r,
      ),
    );
    expect(res.arms?.V.verified).toBe(9);
  });
});

describe("guardrails", () => {
  it("a false VERIFIED in V (gate verified, grader not pass) halts: void", () => {
    const res = analyseV(
      pack(range(0, 30), range(0, 20), range(0, 20), (r) =>
        r.arm === "V" && r.taskId === TASK_IDS[50]
          ? {
              ...r,
              parts: r.parts.map((p, k) =>
                k === 1 ? { ...p, gateVerdict: "verified", grade: "fail" } : p,
              ),
            }
          : r,
      ),
    );
    expect(res.decision).toBe("void");
    expect(res.reasons).toContain("FALSE_VERIFIED_HALT");
    expect(res.falseVerified).toBe(1);
  });

  it("false done in V above either baseline is not shown, even when McNemar would pass", () => {
    const falseDone = (r: VBarRow): VBarRow =>
      r.arm === "V" && r.taskId === TASK_IDS[59] ? { ...r, claim: "done" } : r;
    const res = analyseV(pack(range(0, 30), range(0, 20), range(0, 20), falseDone));
    expect(res.arms?.V.falseDone).toBe(1);
    expect(res.arms?.H.falseDone).toBe(0);
    expect(res.decision).toBe("not-shown");
    expect(res.reasons).toEqual(["GUARDRAIL_FALSE_DONE"]);
  });

  it("false done equal to both baselines does not breach", () => {
    const fd = (r: VBarRow): VBarRow => (r.taskId === TASK_IDS[59] ? { ...r, claim: "done" } : r);
    const res = analyseV(pack(range(0, 30), range(0, 20), range(0, 20), fd));
    expect(res.decision).toBe("shown");
  });

  it("false done is checked against C1 too: equal to H but above C1 is not shown", () => {
    const fd = (r: VBarRow): VBarRow =>
      r.taskId === TASK_IDS[59] && r.arm !== "C1" ? { ...r, claim: "done" } : r;
    const res = analyseV(pack(range(0, 30), range(0, 20), range(0, 20), fd));
    expect(res.arms?.V.falseDone).toBe(1);
    expect(res.arms?.H.falseDone).toBe(1);
    expect(res.arms?.C1.falseDone).toBe(0);
    expect(res.decision).toBe("not-shown");
    expect(res.reasons).toEqual(["GUARDRAIL_FALSE_DONE"]);
  });
});

describe("component 1: control properties void the run", () => {
  const cases: [string, Partial<VTreeControls>][] = [
    ["BUDGET_TOKENS", { tokensUsed: LIMITS.maxTotalTokens + 1 }],
    ["BUDGET_COST", { costEstimateMicroUsd: LIMITS.maxEstimatedCostMicroUsd + 1 }],
    ["BUDGET_WALL", { wallMs: LIMITS.maxWallMs + 1 }],
    ["DEPTH_CAP", { maxDepthObserved: LIMITS.maxDepth + 1 }],
    ["CONCURRENCY_CAP", { maxConcurrentObserved: LIMITS.maxConcurrentDesktops + 1 }],
    ["PLANNER_SPAWN_CAP", { maxSpawnsByOnePlanner: LIMITS.maxSpawnsPerPlanner + 1 }],
    ["TOTAL_SPAWN_CAP", { totalSpawns: LIMITS.maxTotalSpawns + 1 }],
    ["UNMETERED_COST_NOT_NULL", { unmetered: true }],
    ["UNMETERED_NOT_FLAGGED", { costEstimateMicroUsd: null }],
    [
      "UNMETERED_SPAWN_ADMITTED",
      { unmetered: true, costEstimateMicroUsd: null, spawnsAdmittedAfterUnmetered: 1 },
    ],
    ["KILL_SPAWN_ADMITTED", { killed: true, killLatencyMs: 50, spawnsAdmittedAfterKill: 1 }],
    ["ORPHANED_RESOURCE", { orphanedDesktops: 1 }],
    ["ORPHANED_RESOURCE", { orphanedWorkerTrials: 1 }],
    ["ORPHANED_RESOURCE", { openLedgerAttempts: 1 }],
    ["LEDGER_FAILURE_NOT_HALTED", { ledgerWriteFailed: true }],
  ];

  it.each(cases)("%s voids an otherwise shown run (%o)", (code, over) => {
    const res = analyseV(
      pack(range(0, 30), range(0, 20), range(0, 20), (r) =>
        r.arm === "V" && r.taskId === TASK_IDS[7] ? { ...r, controls: { ...CLEAN, ...over } } : r,
      ),
    );
    expect(res.decision).toBe("void");
    expect(res.reasons).toEqual(["CONTROL_PROPERTY_BREACHED"]);
    expect(res.controlBreaches).toEqual([{ taskId: TASK_IDS[7], code }]);
  });

  it("at the limits exactly, and with the properties held, nothing is breached", () => {
    const atLimit: VTreeControls = {
      ...CLEAN,
      tokensUsed: LIMITS.maxTotalTokens,
      costEstimateMicroUsd: LIMITS.maxEstimatedCostMicroUsd,
      wallMs: LIMITS.maxWallMs,
      maxDepthObserved: LIMITS.maxDepth,
      maxConcurrentObserved: LIMITS.maxConcurrentDesktops,
      maxSpawnsByOnePlanner: LIMITS.maxSpawnsPerPlanner,
      totalSpawns: LIMITS.maxTotalSpawns,
    };
    expect(controlBreaches(atLimit, LIMITS)).toEqual([]);
    expect(
      controlBreaches({ ...CLEAN, unmetered: true, costEstimateMicroUsd: null }, LIMITS),
    ).toEqual([]);
    expect(controlBreaches({ ...CLEAN, killed: true, killLatencyMs: 80 }, LIMITS)).toEqual([]);
    expect(
      controlBreaches({ ...CLEAN, ledgerWriteFailed: true, haltedOnLedgerFailure: true }, LIMITS),
    ).toEqual([]);
  });

  it("limits come from the pre-registration: a looser limit in the prereg is what applies, and a row cannot carry one", () => {
    const over = { ...CLEAN, maxDepthObserved: 3 };
    expect(controlBreaches(over, LIMITS)).toEqual(["DEPTH_CAP"]);
    expect(controlBreaches(over, { ...LIMITS, maxDepth: 3 })).toEqual([]);
    const smuggled = pack(range(0, 30), range(0, 20), range(0, 20), (r) =>
      r.arm === "V" && r.taskId === TASK_IDS[3]
        ? ({ ...r, controls: over, limits: { ...LIMITS, maxDepth: 9 } } as VBarRow)
        : r,
    );
    expect(analyseV(smuggled).decision).toBe("void");
  });

  it("void is decided before McNemar: a breach voids even a run that would not be shown", () => {
    const res = analyseV(
      pack([], [], [], (r) =>
        r.arm === "V" && r.taskId === TASK_IDS[0]
          ? { ...r, controls: { ...CLEAN, totalSpawns: 99 } }
          : r,
      ),
    );
    expect(res.decision).toBe("void");
  });

  it("reports the worst kill-switch latency (secondary, no target)", () => {
    const res = analyseV(
      pack(range(0, 30), range(0, 20), range(0, 20), (r) =>
        r.arm === "V" && (r.taskId === TASK_IDS[1] || r.taskId === TASK_IDS[2])
          ? {
              ...r,
              controls: {
                ...CLEAN,
                killed: true,
                killLatencyMs: r.taskId === TASK_IDS[1] ? 120 : 340,
              },
            }
          : r,
      ),
    );
    expect(res.decision).toBe("shown");
    expect(res.killLatencyMsMax).toBe(340);
  });
});

describe("secondaries: cost per verified (R7 rule) and wall time", () => {
  it("cost per verified is the total over ALL trials over verified", () => {
    const res = analyseV(pack(range(0, 30), range(0, 20)));
    expect(res.arms?.V.costPerVerifiedMicroUsd).toBe((60 * 1000) / 30);
    expect(res.arms?.H.wallMsPerVerified).toBe((60 * 1000) / 20);
  });
  it("one unmetered trial makes the arm's cost null, never 0; no verified task makes it null", () => {
    const res = analyseV(
      pack(range(0, 30), [], range(0, 20), (r) =>
        r.arm === "V" && r.taskId === TASK_IDS[40]
          ? {
              ...r,
              costEstimateMicroUsd: null,
              controls: { ...CLEAN, unmetered: true, costEstimateMicroUsd: null },
            }
          : r,
      ),
    );
    expect(res.arms?.V.costPerVerifiedMicroUsd).toBeNull();
    expect(res.arms?.H.costPerVerifiedMicroUsd).toBeNull();
    expect(res.arms?.C1.costPerVerifiedMicroUsd).toBe(3000);
  });
});

describe("refusals (fail closed, never a result)", () => {
  const refusedWith = (input: VBarInput, prefix: string) => {
    const res = analyseV(input);
    expect(res.decision).toBe("refused");
    expect(
      res.reasons.some((r) => r.startsWith(prefix)),
      res.reasons.join(","),
    ).toBe(true);
    expect(res.arms).toBeUndefined();
  };
  const at = (arm: VArm, i: number, f: (r: VBarRow) => VBarRow) => (r: VBarRow) =>
    r.arm === arm && r.taskId === TASK_IDS[i] ? f(r) : r;

  it("a pack whose pre-registration hash differs", () => {
    const input = pack(range(0, 30), range(0, 20));
    refusedWith(
      { ...input, pack: { ...input.pack, preregHash: "b".repeat(64) } },
      "PREREG_HASH_MISMATCH",
    );
  });
  it("a simulated row", () => {
    refusedWith(
      pack(
        range(0, 30),
        range(0, 20),
        range(0, 20),
        at("H", 3, (r) => ({ ...r, simulated: true })),
      ),
      "SIMULATED_ROW",
    );
  });
  it("a planner that is not the pre-registered model id (scripted planner)", () => {
    refusedWith(
      pack(
        range(0, 30),
        range(0, 20),
        range(0, 20),
        at("V", 3, (r) => ({ ...r, modelId: "scripted" })),
      ),
      "MODEL_MISMATCH",
    );
  });
  it("a repeated cell, and a missing cell", () => {
    const input = pack(range(0, 30), range(0, 20));
    const rows = [...input.pack.rows];
    rows[1] = rows[0] as VBarRow;
    const res = analyseV({ ...input, pack: { ...input.pack, rows } });
    expect(res.decision).toBe("refused");
    expect(res.reasons).toContain(`DUPLICATE_CELL:V|${TASK_IDS[0]}`);
    expect(res.reasons).toContain(`MISSING_CELL:V|${TASK_IDS[1]}`);
  });
  it("an unknown task and an unknown arm", () => {
    refusedWith(
      pack(
        range(0, 30),
        range(0, 20),
        range(0, 20),
        at("H", 0, (r) => ({ ...r, taskId: "orch-v1-999" })),
      ),
      "UNKNOWN_TASK",
    );
    refusedWith(
      pack(
        range(0, 30),
        range(0, 20),
        range(0, 20),
        at("H", 0, (r) => ({ ...r, arm: "myco-gate" as VArm })),
      ),
      "UNKNOWN_ARM",
    );
  });
  it("a part list that is not the task's (missing, reordered or extra part)", () => {
    refusedWith(
      pack(
        range(0, 30),
        range(0, 20),
        range(0, 20),
        at("H", 30, (r) => ({ ...r, parts: r.parts.slice(1) })),
      ),
      "PARTS_MISMATCH",
    );
    refusedWith(
      pack(
        range(0, 30),
        range(0, 20),
        range(0, 20),
        at("H", 30, (r) => ({ ...r, parts: [...r.parts].reverse() })),
      ),
      "PARTS_MISMATCH",
    );
  });
  it("an unknown grade or claim", () => {
    refusedWith(
      pack(
        range(0, 30),
        range(0, 20),
        range(0, 20),
        at("C1", 5, (r) => ({
          ...r,
          parts: r.parts.map((p) => ({ ...p, grade: "maybe" as "pass" })),
        })),
      ),
      "UNKNOWN_GRADE",
    );
    refusedWith(
      pack(
        range(0, 30),
        range(0, 20),
        range(0, 20),
        at("C1", 5, (r) => ({ ...r, claim: "DONE" as "done" })),
      ),
      "UNKNOWN_CLAIM",
    );
  });
  it("a V part without a gate verdict (gated rows must carry it)", () => {
    refusedWith(
      pack(
        range(0, 30),
        range(0, 20),
        range(0, 20),
        at("V", 5, (r) => ({
          ...r,
          parts: r.parts.map(({ partId, grade }) => ({ partId, grade })),
        })),
      ),
      "MISSING_GATE_VERDICT",
    );
  });
  it("a V row without its control record, or with a malformed one", () => {
    refusedWith(
      pack(
        range(0, 30),
        range(0, 20),
        range(0, 20),
        at("V", 5, ({ controls: _c, ...r }) => r),
      ),
      "CONTROLS_INVALID",
    );
    refusedWith(
      pack(
        range(0, 30),
        range(0, 20),
        range(0, 20),
        at("V", 5, (r) => ({ ...r, controls: { ...CLEAN, tokensUsed: -1 } })),
      ),
      "CONTROLS_INVALID",
    );
  });
  it("a V tree whose worker-trial count disagrees with the attempt ledger", () => {
    refusedWith(
      pack(
        range(0, 30),
        range(0, 20),
        range(0, 20),
        at("V", 5, (r) => ({ ...r, controls: { ...CLEAN, ledgerWorkerAttempts: 2 } })),
      ),
      "LEDGER_WORKER_COUNT_MISMATCH",
    );
  });
  it("a negative cost or wall time", () => {
    refusedWith(
      pack(
        range(0, 30),
        range(0, 20),
        range(0, 20),
        at("H", 1, (r) => ({ ...r, costEstimateMicroUsd: -5 })),
      ),
      "BAD_COST",
    );
    refusedWith(
      pack(
        range(0, 30),
        range(0, 20),
        range(0, 20),
        at("H", 1, (r) => ({ ...r, wallMs: Number.NaN })),
      ),
      "BAD_WALL",
    );
  });
  it("a pre-registration that is not v-v1, or whose test or limits differ from the bar", () => {
    const input = pack(range(0, 30), range(0, 20));
    refusedWith({ ...input, prereg: { ...PREREG, version: "v-v2" } }, "PREREG_NOT_V_V1");
    refusedWith(
      { ...input, prereg: { ...PREREG, test: { alpha: 0.1, minDiscordant: 5 } } },
      "PREREG_TEST_MISMATCH",
    );
    refusedWith(
      { ...input, prereg: { ...PREREG, test: { alpha: 0.05, minDiscordant: 3 } } },
      "PREREG_TEST_MISMATCH",
    );
    refusedWith(
      { ...input, prereg: { ...PREREG, taskSet: { version: "orch-v1", tasks: 40 } } },
      "PREREG_TASK_SET_MISMATCH",
    );
    refusedWith(
      { ...input, prereg: { ...PREREG, limits: { ...LIMITS, maxDepth: 0 } } },
      "PREREG_LIMIT_INVALID:maxDepth",
    );
  });
});
