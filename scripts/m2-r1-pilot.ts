/**
 * The 30-trial R1 pilot runner (track E). Runbook: docs/benchmark/pilot-runbook.md.
 *
 *   npx tsx scripts/m2-r1-pilot.ts config                  print the reviewed config JSON
 *   npx tsx scripts/m2-r1-pilot.ts plan    [pacing]        print the launch plan and its sha256
 *   npx tsx scripts/m2-r1-pilot.ts dry-run --out DIR       SIMULATED: fake transport, $0, never evidence
 *   npx tsx scripts/m2-r1-pilot.ts status  --out DIR       ledger summary and the cost ESTIMATE
 *   npx tsx scripts/m2-r1-pilot.ts export  --out DIR --to NEW_DIR
 *   scripts/vm-session.sh -- node --import tsx scripts/m2-r1-pilot.ts launch --out DIR \
 *       --launch-real-trials --plan-sha256 SHA [--token-file PATH] [pacing]
 *
 * pacing: --concurrency N --delay-s S (defaults in benchmark/pilot/r1/config.json).
 *
 * `launch` starts REAL trials only when every precondition holds (`src/pilot/live-launch.ts`):
 * the subscription preflight (names only), the explicit flag, the sha256 of the plan `plan`
 * printed, the VM session lock held by `scripts/vm-session.sh`, concurrency 1. Otherwise it
 * prints the plan and refuses with every reason. A live trial resets the VM, seeds the task
 * document in the guest, runs headless Claude Code on the subscription, and captures the
 * persisted document host-side over the SSH tunnel (`src/pilot/vm-capture.ts`). Re-run the
 * same command to resume; `<out>/live-status.json` is the watchdog heartbeat.
 * Exit: 0 ok / complete, 1 run failed, 2 usage, 3 refused, 4 paused or incomplete,
 * 5 fail-closed stop (auth, billing/credit/quota, API key), 6 two identical failures in a row.
 */
import { join, resolve } from "node:path";
import { configSha256, type PacingConfig } from "../src/pilot/config.ts";
import { COST_BASIS } from "../src/pilot/cost.ts";
import { fakeDriver, PILOT_DRY_RUN_PLANNER, virtualClock } from "../src/pilot/dry-run.ts";
import { preflightRefusal, subscriptionPreflight, trialLaunchPlan } from "../src/pilot/launch.ts";
import { launchR1Live } from "../src/pilot/live-launch.ts";
import { realLiveDeps } from "../src/pilot/live-deps.ts";
import { loadLedger, PROGRESS_FILE, pilotStatus } from "../src/pilot/ledger.ts";
import { loadReviewedConfig, publishedTasks } from "../src/pilot/reviewed.ts";
import { exportRun, runPilot } from "../src/pilot/runner.ts";

class UsageError extends Error {}

const ROOT = resolve(import.meta.dirname, "..");
const [command, ...rest] = process.argv.slice(2);
const flag = (name: string) => {
  const i = rest.indexOf(name);
  return i >= 0 ? rest[i + 1] : undefined;
};
const out = (s: string) => process.stdout.write(s);
const err = (s: string) => process.stderr.write(s);

function overrides(): Partial<PacingConfig> {
  const o: { concurrency?: number; interTrialDelayS?: number } = {};
  const c = flag("--concurrency");
  const d = flag("--delay-s");
  if (c !== undefined) o.concurrency = Number(c);
  if (d !== undefined) o.interTrialDelayS = Number(d);
  return o;
}

const published = publishedTasks(ROOT);
const sources = ["src/gate/families.ts", "src/gate/calc-document.ts"].map((p) => join(ROOT, p));

