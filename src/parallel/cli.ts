/**
 * `myco-parallel` — track L's $0 throughput harness (scripted agents, no model, no API).
 *
 *   pnpm myco-parallel --probe
 *   pnpm myco-parallel --n 1,2,4 --trials 8 --agent file --out /tmp/myco-parallel
 *   pnpm myco-parallel --n 1,2 --trials 4 --agent calc --display xvfb
 *
 * Isolation defaults to STRICT (own network, private /tmp, other trials' roots hidden).
 * The only Linux backend in this PR is `linux-plain`, which meets none of those, so under
 * the default every trial is refused (`isolation`). `--allow-weak-isolation` lowers each
 * requirement to best-effort so the trials run and the harness can be measured; the
 * report records the isolation every trial actually got, and NO `linux-plain` trial is
 * ever counted as verified (`shared-host-dirs`). Strict namespace isolation is not in
 * this PR (docs/product/safe-parallelism.md §2).
 *
 * Exit: 0 every trial got its expected verdict with no disqualifier; 1 a mismatch,
 * contamination, a refused pool or an unavailable backend; 3 usage error.
 */

import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type AgentBehaviour, calcActuatorAgent, scriptedFileAgent } from "./agents.ts";
import { type IsolationRequirements, STRICT_REQUIREMENTS } from "./backend.ts";
import { DEFAULT_CAPS } from "./caps.ts";
import { linuxBackend } from "./linux-backend.ts";
import { PoolRefused } from "./pool.ts";
import { runThroughput, type ThroughputReport } from "./throughput.ts";

export const USAGE = `usage: pnpm myco-parallel (--probe | [options])

  --probe                   report the backend's isolation on this host and exit
  --n <list>                concurrency levels, e.g. 1,2,4 (default 1,2)
  --trials <k>              trials per level (default 4)
  --agent file|calc         scripted file writer (default) or real headless Calc
  --display none|xvfb       give every desktop its own Xvfb (default none)
  --memory-mb <m>           per-trial memory cap (default ${DEFAULT_CAPS.memoryMbPerTrial})
  --cpu-seconds <s>         per-trial CPU-time cap (default ${DEFAULT_CAPS.cpuSecondsPerTrial})
  --timeout-ms <t>          per-trial wall-clock cap (default ${DEFAULT_CAPS.trialTimeoutMs})
  --memory-budget-mb <m>    pool memory budget (default 75% of host)
  --cpu-budget <c>          pool CPU budget (default host CPUs)
  --allow-weak-isolation    run on linux-plain (shared network, /tmp, visible roots);
                            its trials are measured but never counted as verified
  --out <dir>               run root (default $TMPDIR/myco-parallel-<time>)
  --json                    print the report as JSON
  --help                    this text

exit: 0 all trials correct, 1 mismatch / contamination / refusal, 3 usage error
`;

export interface CliArgs {
  probe: boolean;
  ns: number[];
  trials: number;
  agent: "file" | "calc";
  display: "none" | "xvfb";
  memoryMb: number;
  cpuSeconds: number;
  timeoutMs: number;
  memoryBudgetMb?: number;
  cpuBudget?: number;
  weak: boolean;
  out: string;
  json: boolean;
}

function int(flag: string, raw: string | undefined): number {
  const n = Number(raw);
  if (raw === undefined || !/^\d+$/.test(raw) || !Number.isSafeInteger(n) || n <= 0)
    throw new Error(`${flag} needs a positive integer`);
  return n;
}

