/**
 * `pnpm myco-fleet`: run the Linux desktop fleet measurement, or re-check a committed one.
 *
 *   pnpm myco-fleet --k 1,2,4 --trials 16 --allow-weak-isolation --out DIR [--print]
 *   pnpm myco-fleet --check FILE
 *
 * The run writes `<out>/measurement.json` (and the per-level pools and attempt ledgers under
 * `<out>/run/`). `--print` also prints the artifact and its sha256, so a CI log carries a
 * copy anyone can recompute. `--check` recomputes a measurement's summary from its rows and
 * exits 1 on any problem. $0: scripted agents, no model, no VM, no network.
 *
 * Exit codes: 0 ok; 1 refused, a wrong verdict, a false VERIFIED, contamination, or a failed
 * check; 3 usage.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { linuxBackend } from "../parallel/linux-backend.ts";
import { PoolRefused } from "../parallel/pool.ts";
import { MAX_THINK_MS } from "./agents.ts";
import { checkFleetMeasurement, type FleetMeasurement } from "./analysis.ts";
import { FleetCapRefused } from "./caps.ts";
import { measureFleet, planProblems } from "./run.ts";

export const USAGE = `usage: pnpm myco-fleet --k LIST --trials N --allow-weak-isolation --out DIR [--memory-mb M] [--print]
       pnpm myco-fleet --check FILE

  --k LIST                 desktop counts to measure, e.g. 1,2,4 (hard cap: 8)
  --trials N               trials per level (default 16)
  --memory-mb M            memory cap per desktop in MiB (default 512; hard cap 2048, total 8192)
  --think-ms T             the scripted agent's think time inside its desktop (default 0, max 10000)
  --allow-weak-isolation   required: the only backend here is linux-plain, which leaves other
                           trials' roots visible, so no trial is ever counted
  --out DIR                a new directory for measurement.json and the run tree
  --print                  also print the artifact and its sha256
  --check FILE             recompute a measurement's summary from its rows`;

type Args =
  | { mode: "check"; file: string }
  | {
      mode: "run";
      ks: number[];
      trials: number;
      mem: number;
      thinkMs: number;
      out: string;
      print: boolean;
    };

export function parseArgs(argv: readonly string[]): Args | string {
  let ks: number[] | null = null;
  let trials = 16;
  let mem = 512;
  let thinkMs = 0;
  let out: string | null = null;
  let print = false;
  let weak = false;
  let check: string | null = null;
  const int = (v: string | undefined) => (v && /^\d+$/.test(v) ? Number(v) : Number.NaN);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = argv[i + 1];
    if (a === "--k") {
      ks = (v ?? "").split(",").map(int);
      i++;
    } else if (a === "--trials") {
      trials = int(v);
      i++;
    } else if (a === "--memory-mb") {
      mem = int(v);
      i++;
    } else if (a === "--think-ms") {
      thinkMs = int(v);
      i++;
    } else if (a === "--out") {
      out = v ?? null;
      i++;
    } else if (a === "--check") {
      check = v ?? null;
      i++;
    } else if (a === "--print") print = true;
    else if (a === "--allow-weak-isolation") weak = true;
    else return `unknown argument ${JSON.stringify(a)}`;
  }
  if (check !== null) return { mode: "check", file: check };
  if (!ks || ks.some((k) => Number.isNaN(k))) return "--k needs a list of integers";
  if (Number.isNaN(trials) || Number.isNaN(mem) || Number.isNaN(thinkMs))
    return "--trials, --memory-mb and --think-ms need integers";
  if (thinkMs > MAX_THINK_MS) return `--think-ms is at most ${MAX_THINK_MS}`;
  if (!out) return "--out is required";
  if (!weak)
    return "--allow-weak-isolation is required: linux-plain cannot meet strict isolation, and none of its trials is ever counted";
  return { mode: "run", ks, trials, mem, thinkMs, out, print };
}

function summaryLines(m: FleetMeasurement): string[] {
  const lines = [
    `backend ${m.backend} (hostDirsHidden ${String(m.hostDirsHidden)}); ${m.trialsPerK} trials per level; think ${m.agentThinkMs} ms; SIMULATED, never evidence, never R1, not a Windows row`,
    "   K  trials  wall s  trials/h  speedup  correct  falseVerified  disagree  contaminated  counted",
  ];
  for (const p of m.summary)
    lines.push(
      [
        String(p.k).padStart(4),
        String(p.trials).padStart(7),
        (p.wallMs / 1000).toFixed(1).padStart(7),
        String(p.trialsPerHour).padStart(9),
        `${p.speedupVsFirst}x`.padStart(8),
        String(p.correct).padStart(8),
        String(p.falseVerified).padStart(14),
        String(p.gateGraderDisagree).padStart(9),
        String(p.contaminationEvents).padStart(13),
        String(p.countedVerified).padStart(8),
      ].join(""),
    );
  return lines;
}

/** Whether a measurement is a clean pass: every verdict right, no false VERIFIED, no contamination. */
export function measurementPasses(m: FleetMeasurement): boolean {
  return m.summary.every(
    (p) =>
      p.correct === p.trials &&
      p.falseVerified === 0 &&
      p.gateGraderDisagree === 0 &&
      p.contaminationEvents === 0,
  );
}