function printPlan(outDir: string) {
  const config = loadReviewedConfig(ROOT, published, overrides());
  const first = published.find((t) => t.taskId === config.trials[0]);
  if (first === undefined) throw new Error("pilot task missing");
  const ids = { runId: `r1p-${first.taskId}-a1`, trialKey: `r1p-${first.taskId}-a1` };
  const example = trialLaunchPlan(
    config,
    first,
    ids,
    join(resolve(outDir), "trials", ids.trialKey),
    ROOT,
  );
  const sha = configSha256(config);
  out(
    `${JSON.stringify(
      {
        pilot: "R1 pilot, 30 trials, headless Claude Code on the subscription (no API key path)",
        configSha256: sha,
        model: config.model,
        trials: config.trials,
        pacing: config.pacing,
        cost: `${COST_BASIS}; never billed USD; null when unmeasured`,
        exampleLaunch: { command: "claude", argv: example.argv, mcpServers: example.mcpServers },
      },
      null,
      2,
    )}\n`,
  );
  return sha;
}

try {
  switch (command) {
    case "config":
      out(`${JSON.stringify(loadReviewedConfig(ROOT, published), null, 2)}\n`);
      break;
    case "plan":
      printPlan(flag("--out") ?? "runs/pilot");
      break;
    case "dry-run": {
      const dir = flag("--out");
      if (dir === undefined) throw new UsageError("dry-run needs --out DIR");
      const config = loadReviewedConfig(ROOT, published, overrides());
      const clock = virtualClock(Date.now());
      const r = await runPilot({
        config,
        published,
        outDir: dir,
        repoRoot: ROOT,
        oracleSources: sources,
        driver: fakeDriver(),
        plannerModelId: PILOT_DRY_RUN_PLANNER,
        // The fake uses no subscription: pacing runs on a virtual clock, with no real wait.
        sleep: clock.sleep,
        now: clock.now,
        log: (l) => err(`${l}\n`),
      });
      out(`SIMULATED pilot dry run (never evidence): ${JSON.stringify(r)}\n`);
      process.exitCode = r.status === "complete" ? 0 : 4;
      break;
    }
    case "status": {
      const dir = flag("--out");
      if (dir === undefined) throw new UsageError("status needs --out DIR");
      const state = loadLedger(join(dir, PROGRESS_FILE));
      out(`${JSON.stringify(pilotStatus(state), null, 2)}\n`);
      break;
    }
    case "export": {
      const dir = flag("--out");
      const to = flag("--to");
      if (dir === undefined || to === undefined)
        throw new UsageError("export needs --out DIR --to NEW_DIR");
      const { armRows } = exportRun(dir, to);
      out(`exported ${armRows.length} arm rows to ${resolve(to)}\n`);
      break;
    }
    case "launch": {
      const pre = subscriptionPreflight(Object.keys(process.env));
      if (!pre.ok) {
        err(`${preflightRefusal(pre)}\n`);
        process.exitCode = 3;
        break;
      }
      const dir = flag("--out");
      if (dir === undefined) throw new UsageError("launch needs --out DIR");
      printPlan(dir);
      const tokenFile = flag("--token-file");
      const r = await launchR1Live(
        {
          config: loadReviewedConfig(ROOT, published, overrides()),
          published,
          outDir: dir,
          repoRoot: ROOT,
          oracleSources: sources,
          launchRealTrials: rest.includes("--launch-real-trials"),
          planSha256: flag("--plan-sha256"),
        },
        realLiveDeps(ROOT, tokenFile, (l) => err(`${l}\n`)),
      );
      if (r.refusals.length > 0)
        err(`refusing to launch:\n${r.refusals.map((x) => `  - ${x}\n`).join("")}`);
      else out(`LIVE R1 pilot (cost: token-derived estimate): ${JSON.stringify(r.result)}\n`);
      process.exitCode = r.exitCode;
      break;
    }
    default:
      throw new UsageError(`unknown command ${String(command)}`);
  }
} catch (error) {
  if (error instanceof UsageError) {
    err(`m2-r1-pilot: ${error.message}\n`);
    process.exitCode = 2;
  } else {
    err(`m2-r1-pilot: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
