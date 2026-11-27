/**
 * `ci-required-green`: the R1 pilot launch gate (CI speed, #678).
 *
 *   scripts/ci-required-green.sh <40-hex commit sha> [--repo owner/name]
 *
 * Exits 0 only when that commit's CI run from a push to `main` exists and each of the five
 * REQUIRED checks (scripts/ci-required-checks.json) completed with conclusion `success`.
 * Every other job (viewer verdict budget, linux path, the macOS agent tests, ...) is
 * ignored: a red timing job on `main` does not block a launch, and a red required check
 * always does. Fail closed: a missing run, a missing or unfinished required check, a
 * truncated job list, an unreadable answer or a failed `gh` call is never 0.
 *
 * Reads GitHub through the `gh` CLI (`gh api`, read-only, the operator's existing login).
 * It never reads, prints or passes a token. Output is codes and check names only.
 *
 * Exit codes: 0 green, 1 not green, 2 usage, 3 lookup failed.
 */
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CONFIG = JSON.parse(readFileSync(join(HERE, "ci-required-checks.json"), "utf8")) as {
  workflow: string;
  required: string[];
};

export const REQUIRED_CHECKS: readonly string[] = Object.freeze([...CONFIG.required]);
export const CI_WORKFLOW_PATH: string = CONFIG.workflow;
export const DEFAULT_REPO = "kodingcills/Myco";
const PER_PAGE = 100;

export const EXIT = { green: 0, notGreen: 1, usage: 2, lookup: 3 } as const;

export interface Verdict {
  green: boolean;
  /** Codes only: RUN_NOT_FOUND, MISSING <name>, NOT_SUCCESS <name>=<state>, ... */
  codes: string[];
  runId: number | null;
  /** Each required check's state as read: its conclusion, or its status if unfinished. */
  checks: Record<string, string>;
}

interface RunRow {
  id: number;
  head_sha: string;
  event: string;
  head_branch: string | null;
  path: string;
  run_attempt?: number;
  created_at?: string;
}

interface JobRow {
  name: string;
  status: string;
  conclusion: string | null;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The commit's CI run from a push to main: the newest one, by run id. */
export function pickMainRun(
  sha: string,
  runsPage: unknown,
): { run: RunRow | null; codes: string[] } {
  if (!isObject(runsPage) || !Array.isArray(runsPage.workflow_runs)) {
    return { run: null, codes: ["RUNS_UNREADABLE"] };
  }
  const total = runsPage.total_count;
  if (typeof total === "number" && total > runsPage.workflow_runs.length) {
    return { run: null, codes: ["RUNS_TRUNCATED"] };
  }
  const runs = runsPage.workflow_runs.filter(
    (r): r is RunRow =>
      isObject(r) &&
      typeof r.id === "number" &&
      r.head_sha === sha &&
      r.event === "push" &&
      r.head_branch === "main" &&
      typeof r.path === "string" &&
      // The API reports `.github/workflows/ci.yml` (sometimes with `@refs/heads/main`).
      r.path.split("@")[0] === CI_WORKFLOW_PATH,
  );
  if (runs.length === 0) return { run: null, codes: ["RUN_NOT_FOUND"] };
  const newest = runs.reduce((a, b) => (b.id > a.id ? b : a));
  return { run: newest, codes: [] };
}

/** Each required check must appear, and every job with its name must be completed/success. */
export function judgeJobs(jobsPage: unknown): { codes: string[]; checks: Record<string, string> } {
  if (!isObject(jobsPage) || !Array.isArray(jobsPage.jobs)) {
    return { codes: ["JOBS_UNREADABLE"], checks: {} };
  }
  const total = jobsPage.total_count;
  if (typeof total !== "number" || total > jobsPage.jobs.length) {
    return { codes: ["JOBS_TRUNCATED"], checks: {} };
  }
  const jobs = jobsPage.jobs.filter(
    (j): j is JobRow => isObject(j) && typeof j.name === "string" && typeof j.status === "string",
  );
  const codes: string[] = [];
  const checks: Record<string, string> = {};
  for (const name of REQUIRED_CHECKS) {
    const mine = jobs.filter((j) => j.name === name);
    if (mine.length === 0) {
      checks[name] = "missing";
      codes.push(`MISSING ${name}`);
      continue;
    }
    const bad = mine.find((j) => j.status !== "completed" || j.conclusion !== "success");
    if (bad) {
      const state = bad.status !== "completed" ? bad.status : String(bad.conclusion);
      checks[name] = state;
      codes.push(`NOT_SUCCESS ${name}=${state}`);
    } else {
      checks[name] = "success";
    }
  }
  return { codes, checks };
}

export type GhApi = (path: string, fields: Record<string, string>) => Promise<unknown>;

export function parseArgs(argv: string[]): { sha: string; repo: string } | { error: string } {
  let repo = DEFAULT_REPO;
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "--repo") {
      const v = argv[++i];
      if (v === undefined) return { error: "USAGE --repo needs owner/name" };
      repo = v;
    } else {
      rest.push(a);
    }
  }
  if (rest.length !== 1)
    return { error: "USAGE ci-required-green.sh <40-hex sha> [--repo owner/name]" };
  const sha = (rest[0] as string).toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(sha)) return { error: "USAGE the commit must be a full 40-hex sha" };
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo))
    return { error: "USAGE --repo must be owner/name" };
  return { sha, repo };
}