export async function main(
  argv: readonly string[],
  log: (s: string) => void = (s) => process.stdout.write(`${s}\n`),
): Promise<number> {
  const args = parseArgs(argv);
  if (typeof args === "string") {
    log(`${args}\n${USAGE}`);
    return 3;
  }
  if (args.mode === "check") {
    let m: FleetMeasurement;
    try {
      m = JSON.parse(readFileSync(args.file, "utf8")) as FleetMeasurement;
    } catch {
      log("UNREADABLE");
      return 1;
    }
    const problems = checkFleetMeasurement(m);
    for (const p of problems) log(p);
    if (problems.length > 0) return 1;
    for (const l of summaryLines(m)) log(l);
    log("recomputed: the summary matches the rows");
    return 0;
  }
  // Hard caps first: a refused plan creates nothing, not even the output directory.
  const refused = planProblems({
    ks: args.ks,
    trialsPerK: args.trials,
    memoryMbPerDesktop: args.mem,
  });
  if (refused.length > 0) {
    log(refused.join("\n"));
    return 1;
  }
  const out = resolve(args.out);
  if (existsSync(out)) {
    log("OUT_EXISTS");
    return 1;
  }
  mkdirSync(out, { recursive: true });
  const env = process.env;
  const ciRunUrl =
    env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID
      ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`
      : null;
  let m: FleetMeasurement;
  try {
    m = await measureFleet({
      backend: linuxBackend(),
      requirements: {
        network: "best-effort",
        privateTmp: "best-effort",
        hideHostDirs: "best-effort",
        display: "none",
      },
      runRoot: join(out, "run"),
      ks: args.ks,
      trialsPerK: args.trials,
      memoryMbPerDesktop: args.mem,
      agentThinkMs: args.thinkMs,
      provenance: { gitSha: env.GITHUB_SHA ?? null, ciRunUrl },
    });
  } catch (e) {
    if (e instanceof FleetCapRefused) {
      log(e.codes.join("\n"));
      return 1;
    }
    if (e instanceof PoolRefused) {
      log(`POOL_REFUSED ${e.problems.join("; ")}`);
      return 1;
    }
    throw e;
  }
  const text = `${JSON.stringify(m, null, 2)}\n`;
  writeFileSync(join(out, "measurement.json"), text);
  for (const l of summaryLines(m)) log(l);
  if (args.print) {
    log("----- BEGIN myco.linux-fleet.measurement/1 -----");
    log(text.trimEnd());
    log("----- END myco.linux-fleet.measurement/1 -----");
    log(`sha256 ${createHash("sha256").update(text).digest("hex")}`);
  }
  return measurementPasses(m) ? 0 : 1;
}
