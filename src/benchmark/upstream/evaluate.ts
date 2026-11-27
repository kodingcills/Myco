/**
 * MOCK plumbing proof only: run a public-benchmark metric function from the pinned upstream
 * checkout, unmodified, on SCRIPTED end-state files (#682 item 3). NEVER R1 evidence.
 *
 * Under the lead's 13:55Z harness ruling, R1 ground truth is OSWorld's own evaluation path,
 * `DesktopEnv.evaluate()` with its own getters and postconfig, executed by its in-VM
 * controller inside OSWorld's runner; Myco only reads the score that path wrote
 * (`./r1-grade.ts`). This module stands in for the upstream getters with local files, which
 * is exactly what R1 grading must never do, so it is restricted by type to `MOCK` end states
 * and stamps `upstream-metric-mock/1`, a grader version `./prereg.ts` refuses as evidence.
 * It stays because it proves, without a VM, that the pinned metric code runs unmodified and
 * that Myco reads its scores and the FAIL-action rule the way upstream does.
 *
 * What it does:
 *  - checks the task file and every evaluator file against the manifest's SHA-256 (a moved
 *    byte is `ungradable`, never a pass);
 *  - reads the evaluator config (functions, options, conj, getters) from the upstream task
 *    file itself, so nothing about the check is restated here;
 *  - stands in for the upstream getters with scripted files (MOCK only, see above);
 *  - applies upstream's FAIL-action rule (DesktopEnv.evaluate: an `infeasible` task passes
 *    only on a final FAIL action; any other task fails on one);
 *  - maps the upstream score to a verdict: `pass` iff the score is exactly 1.0.
 *
 * Independence: it never receives an agent claim or a gate verdict, imports nothing from
 * src/gate, src/gate-hooks, src/verify, src/tasks or the gating oracle, and the gate never
 * imports it (test/benchmark/independence.test.ts).
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { sha256Hex, type UpstreamManifest, type UpstreamTask } from "./import.ts";

export const UPSTREAM_METRIC_MOCK_VERSION = "upstream-metric-mock/1";
export const UPSTREAM_PASS_SCORE = 1.0;

const DRIVER = resolve(import.meta.dirname, "run_upstream_metric.py");

/** Getters whose return value the end state supplies as a captured local file path. */
const FILE_GETTERS = new Set(["vm_file", "cloud_file", "local_file"]);
/** Getters whose return value is the task's own constant (`get_rule` returns config.rules). */
const RULE_GETTERS = new Set(["rule", "rules"]);

export type EndStateValue = string | readonly (string | null)[] | null;

export interface UpstreamEndState {
  /** Always `MOCK`: a scripted end state, plumbing only. This path is never R1 evidence. */
  readonly label: "MOCK";
  /** One per upstream result getter, in order: captured file path(s), null if not captured. */
  readonly results: readonly EndStateValue[];
  /** One per upstream expected getter, in order: file path(s) for file getters, null for rules. */
  readonly expected: readonly EndStateValue[];
  /** The agent's final action as upstream records it (`FAIL`, `DONE`, ...), if any. */
  readonly lastAction: string | null;
}

export interface UpstreamGradeInput {
  /** The pinned upstream checkout root. */
  readonly root: string;
  readonly manifest: UpstreamManifest;
  readonly task: UpstreamTask;
  readonly endState: UpstreamEndState;
  /** Python interpreter with the upstream evaluator's dependencies (default `python3`). */
  readonly python?: string;
  readonly timeoutMs?: number;
}

export interface UpstreamVerdict {
  readonly graderVersion: typeof UPSTREAM_METRIC_MOCK_VERSION;
  readonly taskSetVersion: string;
  readonly taskId: string;
  readonly label: "MOCK";
  readonly status: "pass" | "fail" | "ungradable";
  /** The upstream evaluator's own score, or null when it did not run. */
  readonly upstreamScore: number | null;
  /** Codes only. */
  readonly codes: readonly string[];
}

function asList<T>(v: T | readonly T[] | undefined | null): T[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? [...(v as T[])] : [v as T];
}

