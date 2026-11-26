/**
 * The corrections A/B's SIMULATED dry run: the whole path on simulated rows, $0, no model, no
 * `claude` process, no VM. Never evidence (planner `simulated:corrections-ab-dry-run`, the
 * `SIMULATED` and `EXPERIMENT` markers, the experiment label on every row).
 *
 * The steps, each checked, in order:
 *  1. Stage 0 on both arms (30 pairs, seeded chunks, the real gate on a sealed vault, the
 *     independent grader per trial, #518's ledger and anchor), exported and pack-checked, then
 *     analysed by #547's CLI (the pre-registered command, filled in for the pack).
 *  2. Stage 1 the same (100 pairs), analysed with the Stage-0 pack excluded.
 *  3. Both packs, both arms: refused as R1 evidence by the shared check and the pack CLI's
 *     provenance check.
 *  4. The pre-registration hash: a copy of the Stage-1 pack whose recorded hash is not the
 *     committed file's is refused.
 *  5. The gate-miss halt, in its own directory: a SIMULATED grader failure on the first trial
 *     the gate verifies halts the run with an incident record; resume is refused; a wrong ack
 *     is refused; the operator's ack lets it resume to completion; Stage 1 is still refused
 *     there (Stage 0 had a gate miss).
 */
import { cpSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gradeRow } from "../benchmark/grade/row.ts";
import { packProvenanceErrors } from "../m2/provenance.ts";
import {
  AB_DRY_RUN_PLANNER,
  type AbAnalysis,
  AbRefusal,
  type AbStage,
  abFakeDriver,
  ackIncident,
  analyzeAbPack,
  bundleGrader,
  checkAbPack,
  evidenceRefusals,
  exportAbPack,
  type GradeFn,
  incidentStatus,
  loadPrereg,
  runAbStage,
  stageRoot,
} from "./ab.ts";
import { fakeDriver, virtualClock } from "./dry-run.ts";
import { publishedTasks } from "./reviewed.ts";
import type { PilotDriver } from "./runner.ts";