export function parseArgs(argv: readonly string[]): CliArgs | "help" {
  const a: CliArgs = {
    probe: false,
    ns: [1, 2],
    trials: 4,
    agent: "file",
    display: "none",
    memoryMb: DEFAULT_CAPS.memoryMbPerTrial,
    cpuSeconds: DEFAULT_CAPS.cpuSecondsPerTrial,
    timeoutMs: DEFAULT_CAPS.trialTimeoutMs,
    weak: false,
    out: join(tmpdir(), `myco-parallel-${Date.now()}`),
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = () => argv[++i];
    switch (flag) {
      case "--help":
        return "help";
      case "--probe":
        a.probe = true;
        break;
      case "--n":
        a.ns = (value() ?? "").split(",").map((s) => int("--n", s));
        break;
      case "--trials":
        a.trials = int(flag, value());
        break;
      case "--agent": {
        const v = value();
        if (v !== "file" && v !== "calc") throw new Error("--agent is file or calc");
        a.agent = v;
        break;
      }
      case "--display": {
        const v = value();
        if (v !== "none" && v !== "xvfb") throw new Error("--display is none or xvfb");
        a.display = v;
        break;
      }
      case "--memory-mb":
        a.memoryMb = int(flag, value());
        break;
      case "--cpu-seconds":
        a.cpuSeconds = int(flag, value());
        break;
      case "--timeout-ms":
        a.timeoutMs = int(flag, value());
        break;
      case "--memory-budget-mb":
        a.memoryBudgetMb = int(flag, value());
        break;
      case "--cpu-budget":
        a.cpuBudget = int(flag, value());
        break;
      case "--allow-weak-isolation":
        a.weak = true;
        break;
      case "--out":
        a.out = resolve(value() ?? "");
        break;
      case "--json":
        a.json = true;
        break;
      default:
        throw new Error(`unknown argument ${JSON.stringify(flag)}`);
    }
  }
  return a;
}

export function requirementsFor(a: Pick<CliArgs, "weak" | "display">): IsolationRequirements {
  return a.weak
    ? {
        network: "best-effort",
        privateTmp: "best-effort",
        hideHostDirs: "best-effort",
        display: a.display,
      }
    : { ...STRICT_REQUIREMENTS, display: a.display };
}

export function renderReport(r: ThroughputReport): string {
  const lines = [
    `backend ${r.backend}; ${r.trialsPerN} trial(s) per level; simulated (scripted agents): never evidence`,
    "gate-ok: the gate said verified; counted: verified with no disqualifier (always 0 on linux-plain)",
    "",
    "   N  trials  wall s  trials/h  gate-ok  counted  counted/h  correct  contaminated  peak  speedup",
  ];
  for (const p of r.points)
    lines.push(
      [
        String(p.n).padStart(4),
        String(p.trials).padStart(7),
        (p.wallMs / 1000).toFixed(1).padStart(7),
        String(p.trialsPerHour).padStart(9),
        String(p.gateVerified).padStart(9),
        String(p.countedVerified).padStart(9),
        String(p.countedVerifiedPerHour).padStart(11),
        String(p.correct).padStart(8),
        String(p.contaminated).padStart(13),
        String(p.peakConcurrent).padStart(5),
        `${p.speedupVsFirst}x`.padStart(8),
      ].join(""),
    );
  for (const p of r.points) for (const m of p.mismatches) lines.push(`  MISMATCH n=${p.n}: ${m}`);
  lines.push("", r.allCorrect ? "every trial got its expected verdict" : "SOME TRIALS WERE WRONG");
  return lines.join("\n");
}

export async function main(
  argv: readonly string[],
  out: (text: string) => void = (text) => {
    process.stdout.write(`${text}\n`);
  },
): Promise<number> {
  let args: CliArgs | "help";
  try {
    args = parseArgs(argv);
  } catch (e) {
    out(`${e instanceof Error ? e.message : String(e)}\n\n${USAGE}`);
    return 3;
  }
  if (args === "help") {
    out(USAGE);
    return 0;
  }
  const backend = linuxBackend();
  if (args.probe) {
    const probe = await backend.probe();
    out(JSON.stringify(probe, null, 2));
    return probe.available ? 0 : 1;
  }
  const agentKind = args.agent;
  try {
    const report = await runThroughput({
      backend,
      requirements: requirementsFor(args),
      runRoot: args.out,
      ns: args.ns,
      trialsPerN: args.trials,
      agent: (b: AgentBehaviour) =>
        agentKind === "calc" ? calcActuatorAgent(b) : scriptedFileAgent(b),
      caps: {
        memoryMbPerTrial: args.memoryMb,
        cpusPerTrial: 1,
        cpuSecondsPerTrial: args.cpuSeconds,
        trialTimeoutMs: args.timeoutMs,
        ...(args.memoryBudgetMb ? { memoryBudgetMb: args.memoryBudgetMb } : {}),
        ...(args.cpuBudget ? { cpuBudget: args.cpuBudget } : {}),
      },
      label: `${args.agent}/${args.display}`,
    });
    out(args.json ? JSON.stringify(report, null, 2) : renderReport(report));
    return report.allCorrect ? 0 : 1;
  } catch (e) {
    if (e instanceof PoolRefused) {
      out(e.message);
      return 1;
    }
    throw e;
  }
}
