/**
 * The corrections ON/OFF A/B RUNNER (track E follow-up). Runbook: docs/benchmark/pilot-runbook.md,
 * "Corrections ON/OFF A/B". Pre-registration: docs/benchmark/corrections-ab-prereg.md. The
 * analysis is #547's `scripts/m2-corrections-ab.ts`; `analyze` checks a pack and calls it.
 *
 *   npx tsx scripts/m2-corrections-ab-run.ts prereg-hash
 *   npx tsx scripts/m2-corrections-ab-run.ts plan     --stage 0|1
 *   npx tsx scripts/m2-corrections-ab-run.ts dry-run  --out DIR       SIMULATED, $0, the whole path
 *   npx tsx scripts/m2-corrections-ab-run.ts simulate --stage 0|1 --out DIR [--chunks N]
 *   npx tsx scripts/m2-corrections-ab-run.ts status   --out DIR
 *   npx tsx scripts/m2-corrections-ab-run.ts export   --out DIR --stage 0|1 --to NEW_PACK_DIR
 *   npx tsx scripts/m2-corrections-ab-run.ts check-pack PACK_DIR
 *   npx tsx scripts/m2-corrections-ab-run.ts analyze  --pack PACK_DIR [--stage0-pack PACK_DIR]
 *   npx tsx scripts/m2-corrections-ab-run.ts ack-incident --out DIR --stage 0|1 --incident ID \
 *       --incident-sha256 SHA --operator NAME --statement TEXT
 *   scripts/vm-session.sh -- node --import tsx scripts/m2-corrections-ab-run.ts launch \
 *       --stage 0|1 --out DIR --launch-real-trials --plan-sha256 SHA [--token-file PATH]
 *
 * `simulate` runs one stage on the fake transport (virtual clock, chunk budget honoured, so
 * pause/resume can be practised). `launch` prints the plan, checks every real-run precondition
 * (`liveAbRefusals`, plus the VM session lock and concurrency 1) and refuses with the reasons;
 * when all hold it runs the stage on the live VM driver (`src/pilot/live-launch.ts`).
 * Exit: 0 ok / complete, 1 failed, 2 usage, 3 refused, 4 paused / incomplete / halted,
 * 5 fail-closed stop (auth, billing/credit/quota, API key), 6 two identical failures in a row.
 * `analyze` exits with #547's code once it ran, 3 when the pack, the pre-registered command or
 * #547 itself is refused.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  AB_DRY_RUN_PLANNER,
  AbRefusal,
  type AbStage,
  abFakeDriver,
  abPlanSha256,
  abSchedule,
  ackIncident,
  analyzeAbPack,
  checkAbPack,
  checkedArmConfigs,
  exportAbPack,
  incidentStatus,
  launchPlanDiff,
  loadPrereg,
  PREREG_JSON,
  PREREG_MD,
  runAbStage,
  sha256File,
  stageProgress,
  stageRoot,
  stageTasks,
} from "../src/pilot/ab.ts";
import { abDryRun } from "../src/pilot/ab-dry-run.ts";
import { configSha256 } from "../src/pilot/config.ts";
import { fakeDriver, virtualClock } from "../src/pilot/dry-run.ts";
import { preflightRefusal, subscriptionPreflight } from "../src/pilot/launch.ts";
import { realLiveDeps } from "../src/pilot/live-deps.ts";
import { launchAbLive } from "../src/pilot/live-launch.ts";
import { publishedTasks } from "../src/pilot/reviewed.ts";

class UsageError extends Error {}

const ROOT = resolve(import.meta.dirname, "..");
const [command, ...rest] = process.argv.slice(2);
const flag = (name: string) => {
  const i = rest.indexOf(name);
  return i >= 0 ? rest[i + 1] : undefined;
};
const need = (name: string) => {
  const v = flag(name);
  if (v === undefined) throw new UsageError(`${command} needs ${name}`);
  return v;
};
const stageFlag = (): AbStage => {
  const s = need("--stage");
  if (s !== "0" && s !== "1") throw new UsageError(`--stage must be 0 or 1, got ${s}`);
  return Number(s) as AbStage;
};
const out = (s: string) => process.stdout.write(s);
const err = (s: string) => process.stderr.write(s);
const json = (v: unknown) => out(`${JSON.stringify(v, null, 2)}\n`);
const SOURCES = ["src/gate/families.ts", "src/gate/calc-document.ts"].map((p) => join(ROOT, p));
const exitFor = (status: string) => (status === "complete" ? 0 : 4);

function printPlan(stage: AbStage) {
  const published = publishedTasks(ROOT);
  const loaded = loadPrereg(ROOT);
  const { on, off } = checkedArmConfigs(loaded, stage, published, ROOT);
  const s = loaded.prereg.stages[`${stage}`];
  const tasks = stageTasks(loaded, stage, published);
  const first = published.find((t) => t.taskId === tasks[0]);
  const sha = abPlanSha256(loaded, stage, published);
  json({
    experiment: `corrections ON/OFF A/B, Stage ${stage} (${s.role})`,
    evidenceUse: "experiment-only (never R1 evidence), both arms",
    planSha256: sha,
    prereg: { [PREREG_MD]: loaded.markdownSha256, [PREREG_JSON]: loaded.jsonSha256 },
    pairs: s.pairs,
    seed: s.seed,
    armConfigSha256: { on: configSha256(on), off: configSha256(off) },
    armsIdenticalApartFromCorrections: true,
    launchPlanDiff: first === undefined ? null : launchPlanDiff(on, off, first, ROOT),
    pacing: loaded.prereg.pacing,
    schedule: abSchedule(s.seed, tasks, loaded.prereg.pacing.chunkPairs),
    // The pre-registered command; `analyze` refuses unless it equals what it runs.
    analysis: loaded.prereg.analysis.command,
  });
  return { sha, loaded, published };
}

try {
  switch (command) {
    case "prereg-hash": {
      // Both hashes always print, so a disagreement shows which file changed (never just a throw).
      const md = sha256File(join(ROOT, PREREG_MD));
      const js = sha256File(join(ROOT, PREREG_JSON));
      let pinned: unknown = null;
      try {
        pinned = (
          JSON.parse(readFileSync(join(ROOT, PREREG_JSON), "utf8")) as { markdownSha256?: unknown }
        ).markdownSha256;
      } catch {
        // An unparseable JSON pins nothing: reported as a disagreement below.
      }
      let problem: string | null = null;
      try {
        loadPrereg(ROOT);
      } catch (error) {
        problem = (error as Error).message;
      }
      json({
        [PREREG_MD]: md,
        [PREREG_JSON]: js,
        jsonPinsMarkdown: pinned === md,
        ...(problem === null ? {} : { jsonPinnedMarkdownSha256: pinned, problem }),
      });
      process.exitCode = problem === null ? 0 : 1;
      break;
    }
    case "plan":
      printPlan(stageFlag());
      break;
    case "dry-run": {
      const dir = need("--out");
      const r = await abDryRun(ROOT, dir, { log: (l) => err(`${l}\n`) });
      out(
        `SIMULATED corrections A/B dry run (never evidence): ${r.ok ? "every step ok" : "a step FAILED"}\n`,
      );
      json(r);
      process.exitCode = r.ok ? 0 : 1;
      break;
    }
    case "simulate": {
      const stage = stageFlag();
      const dir = need("--out");
      const chunks = flag("--chunks");
      const clock = virtualClock(Date.now());
      const r = await runAbStage({
        repoRoot: ROOT,
        published: publishedTasks(ROOT),
        loaded: loadPrereg(ROOT),
        stage,
        outRoot: dir,
        driver: abFakeDriver(fakeDriver()),
        plannerModelId: AB_DRY_RUN_PLANNER,
        oracleSources: SOURCES,
        ...(chunks === undefined ? {} : { maxChunks: Number(chunks) }),
        sleep: clock.sleep,
        now: clock.now,
        log: (l) => err(`${l}\n`),
      });
      out(`SIMULATED corrections A/B, Stage ${stage} (never evidence): ${JSON.stringify(r)}\n`);
      process.exitCode = exitFor(r.status);
      break;
    }
    case "status": {
      const dir = need("--out");
      json({
        note: "progress counts only; no p-value before a stage is complete (stopping rule)",
        stage0: stageProgress(dir, 0),
        stage1: stageProgress(dir, 1),
        incidents: [0, 1].flatMap((s) =>
          incidentStatus(stageRoot(dir, s as AbStage)).map((i) => ({ stage: s, ...i })),
        ),
      });
      break;
    }
    case "export": {
      const m = exportAbPack(need("--out"), stageFlag(), need("--to"), ROOT);
      json(m);
      break;
    }
    case "check-pack": {
      const pack = rest[0];
      if (pack === undefined) throw new UsageError("check-pack needs PACK_DIR");
      const r = checkAbPack(pack, ROOT);
      json(r);
      process.exitCode = r.ok ? 0 : 3;
      break;
    }
    case "analyze": {
      const r = analyzeAbPack(need("--pack"), ROOT, flag("--stage0-pack"));
      out(`${r.command}\n`);
      json(r);
      process.exitCode = r.status === "refused" ? 3 : (r.exitCode ?? 1);
      break;
    }
    case "ack-incident": {
      const path = ackIncident(stageRoot(need("--out"), stageFlag()), need("--incident"), {
        operator: need("--operator"),
        statement: need("--statement"),
        incidentSha256: need("--incident-sha256"),
      });
      out(`acknowledged: ${path}\n`);
      break;
    }
    case "launch": {
      const pre = subscriptionPreflight(Object.keys(process.env));
      if (!pre.ok) {
        err(`${preflightRefusal(pre)}\n`);
        process.exitCode = 3;
        break;
      }
      const stage = stageFlag();
      const dir = need("--out");
      const { loaded, published } = printPlan(stage);
      // The same preconditions runAbStage applies to any live run (one source of truth), plus
      // the VM lock and concurrency 1; runAbStage and runPilot re-check them before any trial.
      const r = await launchAbLive(
        {
          loaded,
          stage,
          published,
          outRoot: dir,
          repoRoot: ROOT,
          oracleSources: SOURCES,
          launchRealTrials: rest.includes("--launch-real-trials"),
          planSha256: flag("--plan-sha256"),
        },
        realLiveDeps(ROOT, flag("--token-file"), (l) => err(`${l}\n`)),
      );
      if (r.refusals.length > 0)
        err(
          `refusing to launch the corrections A/B:\n${r.refusals.map((x) => `  - ${x}\n`).join("")}`,
        );
      else out(`LIVE corrections A/B, Stage ${stage}: ${JSON.stringify(r.result)}\n`);
      process.exitCode = r.exitCode;
      break;
    }
    default:
      throw new UsageError(`unknown command ${String(command)}`);
  }
} catch (error) {
  if (error instanceof UsageError) {
    err(`m2-corrections-ab-run: ${error.message}\n`);
    process.exitCode = 2;
  } else if (error instanceof AbRefusal) {
    err(`m2-corrections-ab-run: ${error.message}\n`);
    process.exitCode = 3;
  } else {
    err(`m2-corrections-ab-run: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