export interface DryRunStep {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

export interface AbDryRunOptions {
  readonly log?: (line: string) => void;
  /** The simulated driver (default: #524's fake behind `abFakeDriver`). */
  readonly driver?: PilotDriver;
}

/** #547 refused the pack, and only because its rows are simulated (no evidence provenance). */
const provenanceOnlyRefusal = (a: AbAnalysis) => {
  const errs = (a.result as { errors?: readonly string[] } | null)?.errors ?? [];
  return (
    a.status === "analysed" &&
    a.exitCode !== 0 &&
    errs.length > 0 &&
    errs.every((e) => /without evidence provenance: dry-run rows are never evidence/.test(e))
  );
};

const analysisOk = (a: AbAnalysis, effects: readonly string[]) => {
  if (a.status !== "analysed" || a.exitCode !== 0) return false;
  const effect = (a.result as { effect?: string } | null)?.effect;
  return effect !== undefined && effects.includes(effect);
};

/** Run every step; `ok` only when each behaved as the pre-registration requires. */
export async function abDryRun(
  repoRoot: string,
  outRoot: string,
  opts: AbDryRunOptions = {},
): Promise<{ readonly ok: boolean; readonly steps: readonly DryRunStep[] }> {
  const log = opts.log ?? (() => {});
  const published = publishedTasks(repoRoot);
  const loaded = loadPrereg(repoRoot);
  const oracleSources = ["src/gate/families.ts", "src/gate/calc-document.ts"].map((p) =>
    join(repoRoot, p),
  );
  const driver = opts.driver ?? abFakeDriver(fakeDriver());
  const clock = virtualClock(Date.parse("2026-11-26T00:00:00Z"));
  const steps: DryRunStep[] = [];
  const step = (name: string, ok: boolean, detail: string) => {
    steps.push({ name, ok, detail });
    log(`${ok ? "ok  " : "FAIL"} ${name}: ${detail}`);
  };
  const run = (root: string, stage: AbStage, grader?: GradeFn) =>
    runAbStage({
      repoRoot,
      published,
      loaded,
      stage,
      outRoot: root,
      driver,
      plannerModelId: AB_DRY_RUN_PLANNER,
      oracleSources,
      maxChunks: Number.POSITIVE_INFINITY,
      sleep: clock.sleep,
      now: clock.now,
      load1m: () => 0.5,
      ...(grader === undefined ? {} : { grader }),
    });

  // 1-2. Both stages, exported, checked, analysed.
  const runs = join(outRoot, "runs");
  const packs: Partial<Record<AbStage, string>> = {};
  for (const stage of [0, 1] as const) {
    const r = await run(runs, stage);
    step(`stage ${stage} run`, r.status === "complete", JSON.stringify(r));
    if (r.status !== "complete") return { ok: false, steps };
    const pack = join(outRoot, "packs", `stage${stage}`);
    exportAbPack(runs, stage, pack, repoRoot);
    packs[stage] = pack;
    const c = checkAbPack(pack, repoRoot);
    step(
      `stage ${stage} pack check (prereg hash, labels, identical arms)`,
      c.ok,
      c.errors.join("; ") || "ok",
    );
    const a = analyzeAbPack(pack, repoRoot, stage === 1 ? packs[0] : undefined);
    // Stage 0: #547 analyses the simulated pack (no effect claim). Stage 1 is confirmatory, so
    // #547 refuses simulated rows outright: the dry run passes only when that provenance
    // refusal is #547's ONLY objection (every other check on the pack held).
    step(
      `stage ${stage} analysis (#547)`,
      stage === 0 ? analysisOk(a, ["not-claimed"]) : provenanceOnlyRefusal(a),
      a.status === "analysed"
        ? `exit ${a.exitCode}, effect ${(a.result as { effect?: string } | null)?.effect}, discordant ${JSON.stringify((a.result as { discordant?: unknown } | null)?.discordant)}`
        : `${a.status}: ${a.errors.join("; ")}`,
    );
  }

  // 3. Never R1 evidence, both arms.
  for (const stage of [0, 1] as const)
    for (const arm of ["on", "off"] as const) {
      const pack = packs[stage] as string;
      const ev = evidenceRefusals(pack, arm);
      const rows = readFileSync(join(pack, arm, "arm.jsonl"), "utf8")
        .split("\n")
        .filter((l) => l !== "")
        .map((l) => JSON.parse(l) as unknown);
      const prov = packProvenanceErrors(pack, rows);
      step(
        `stage ${stage} ${arm} arm refused as R1 evidence`,
        ev.some((e) => /experiment-only/.test(e)) &&
          prov.some((e) => /EXPERIMENT marker/.test(e)) &&
          prov.some((e) => /labelled experiment-only/.test(e)),
        `${ev.length} shared-check error(s), ${prov.length} provenance error(s)`,
      );
    }

  // 4. A pack whose recorded pre-registration hash is not the committed file's.
  const tampered = join(outRoot, "drill-prereg-pack");
  cpSync(packs[1] as string, tampered, { recursive: true });
  const mPath = join(tampered, "ab-pack.json");
  const m = JSON.parse(readFileSync(mPath, "utf8")) as { prereg: { markdownSha256: string } };
  m.prereg.markdownSha256 = "0".repeat(64);
  writeFileSync(mPath, `${JSON.stringify(m, null, 2)}\n`);
  const t = analyzeAbPack(tampered, repoRoot, packs[0]);
  step(
    "prereg hash mismatch refused",
    t.status === "refused" && t.errors.some((e) => /pre-registration sha256/.test(e)),
    t.errors[0] ?? t.status,
  );

  // 5. The gate-miss halt.
  const drill = join(outRoot, "drill-gate-miss");
  const real = bundleGrader(join(repoRoot, "benchmark", "false-completion", "fc-v1"));
  let injected: string | null = null;
  const missGrader: GradeFn = (task, persisted, trialKey) => {
    const g = real(task, persisted, trialKey);
    if (injected === null && g.status === "pass") {
      injected = trialKey;
      return gradeRow(trialKey, task.taskId, {
        graderVersion: g.graderVersion,
        status: "fail",
        reasons: ["SIMULATED gate-miss drill: injected grader failure"],
        fixtureSha256: g.fixtureSha256,
        persistedSha256: g.persistedSha256,
        target: g.target,
        targetSatisfied: false,
        mismatches: [],
        mismatchCount: 1,
      });
    }
    return g;
  };
  const halted = await run(drill, 0, missGrader);
  const incidents = incidentStatus(stageRoot(drill, 0));
  step(
    "gate miss halts the run with an incident record",
    halted.status === "halted" && incidents.length === 1 && !incidents[0]?.acknowledged,
    `${halted.status}; injected at ${injected}; ${incidents.length} incident(s)`,
  );
  let refused = "";
  try {
    await run(drill, 0);
  } catch (error) {
    if (error instanceof AbRefusal) refused = error.message;
    else throw error;
  }
  step(
    "resume refused until acknowledged",
    /unacknowledged integrity incident/.test(refused),
    refused.slice(0, 120),
  );
  const inc = incidents[0];
  let wrongAck = "";
  if (inc !== undefined) {
    try {
      ackIncident(stageRoot(drill, 0), inc.id, {
        operator: "dry-run operator",
        statement: "SIMULATED drill: acknowledging without reading",
        incidentSha256: "f".repeat(64),
      });
    } catch (error) {
      wrongAck = (error as Error).message;
    }
    ackIncident(stageRoot(drill, 0), inc.id, {
      operator: "dry-run operator",
      statement: "SIMULATED drill: record reviewed; injected grader failure, no gate defect",
      incidentSha256: inc.sha256,
    });
  }
  step(
    "an ack naming the wrong sha256 is refused",
    /read the record first/.test(wrongAck),
    wrongAck.slice(0, 120),
  );
  const resumed = await run(drill, 0);
  step(
    "after the operator's ack the run resumes",
    resumed.status === "complete",
    JSON.stringify(resumed),
  );
  let s1 = "";
  try {
    await run(drill, 1);
  } catch (error) {
    if (error instanceof AbRefusal) s1 = error.message;
    else throw error;
  }
  step("Stage 1 refused after a Stage 0 gate miss", /zero gate misses/.test(s1), s1.slice(0, 120));

  const ok = steps.every((s) => s.ok) && existsSync(join(outRoot, "packs", "stage1", "SIMULATED"));
  return { ok, steps };
}