export function gradeUpstreamTask(input: UpstreamGradeInput): UpstreamVerdict {
  const { root, manifest, task, endState } = input;
  const verdict = (
    status: UpstreamVerdict["status"],
    upstreamScore: number | null,
    codes: string[],
  ): UpstreamVerdict => ({
    graderVersion: UPSTREAM_METRIC_MOCK_VERSION,
    taskSetVersion: task.taskSetVersion,
    taskId: task.taskId,
    label: endState.label,
    status,
    upstreamScore,
    codes,
  });
  const ungradable = (code: string) => verdict("ungradable", null, [code]);

  if (task.taskSetVersion !== manifest.taskSetVersion) return ungradable("TASK_NOT_IN_MANIFEST");
  const files: Record<string, string> = {};
  for (const f of task.evaluator.files) {
    const digest = manifest.evaluatorFiles[f];
    if (digest === undefined) return ungradable("EVALUATOR_NOT_IN_MANIFEST");
    files[f] = digest;
  }

  let raw: Buffer;
  try {
    raw = readFileSync(join(root, task.taskFile));
  } catch {
    return ungradable("TASK_FILE_MISSING");
  }
  if (sha256Hex(raw) !== task.taskFileSha256) return ungradable("TASK_FILE_HASH_MISMATCH");
  let ev: Record<string, unknown>;
  try {
    ev = (JSON.parse(raw.toString("utf8")) as { evaluator: Record<string, unknown> }).evaluator;
  } catch {
    return ungradable("TASK_FILE_UNREADABLE");
  }

  const funcs = asList(ev.func as string | string[]);
  // Upstream DesktopEnv.evaluate(): the FAIL-action rule runs before any metric.
  const failed = endState.lastAction === "FAIL";
  if (funcs.length === 1 && funcs[0] === "infeasible")
    return failed
      ? verdict("pass", 1, ["INFEASIBLE_AGENT_FAILED"])
      : verdict("fail", 0, ["INFEASIBLE_AGENT_DID_NOT_FAIL"]);
  if (failed) return verdict("fail", 0, ["AGENT_FAIL_ACTION"]);

  const multi = Array.isArray(ev.func);
  const resultCfg = asList(ev.result as Record<string, unknown>[]);
  const expectedCfg = asList(ev.expected as Record<string, unknown>[]);
  const options = multi
    ? asList(ev.options as Record<string, unknown>[])
    : [(ev.options as Record<string, unknown>) ?? {}];
  const hasExpected = "expected" in ev && expectedCfg.length > 0;
  if (resultCfg.length !== funcs.length) return ungradable("RESULT_GETTER_COUNT");
  if (hasExpected && expectedCfg.length !== funcs.length)
    return ungradable("EXPECTED_GETTER_COUNT");
  if (endState.results.length !== funcs.length) return ungradable("END_STATE_RESULT_COUNT");

  const metrics = [];
  for (let i = 0; i < funcs.length; i++) {
    const rType = String(resultCfg[i]?.type);
    if (!FILE_GETTERS.has(rType)) return ungradable(`GETTER_NOT_SUPPORTED:${rType}`);
    let expected: unknown = null;
    if (hasExpected) {
      const eCfg = expectedCfg[i] as Record<string, unknown>;
      const eType = String(eCfg?.type);
      if (RULE_GETTERS.has(eType)) expected = eCfg.rules;
      else if (FILE_GETTERS.has(eType)) {
        expected = endState.expected[i] ?? null;
        if (expected === null) return ungradable("EXPECTED_FILE_NOT_SUPPLIED");
      } else return ungradable(`GETTER_NOT_SUPPORTED:${eType}`);
    }
    metrics.push({
      module: task.evaluator.modules[i],
      func: funcs[i],
      result: endState.results[i] ?? null,
      expected,
      hasExpected,
      options: options[i] ?? {},
    });
  }

  const spec = {
    root: resolve(root),
    metricsDir: manifest.metricsDir,
    metricsPackage: manifest.metricsPackage,
    files,
    conj: task.evaluator.conj,
    metrics,
  };
  const dir = mkdtempSync(join(tmpdir(), "myco-upstream-"));
  try {
    const specPath = join(dir, "spec.json");
    writeFileSync(specPath, JSON.stringify(spec));
    const run = spawnSync(input.python ?? "python3", ["-I", DRIVER, specPath], {
      encoding: "utf8",
      timeout: input.timeoutMs ?? 120_000,
      killSignal: "SIGKILL",
      maxBuffer: 1 << 20,
      // No host environment reaches the evaluator: a fixed PATH and a private HOME only.
      env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: dir, LANG: "C.UTF-8" },
    });
    if (run.error || run.status !== 0) return ungradable("EVALUATOR_PROCESS_FAILED");
    const last = run.stdout.trim().split("\n").pop() ?? "";
    let out: { ok: boolean; score?: unknown; code?: unknown };
    try {
      out = JSON.parse(last);
    } catch {
      return ungradable("EVALUATOR_OUTPUT_UNREADABLE");
    }
    if (!out.ok) return ungradable(typeof out.code === "string" ? out.code : "EVALUATOR_FAILED");
    if (typeof out.score !== "number" || !Number.isFinite(out.score))
      return ungradable("EVALUATOR_SCORE_INVALID");
    return out.score === UPSTREAM_PASS_SCORE
      ? verdict("pass", out.score, ["UPSTREAM_SCORE_FULL"])
      : verdict("fail", out.score, ["UPSTREAM_SCORE_NOT_FULL"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
