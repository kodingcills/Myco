/**
 * The hcu+shell head-to-head RUNNER (TIF-268, R2's other arm), on the Claude subscription.
 * Runbook: docs/benchmark/hcu-shell-runbook.md.
 *
 *   npx tsx scripts/m2-hcu-shell-run.ts plan     [--hcu-command CMD]
 *   npx tsx scripts/m2-hcu-shell-run.ts dry-run  --out DIR [--resume] [--max-trials N]   SIMULATED, $0
 *   npx tsx scripts/m2-hcu-shell-run.ts status   --out DIR
 *   npx tsx scripts/m2-hcu-shell-run.ts export   --out DIR
 *   npx tsx scripts/m2-hcu-shell-run.ts probe-planner --call-claude                      one subscription call, no VM
 *   scripts/vm-session.sh -- npx tsx scripts/m2-hcu-shell-run.ts launch --out DIR \
 *       --launch-real-trials --plan-sha256 SHA [--resume] [--max-trials N] [--hcu-command CMD]
 *
 * `launch` prints the plan, then refuses unless every real-run precondition holds
 * (`src/baseline/hcu-shell-live/refusals.ts`: the flag, the printed plan hash, the lead's GO,
 * the subscription preflight, #546's cold-boot guard, the VM lock held by vm-session.sh). It
 * never reads, requires or falls back to an Anthropic API key.
 * Exit: 0 complete / ok, 1 failed, 2 usage, 3 refused, 4 halted / aborted / incomplete.
 */
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import {
  DEFAULT_HCU_GUEST_COMMAND,
  defaultLiveDeps,
  guestShellSha256,
  liveEnvironment,
} from "../src/baseline/hcu-shell-live/live-vm.ts";
import {
  createSubscriptionPlanner,
  HCU_PLANNER_MODEL,
  PlannerHalt,
  PROBE_SCREENSHOT,
} from "../src/baseline/hcu-shell-live/planner.ts";
import { liveRefusals } from "../src/baseline/hcu-shell-live/refusals.ts";
import {
  demoTasks,
  exportHcuPack,
  HcuRunRefusal,
  type HcuRunResult,
  hcuRunPlan,
  hcuStatus,
  loadFcV1,
  planSha256,
  runHcuShell,
  SIMULATED_PLANNER,
} from "../src/baseline/hcu-shell-live/runner.ts";
import {
  simulatedEnvironment,
  simulatedPlanner,
} from "../src/baseline/hcu-shell-live/simulated.ts";
import { lockOwnedByAncestor } from "../src/integration/vm-lock.ts";
import { estimateCost } from "../src/pilot/cost.ts";

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
const out = (s: string) => process.stdout.write(s);
const err = (s: string) => process.stderr.write(s);
const json = (v: unknown) => out(`${JSON.stringify(v, null, 2)}\n`);
const exitFor = (r: HcuRunResult) => (r.status === "complete" ? 0 : 4);
const maxTrials = () => {
  const m = flag("--max-trials");
  if (m === undefined) return undefined;
  const n = Number(m);
  if (!Number.isSafeInteger(n) || n < 1)
    throw new UsageError("--max-trials must be a positive integer");
  return n;
};

const tasks = demoTasks(loadFcV1(ROOT));
const plan = hcuRunPlan(tasks, {
  hcuGuestCommand: flag("--hcu-command") ?? DEFAULT_HCU_GUEST_COMMAND,
  guestShellSha256: guestShellSha256(ROOT),
});
const sha = planSha256(plan);
const printPlan = () => json({ planSha256: sha, plan });
const price = (t: Parameters<typeof estimateCost>[1]) =>
  estimateCost(HCU_PLANNER_MODEL, t).estimatedModelUsd;

try {
  switch (command) {
    case "plan":
      printPlan();
      break;
    case "dry-run": {
      const dir = need("--out");
      const r = await runHcuShell({
        outDir: dir,
        repoRoot: ROOT,
        tasks,
        plan,
        env: simulatedEnvironment(ROOT),
        planner: simulatedPlanner(),
        plannerModelId: SIMULATED_PLANNER,
        resume: rest.includes("--resume"),
        ...(maxTrials() === undefined ? {} : { maxTrials: maxTrials() }),
        log: (l) => err(`${l}\n`),
      });
      const pack = exportHcuPack(dir, ROOT, tasks);
      out(`SIMULATED hcu+shell dry run (never evidence): ${JSON.stringify({ ...r, pack })}\n`);
      process.exitCode = exitFor(r);
      break;
    }
    case "status":
      json(hcuStatus(need("--out")));
      break;
    case "export":
      json(exportHcuPack(need("--out"), ROOT, tasks));
      break;
    case "probe-planner": {
      if (!rest.includes("--call-claude")) {
        err("refusing: probe-planner makes one real subscription call; pass --call-claude\n");
        process.exitCode = 3;
        break;
      }
      const planner = createSubscriptionPlanner({
        spawn,
        command: "claude",
        env: process.env,
        cwd: ROOT,
        price,
      });
      const r = await planner.act({
        instruction: "Probe only: reply with the claim failure.",
        screenshot: PROBE_SCREENSHOT,
        shellHistory: [],
      });
      json({
        ok: true,
        model: r.calls[0]?.model,
        decision: r.decision ?? null,
        usage: r.calls[0]?.usage,
      });
      break;
    }
    case "launch": {
      const dir = need("--out");
      printPlan();
      const refusals = liveRefusals({
        repoRoot: ROOT,
        planSha256: sha,
        launchRealTrials: rest.includes("--launch-real-trials"),
        pinnedPlanSha256: flag("--plan-sha256"),
        envNames: Object.keys(process.env),
        vmLockHeld: lockOwnedByAncestor(),
      });
      if (refusals.length > 0) {
        err(`refusing to launch the hcu+shell arm:\n${refusals.map((r) => `  - ${r}\n`).join("")}`);
        process.exitCode = 3;
        break;
      }
      const planner = createSubscriptionPlanner({
        spawn,
        command: "claude",
        env: process.env,
        cwd: resolve(dir),
        price,
      });
      const r = await runHcuShell({
        outDir: dir,
        repoRoot: ROOT,
        tasks,
        plan,
        env: liveEnvironment(ROOT, defaultLiveDeps(ROOT), plan.hcuGuestCommand),
        planner,
        plannerModelId: HCU_PLANNER_MODEL,
        resume: rest.includes("--resume"),
        ...(maxTrials() === undefined ? {} : { maxTrials: maxTrials() }),
        log: (l) => err(`${l}\n`),
      });
      const pack = exportHcuPack(dir, ROOT, tasks);
      json({ ...r, pack });
      process.exitCode = exitFor(r);
      break;
    }
    default:
      throw new UsageError(`unknown command ${String(command)}`);
  }
} catch (error) {
  if (error instanceof UsageError) {
    err(`m2-hcu-shell-run: ${error.message}\n`);
    process.exitCode = 2;
  } else if (error instanceof HcuRunRefusal || error instanceof PlannerHalt) {
    err(`m2-hcu-shell-run: refused: ${error.message}\n`);
    process.exitCode = 3;
  } else {
    err(`m2-hcu-shell-run: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
