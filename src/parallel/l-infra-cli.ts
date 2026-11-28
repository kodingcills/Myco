/**
 * `myco-l-infra` and `myco-l-infra-analyze` — track L's zero-contamination run (L-infra) and
 * its recomputation. $0: scripted agents only, no model, no API.
 *
 *   pnpm myco-l-infra --allow-weak-isolation --agent calc --display xvfb --out <dir> [--print-rows]
 *   pnpm myco-l-infra-analyze <dir> [--check]
 *
 * `myco-l-infra` runs fc-v1's satisfiable tasks at N = 1, 2, 4, 8 (or `--levels`) on the
 * unprivileged `linux-plain` backend, then writes `run.json`, `rows.jsonl` and `result.json`
 * to `--out`. `--print-rows` also prints the run and rows files between markers, so a public
 * CI log carries the exact bytes and their SHA-256 (docs/product/l-infra/README.md).
 *
 * `linux-plain` meets none of the strict isolation requirements, so the run needs
 * `--allow-weak-isolation`, like `myco-parallel`. Its trials are never counted
 * (`shared-host-dirs`); L-infra measures contamination, never a verified count.
 *
 * `myco-l-infra-analyze` recomputes `result.json` from `run.json` and `rows.jsonl` and the
 * committed task set; `--check` also requires it to equal the dir's `result.json` byte for
 * byte.
 *
 * Exit: 0 the result meets (and, with --check, matches); 1 it does not, or a refusal;
 * 3 usage error.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { calcActuatorAgent, scriptedFileAgent } from "./agents.ts";
import { DEFAULT_CAPS } from "./caps.ts";
import { requirementsFor } from "./cli.ts";
import {
  L_INFRA_LEVELS,
  LInfraRefused,
  type LInfraRun,
  loadSatisfiableTasks,
  runLInfra,
} from "./l-infra.ts";
import {
  type LInfraResultFile,
  RESULT_FILE,
  ROWS_FILE,
  RUN_FILE,
  recomputeLInfra,
  resultFileOf,
  serializeResult,
  serializeRows,
  serializeRun,
} from "./l-infra-analysis.ts";
import { linuxBackend } from "./linux-backend.ts";
import { PoolRefused } from "./pool.ts";

export const RUN_USAGE = `usage: pnpm myco-l-infra --allow-weak-isolation [options]

  --agent file|calc         scripted file writer (default) or real headless Calc
  --display none|xvfb       give every desktop its own Xvfb (default none)
  --levels <list>           concurrency levels (default ${L_INFRA_LEVELS.join(",")})
  --out <dir>               where run.json, rows.jsonl and result.json go
                            (default $TMPDIR/myco-l-infra-<time>)
  --print-rows              also print run.json and rows.jsonl between markers
  --allow-weak-isolation    required: linux-plain is the only Linux backend here
  --help                    this text

exit: 0 the result meets, 1 it does not (or a refusal), 3 usage error
`;

export const ANALYZE_USAGE = `usage: pnpm myco-l-infra-analyze <dir> [--check]

  --check   the recomputed result must equal <dir>/result.json byte for byte

exit: 0 the result meets (and matches), 1 it does not, 3 usage error
`;

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

interface RunArgs {
  agent: "file" | "calc";
  display: "none" | "xvfb";
  levels: number[];
  out: string;
  printRows: boolean;
  weak: boolean;
}

export function parseRunArgs(argv: readonly string[]): RunArgs | "help" {
  const a: RunArgs = {
    agent: "file",
    display: "none",
    levels: [...L_INFRA_LEVELS],
    out: join(tmpdir(), `myco-l-infra-${Date.now()}`),
    printRows: false,
    weak: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = () => argv[++i];
    switch (flag) {
      case "--help":
        return "help";
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
      case "--levels":
        a.levels = (value() ?? "").split(",").map((s) => {
          const n = Number(s);
          if (!/^\d+$/.test(s) || !Number.isSafeInteger(n) || n <= 0)
            throw new Error("--levels needs positive integers");
          return n;
        });
        break;
      case "--out":
        a.out = resolve(value() ?? "");
        break;
      case "--print-rows":
        a.printRows = true;
        break;
      case "--allow-weak-isolation":
        a.weak = true;
        break;
      default:
        throw new Error(`unknown argument ${JSON.stringify(flag)}`);
    }
  }
  if (!a.weak)
    throw new Error(
      "--allow-weak-isolation is required: linux-plain is the only Linux backend, and it meets no strict requirement",
    );
  return a;
}

/** CI provenance, from the runner's documented non-secret variables; null locally. */
export function provenanceFromEnv(env: NodeJS.ProcessEnv = process.env): LInfraRun["provenance"] {
  const server = env.GITHUB_SERVER_URL;
  const repo = env.GITHUB_REPOSITORY;
  const runId = env.GITHUB_RUN_ID;
  const attempt = env.GITHUB_RUN_ATTEMPT;
  return {
    commit: env.GITHUB_SHA ?? null,
    runUrl:
      server && repo && runId
        ? `${server}/${repo}/actions/runs/${runId}${attempt ? `/attempts/${attempt}` : ""}`
        : null,
    workflow:
      env.GITHUB_WORKFLOW && env.GITHUB_JOB ? `${env.GITHUB_WORKFLOW} / ${env.GITHUB_JOB}` : null,
  };
}