export async function requiredGreen(sha: string, repo: string, gh: GhApi): Promise<Verdict> {
  const workflow = CI_WORKFLOW_PATH.split("/").pop() as string;
  const runsPage = await gh(`repos/${repo}/actions/workflows/${workflow}/runs`, {
    head_sha: sha,
    event: "push",
    branch: "main",
    per_page: String(PER_PAGE),
  });
  const { run, codes } = pickMainRun(sha, runsPage);
  if (!run) return { green: false, codes, runId: null, checks: {} };
  const jobsPage = await gh(`repos/${repo}/actions/runs/${run.id}/jobs`, {
    filter: "latest",
    per_page: String(PER_PAGE),
  });
  const judged = judgeJobs(jobsPage);
  return {
    green: judged.codes.length === 0,
    codes: judged.codes,
    runId: run.id,
    checks: judged.checks,
  };
}

/** `gh api -X GET <path> -f k=v ...`, no shell; a non-zero exit or non-JSON answer throws. */
export const ghCli: GhApi = (path, fields) =>
  new Promise((resolve, reject) => {
    const args = ["api", "-X", "GET", path];
    for (const [k, v] of Object.entries(fields)) args.push("-f", `${k}=${v}`);
    execFile("gh", args, { maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => {
      if (err) {
        reject(new Error("GH_FAILED"));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error("GH_NOT_JSON"));
      }
    });
  });

export async function main(
  argv: string[],
  io: { out: (s: string) => void; err: (s: string) => void },
  gh: GhApi = ghCli,
): Promise<number> {
  const args = parseArgs(argv);
  if ("error" in args) {
    io.err(args.error);
    return EXIT.usage;
  }
  let verdict: Verdict;
  try {
    verdict = await requiredGreen(args.sha, args.repo, gh);
  } catch (e) {
    const code = e instanceof Error && /^GH_[A-Z_]+$/.test(e.message) ? e.message : "LOOKUP_FAILED";
    io.err(`LOOKUP_FAILED ${code}`);
    return EXIT.lookup;
  }
  for (const name of REQUIRED_CHECKS) {
    if (name in verdict.checks) io.out(`${name}: ${verdict.checks[name]}`);
  }
  const unreadable = verdict.codes.some((c) => /^(RUNS|JOBS)_(UNREADABLE|TRUNCATED)$/.test(c));
  if (verdict.green) {
    io.out(`REQUIRED_GREEN ${args.sha} run ${verdict.runId}`);
    return EXIT.green;
  }
  io.out(
    `NOT_GREEN ${args.sha}${verdict.runId ? ` run ${verdict.runId}` : ""}: ${verdict.codes.join("; ")}`,
  );
  return unreadable ? EXIT.lookup : EXIT.notGreen;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2), {
    out: (s) => process.stdout.write(`${s}\n`),
    err: (s) => process.stderr.write(`${s}\n`),
  });
}
