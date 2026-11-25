/**
 * The gate (TIF-265 / M2-02): runs the oracle on persisted state and returns a
 * `GateResult`. See `api.ts` for the contract and the trust split.
 *
 * Invariant: `verified` is produced in exactly one place, `verdictFromOracle`, from a
 * validated oracle output whose status is `verified`. Every other path (bad request,
 * unknown task, missing/unreadable/corrupt state, oracle throw, malformed oracle output,
 * audit failure) yields `uncertain`. `accepted` is derived from the verdict and the
 * `ORACLE_PASS` code together, never set independently.
 */
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import {
  type EvidenceRef,
  GATE_API_VERSION,
  type GateResult,
  type GateVerdict,
  isSafeId,
  parseGateRequest,
  type ReasonCode,
} from "./api.ts";
import { FAMILIES, type OracleFamily, type OracleOutput, StateCorruptError } from "./families.ts";

// ---------------------------------------------------------------------------
// Operator side: task registry and evidence reader
// ---------------------------------------------------------------------------

/** One task as the operator registers it. */
export interface TaskEntry {
  readonly id: string;
  readonly family: string;
  /** Persisted-state file, relative to the run's evidence location. */
  readonly stateFile: string;
  /** The family's spec: what "done" means. Operator-owned; the agent never sees or sends it. */
  readonly spec: unknown;
  readonly title?: string;
}

export interface GateTask {
  readonly id: string;
  readonly family: OracleFamily;
  readonly stateFile: string;
  readonly spec: unknown;
  readonly specSha256: string;
  readonly title?: string;
}

export type TaskRegistry = ReadonlyMap<string, GateTask>;

