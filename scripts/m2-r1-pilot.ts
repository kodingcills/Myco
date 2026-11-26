/**
 * The 30-trial R1 pilot runner (track E). Runbook: docs/benchmark/pilot-runbook.md.
 *
 *   npx tsx scripts/m2-r1-pilot.ts config                  print the reviewed config JSON
 *   npx tsx scripts/m2-r1-pilot.ts plan    [pacing]        print the launch plan and its sha256
 *   npx tsx scripts/m2-r1-pilot.ts dry-run --out DIR       SIMULATED: fake transport, $0, never evidence
 *   npx tsx scripts/m2-r1-pilot.ts status  --out DIR       ledger summary and the cost ESTIMATE
 *   npx tsx scripts/m2-r1-pilot.ts export  --out DIR --to NEW_DIR
 *   npx tsx scripts/m2-r1-pilot.ts launch  --out DIR --launch-real-trials --plan-sha256 SHA [pacing]
 *
 * pacing: --concurrency N --delay-s S (defaults in benchmark/pilot/r1/config.json).
 *
 * `launch` never starts a real trial in this change: it checks the subscription preflight
 * (names only), requires the explicit flag and the sha256 of the plan `plan` printed, prints
 * the plan, and then refuses, because the VM-side capture is the lead-approved later step.
 * Exit: 0 ok / complete, 1 run failed, 2 usage, 3 refused, 4 paused or incomplete.
 */
import { join, resolve } from "node:path";
import { configSha256, type PacingConfig } from "../src/pilot/config.ts";
import { COST_BASIS, estimatedCostPerVerified } from "../src/pilot/cost.ts";
import { fakeDriver, PILOT_DRY_RUN_PLANNER, virtualClock } from "../src/pilot/dry-run.ts";
import { preflightRefusal, subscriptionPreflight, trialLaunchPlan } from "../src/pilot/launch.ts";
import { ATTEMPTS_FILE, ledgerRows, loadLedger } from "../src/pilot/ledger.ts";
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
      const state = loadLedger(join(dir, ATTEMPTS_FILE));
      const { armRows, faulted, costs } = ledgerRows(state);
      const verified = armRows.filter((r) => r.accepted).length;
      out(
        `${JSON.stringify(
          {
            simulated: state.header?.simulated ?? null,
            decided: armRows.length,
            faultedAttempts: faulted.length,
            acceptedByGate: verified,
            costEstimate: estimatedCostPerVerified(costs, verified),
            note: "acceptedByGate is not graded; R7 uses verified = accepted AND graded pass (benchmark-check)",
          },
          null,
          2,
        )}\n`,
      );
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
      const sha = printPlan(dir);
      if (!rest.includes("--launch-real-trials") || flag("--plan-sha256") !== sha) {
        err(
          "refusing to launch: a real launch needs --launch-real-trials and --plan-sha256 <the configSha256 printed above>\n",
        );
        process.exitCode = 3;
        break;
      }
      err(
        "refusing to launch: the live pilot is a later, lead-approved step. This change has no VM-side capture wired " +
          "(claudeDriver needs `capture`), so it cannot start real trials. See docs/benchmark/pilot-runbook.md.\n",
      );
      process.exitCode = 3;
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