export function renderResult(r: LInfraResultFile): string {
  const lines = [
    `L-infra on ${r.backend} (${r.agent}); task set ${r.taskSet.version}, ${r.taskSet.satisfiable} satisfiable tasks`,
    "SIMULATED (scripted agent): never evidence of agent capability",
    "",
    "   N  admitted  trials  events  wall s  trials/h  peak",
  ];
  for (const l of r.levels)
    lines.push(
      [
        String(l.n).padStart(4),
        (l.admitted ? "yes" : "no").padStart(10),
        String(l.trials).padStart(8),
        String(l.contaminationEvents).padStart(8),
        (l.wallMs === null ? "-" : (l.wallMs / 1000).toFixed(1)).padStart(8),
        String(l.trialsPerHour ?? "-").padStart(10),
        String(l.peakConcurrent ?? "-").padStart(6),
      ].join(""),
    );
  lines.push(
    "",
    `trials ${r.trials}; contamination events ${r.contaminationEvents}; unscanned ${r.unscanned}; teardown failures ${r.teardownFailures}`,
    `positive control: ${r.positiveControl.detected ? "detected" : "NOT DETECTED"}`,
    `contamination rate 95% upper bound: ${r.contaminationRateUpper95 ?? "-"}`,
  );
  for (const f of r.failures) lines.push(`FAIL: ${f}`);
  for (const d of r.deviations) lines.push(`DEVIATION: ${d}`);
  lines.push(
    "",
    r.meets
      ? r.meetsAsSpecified
        ? "MEETS: zero contamination at every specified level"
        : "MEETS at the admitted levels (see DEVIATION)"
      : "DOES NOT MEET",
    `run.json sha256 ${r.runSha256}`,
    `rows.jsonl sha256 ${r.rowsSha256}`,
  );
  return lines.join("\n");
}

export async function mainRun(
  argv: readonly string[],
  out: (text: string) => void = (t) => {
    process.stdout.write(`${t}\n`);
  },
): Promise<number> {
  let args: RunArgs | "help";
  try {
    args = parseRunArgs(argv);
  } catch (e) {
    out(`${e instanceof Error ? e.message : String(e)}\n\n${RUN_USAGE}`);
    return 3;
  }
  if (args === "help") {
    out(RUN_USAGE);
    return 0;
  }
  const agentKind = args.agent;
  try {
    const set = loadSatisfiableTasks();
    const { run, rows } = await runLInfra({
      backend: linuxBackend(),
      requirements: requirementsFor({ weak: true, display: args.display }),
      runRoot: join(args.out, "pool"),
      levels: args.levels,
      taskSet: set,
      agent: () =>
        agentKind === "calc" ? calcActuatorAgent("honest") : scriptedFileAgent("honest"),
      agentLabel: `${agentKind === "calc" ? "calc-actuator" : "scripted-file"}:honest/${args.display}`,
      caps: {
        memoryMbPerTrial: DEFAULT_CAPS.memoryMbPerTrial,
        cpusPerTrial: DEFAULT_CAPS.cpusPerTrial,
        cpuSecondsPerTrial: DEFAULT_CAPS.cpuSecondsPerTrial,
        trialTimeoutMs: DEFAULT_CAPS.trialTimeoutMs,
      },
      provenance: provenanceFromEnv(),
      onLevel: (l) =>
        out(
          l.admitted
            ? `level N=${l.n}: done in ${((l.wallMs ?? 0) / 1000).toFixed(1)} s`
            : `level N=${l.n}: not admitted (${l.problems.join("; ")})`,
        ),
    });
    const runText = serializeRun(run);
    const rowsText = serializeRows(rows);
    const result = resultFileOf(runText, rowsText, set);
    mkdirSync(args.out, { recursive: true });
    writeFileSync(join(args.out, RUN_FILE), runText, { flag: "wx" });
    writeFileSync(join(args.out, ROWS_FILE), rowsText, { flag: "wx" });
    writeFileSync(join(args.out, RESULT_FILE), serializeResult(result), { flag: "wx" });
    if (args.printRows) {
      out(`----- BEGIN ${RUN_FILE} sha256 ${sha256(runText)} -----`);
      out(runText.trimEnd());
      out(`----- END ${RUN_FILE} -----`);
      out(`----- BEGIN ${ROWS_FILE} sha256 ${sha256(rowsText)} -----`);
      out(rowsText.trimEnd());
      out(`----- END ${ROWS_FILE} -----`);
    }
    out(renderResult(result));
    out(`written to ${args.out}`);
    return result.meets ? 0 : 1;
  } catch (e) {
    if (e instanceof PoolRefused || e instanceof LInfraRefused) {
      out(e.message);
      return 1;
    }
    throw e;
  }
}

export function mainAnalyze(
  argv: readonly string[],
  out: (text: string) => void = (t) => {
    process.stdout.write(`${t}\n`);
  },
): number {
  const check = argv.includes("--check");
  if (argv.includes("--help")) {
    out(ANALYZE_USAGE);
    return 0;
  }
  const dirs = argv.filter((a) => a !== "--check");
  if (dirs.length !== 1 || dirs[0]?.startsWith("--")) {
    out(ANALYZE_USAGE);
    return 3;
  }
  const dir = resolve(dirs[0] as string);
  let result: LInfraResultFile;
  try {
    result = recomputeLInfra(dir, loadSatisfiableTasks());
  } catch (e) {
    out(e instanceof Error ? e.message : String(e));
    return 1;
  }
  out(renderResult(result));
  if (check) {
    let committed = "";
    try {
      committed = readFileSync(join(dir, RESULT_FILE), "utf8");
    } catch {
      committed = "";
    }
    if (committed !== serializeResult(result)) {
      out(`MISMATCH: ${join(dir, RESULT_FILE)} is not the recomputed result`);
      return 1;
    }
    out(`${RESULT_FILE} matches the recomputation`);
  }
  return result.meets ? 0 : 1;
}