function isSafeRelativePath(path: string): boolean {
  if (path.length === 0 || isAbsolute(path) || path.includes("\\")) return false;
  return path
    .split("/")
    .every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

/** Canonical JSON: object keys sorted, so the spec digest does not depend on key order. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function sha256(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Build the registry, validating every entry. Throws with every problem listed. */
export function buildRegistry(
  entries: readonly TaskEntry[],
  families: ReadonlyMap<string, OracleFamily> = FAMILIES,
): TaskRegistry {
  const problems: string[] = [];
  const out = new Map<string, GateTask>();
  for (const entry of entries) {
    const where = `task ${JSON.stringify(entry.id)}`;
    if (typeof entry.id !== "string" || !isSafeId(entry.id)) {
      problems.push(`${where}: id must match [A-Za-z0-9._-] and start with a letter or digit`);
      continue;
    }
    if (out.has(entry.id)) problems.push(`${where}: duplicate id`);
    const family = families.get(entry.family);
    if (!family) {
      problems.push(`${where}: unknown family ${JSON.stringify(entry.family)}`);
      continue;
    }
    if (typeof entry.stateFile !== "string" || !isSafeRelativePath(entry.stateFile)) {
      problems.push(`${where}: stateFile must be a relative path without "." or ".." segments`);
      continue;
    }
    const specProblem = family.checkSpec(entry.spec);
    if (specProblem) {
      problems.push(`${where}: ${specProblem}`);
      continue;
    }
    const spec = structuredClone(entry.spec);
    out.set(entry.id, {
      id: entry.id,
      family,
      stateFile: entry.stateFile,
      spec,
      specSha256: sha256(canonical(spec)),
      ...(entry.title === undefined ? {} : { title: entry.title }),
    });
  }
  if (problems.length > 0)
    throw new Error(`invalid gate task registry:\n  ${problems.join("\n  ")}`);
  return out;
}

export type ReadOutcome =
  | { readonly ok: true; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly cause: "missing" | "unreadable"; readonly detail: string };

/**
 * Where the gate reads persisted state from. Operator-bound: the agent names a run, the
 * reader decides what that means. M2-12's live reader implements this over the
 * runtime's `read_file`; TIF-266 makes the location unwritable from the agent's tools.
 */
export interface EvidenceReader {
  /** A description of the location for logs (never agent-controlled). */
  readonly describe: string;
  read(runId: string, stateFile: string): Promise<ReadOutcome>;
}

export const STATE_FILE_LIMIT = 16 * 1024 * 1024;

/**
 * Reads `<root>/<runId>/<stateFile>`. Every path component below `root` must be a real
 * directory or file: a symlink anywhere below the root is refused (STATE_UNREADABLE), so a
 * run cannot borrow another run's state, inside or outside the root. The final file is
 * opened with O_NOFOLLOW and checked through its descriptor, so it cannot be swapped for a
 * link between the check and the read. `root` itself may be a symlink: the operator chose it.
 */
export function fileEvidenceReader(root: string): EvidenceReader {
  const absoluteRoot = resolve(root);
  return {
    describe: absoluteRoot,
    async read(runId, stateFile) {
      if (!isSafeId(runId) || !isSafeRelativePath(stateFile)) {
        return { ok: false, cause: "unreadable", detail: "path is not a safe relative path" };
      }
      const where = `${runId}/${stateFile}`;
      const segments = [runId, ...stateFile.split("/")];
      let path = absoluteRoot;
      for (const [index, segment] of segments.entries()) {
        path = join(path, segment);
        let stat: ReturnType<typeof lstatSync>;
        try {
          stat = lstatSync(path);
        } catch {
          return { ok: false, cause: "missing", detail: `${where} does not exist` };
        }
        if (stat.isSymbolicLink()) {
          return { ok: false, cause: "unreadable", detail: `${where} passes through a symlink` };
        }
        if (index < segments.length - 1 && !stat.isDirectory()) {
          return {
            ok: false,
            cause: "unreadable",
            detail: `${where}: ${segment} is not a directory`,
          };
        }
      }
      let fd: number;
      try {
        fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      } catch (error) {
        return { ok: false, cause: "unreadable", detail: `open failed: ${String(error)}` };
      }
      try {
        const stat = fstatSync(fd);
        if (!stat.isFile())
          return { ok: false, cause: "unreadable", detail: `${where} is not a file` };
        if (stat.size > STATE_FILE_LIMIT) {
          return { ok: false, cause: "unreadable", detail: `${where} is too large` };
        }
        return { ok: true, bytes: new Uint8Array(readFileSync(fd)) };
      } catch (error) {
        return { ok: false, cause: "unreadable", detail: `read failed: ${String(error)}` };
      } finally {
        closeSync(fd);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

/**
 * The trial this gate serves: the one task and run the agent was assigned. Operator-only.
 * A request naming any other task or run is `uncertain` with ASSIGNMENT_MISMATCH and
 * nothing is read, so an agent cannot borrow another run's passing state. This is the
 * trial identity TIF-266's vault keys its receipt on: the reader for a bound gate only
 * ever sees `assignment.runId`.
 */
export interface Assignment {
  readonly taskId: string;
  readonly runId: string;
}

export interface GateConfig {
  readonly tasks: TaskRegistry;
  readonly reader: EvidenceReader;
  /** Required: one gate per trial. Build another gate for another trial. */
  readonly assignment: Assignment;
  readonly now?: () => Date;
  /** How long the reader may take before the result is `uncertain` STATE_UNREADABLE. */
  readonly readTimeoutMs?: number;
  /**
   * Called with every result before it is returned (the decision log for R1), and awaited.
   * If it throws or its promise rejects, the gate fails closed: the result becomes
   * `uncertain` with AUDIT_FAILED.
   */
  readonly onDecision?: (result: GateResult) => void | Promise<void>;
}

export const DEFAULT_READ_TIMEOUT_MS = 30_000;

export interface Gate {
  readonly apiVersion: typeof GATE_API_VERSION;
  /** Total: never throws, never rejects. Any input yields a `GateResult`. */
  check(raw: unknown): Promise<GateResult>;
}

/** Narrow an oracle's return value; anything malformed is not a verdict. */
function validOracleOutput(value: unknown): OracleOutput | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  if (typeof (value as { then?: unknown }).then === "function") return undefined;
  const { status, reasons } = value as { status?: unknown; reasons?: unknown };
  if (status !== "verified" && status !== "refuted" && status !== "uncertain") return undefined;
  if (!Array.isArray(reasons) || !reasons.every((r) => typeof r === "string")) return undefined;
  return { status, reasons: [...reasons] };
}

/** The one place a `verified` verdict can come from. */
function verdictFromOracle(output: OracleOutput): { verdict: GateVerdict; code: ReasonCode } {
  switch (output.status) {
    case "verified":
      return { verdict: "verified", code: "ORACLE_PASS" };
    case "refuted":
      return { verdict: "refuted", code: "ORACLE_FAIL" };
    case "uncertain":
      return { verdict: "uncertain", code: "ORACLE_UNCERTAIN" };
  }
}

/** Read with a deadline; a hung reader becomes `unreadable`, never a pending call. */
async function readWithin(
  reader: EvidenceReader,
  runId: string,
  stateFile: string,
  timeoutMs: number,
): Promise<ReadOutcome> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<ReadOutcome>((done) => {
    timer = setTimeout(
      () =>
        done({ ok: false, cause: "unreadable", detail: `reader timed out after ${timeoutMs} ms` }),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([
      reader.read(runId, stateFile).catch(
        (error): ReadOutcome => ({
          ok: false,
          cause: "unreadable",
          detail: `reader threw: ${String(error)}`,
        }),
      ),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Throws when the assignment is unusable, so a misconfigured gate never starts. */
function checkAssignment(config: GateConfig): void {
  const { taskId, runId } = config.assignment ?? {};
  if (
    typeof taskId !== "string" ||
    !isSafeId(taskId) ||
    typeof runId !== "string" ||
    !isSafeId(runId)
  ) {
    throw new Error("invalid gate assignment: taskId and runId must be safe ids");
  }
  if (!config.tasks.has(taskId)) {
    throw new Error(
      `invalid gate assignment: task ${JSON.stringify(taskId)} is not in the registry`,
    );
  }
}

export function createGate(config: GateConfig): Gate {
  checkAssignment(config);
  const assignment = { ...config.assignment };
  const now = config.now ?? (() => new Date());
  const readTimeoutMs = config.readTimeoutMs ?? DEFAULT_READ_TIMEOUT_MS;

  async function finish(parts: {
    verdict: GateVerdict;
    codes: ReasonCode[];
    reasons: string[];
    request: GateResult["request"];
    refs?: EvidenceRef[];
    oracle?: GateResult["oracle"];
  }): Promise<GateResult> {
    const codes = [...parts.codes];
    if (parts.request.claim !== undefined) codes.push("CLAIM_RECORDED");
    const accepted =
      parts.verdict === "verified" && parts.oracle !== undefined && codes.includes("ORACLE_PASS");
    const result: GateResult = {
      apiVersion: GATE_API_VERSION,
      verdict: accepted ? "verified" : parts.verdict === "verified" ? "uncertain" : parts.verdict,
      accepted,
      reasonCodes: codes,
      reasons: parts.reasons,
      evidenceRefs: parts.refs ?? [],
      request: parts.request,
      ...(parts.oracle ? { oracle: parts.oracle } : {}),
      checkedAt: now().toISOString(),
    };
    if (!config.onDecision) return result;
    try {
      await config.onDecision(result);
      return result;
    } catch (error) {
      return {
        ...result,
        verdict: "uncertain",
        accepted: false,
        reasonCodes: [...result.reasonCodes, "AUDIT_FAILED"],
        reasons: [...result.reasons, `decision log write failed: ${String(error)}`],
      };
    }
  }

  async function decide(raw: unknown): Promise<GateResult> {
    const parsed = parseGateRequest(raw);
    if (!parsed.ok) {
      return finish({
        verdict: "uncertain",
        codes: [parsed.code],
        reasons: [parsed.reason],
        request: parsed.partial,
      });
    }
    const { taskId, runId } = parsed.request;
    const request = {
      taskId,
      runId,
      ...(parsed.request.claim === undefined ? {} : { claim: parsed.request.claim }),
    };
    if (taskId !== assignment.taskId || runId !== assignment.runId) {
      return finish({
        verdict: "uncertain",
        codes: ["ASSIGNMENT_MISMATCH"],
        reasons: [
          `this gate serves task ${JSON.stringify(assignment.taskId)}, run ${JSON.stringify(assignment.runId)}; the request named task ${JSON.stringify(taskId)}, run ${JSON.stringify(runId)}`,
        ],
        request,
      });
    }
    const task = config.tasks.get(taskId);
    if (!task) {
      return finish({
        verdict: "uncertain",
        codes: ["UNKNOWN_TASK"],
        reasons: [`no task ${JSON.stringify(taskId)} in the gate's registry`],
        request,
      });
    }

    const read = await readWithin(config.reader, runId, task.stateFile, readTimeoutMs);
    if (!read.ok) {
      return finish({
        verdict: "uncertain",
        codes: [read.cause === "missing" ? "STATE_MISSING" : "STATE_UNREADABLE"],
        reasons: [`could not look: ${read.detail}`],
        request,
      });
    }
    const refs: EvidenceRef[] = [
      {
        kind: "persisted-state",
        runId,
        path: task.stateFile,
        sha256: sha256(read.bytes),
        bytes: read.bytes.length,
      },
    ];
    const oracle = {
      family: task.family.id,
      version: task.family.version,
      specSha256: task.specSha256,
    };

    let valid: OracleOutput | undefined;
    try {
      // A fresh copy of the spec per call: an oracle that mutates its input cannot
      // change what the next call checks.
      const output: unknown = task.family.decide(
        read.bytes,
        structuredClone(task.spec),
        `${runId}/${task.stateFile}`,
      );
      // Inside the try: a throwing getter on the output is an oracle error, and the
      // result keeps its request and evidence refs.
      valid = validOracleOutput(output);
    } catch (error) {
      const corrupt = error instanceof StateCorruptError;
      return finish({
        verdict: "uncertain",
        codes: [corrupt ? "STATE_CORRUPT" : "ORACLE_ERROR"],
        reasons: [corrupt ? `could not look: ${error.message}` : `oracle threw: ${String(error)}`],
        request,
        refs,
      });
    }
    if (!valid) {
      return finish({
        verdict: "uncertain",
        codes: ["ORACLE_INVALID_OUTPUT"],
        reasons: ["oracle returned a value that is not a well-formed verdict"],
        request,
        refs,
      });
    }
    const { verdict, code } = verdictFromOracle(valid);
    return finish({ verdict, codes: [code], reasons: [...valid.reasons], request, refs, oracle });
  }

  return {
    apiVersion: GATE_API_VERSION,
    async check(raw) {
      try {
        return await decide(raw);
      } catch (error) {
        // Unreachable by construction; kept so `check` stays total if a future edit throws.
        return finish({
          verdict: "uncertain",
          codes: ["ORACLE_ERROR"],
          reasons: [`gate error: ${String(error)}`],
          request: {},
        });
      }
    },
  };
}
