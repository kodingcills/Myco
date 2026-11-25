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
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
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

/** Reads `<root>/<runId>/<stateFile>`, refusing anything that resolves outside `root`. */
export function fileEvidenceReader(root: string): EvidenceReader {
  const absoluteRoot = resolve(root);
  return {
    describe: absoluteRoot,
    async read(runId, stateFile) {
      if (!isSafeId(runId) || !isSafeRelativePath(stateFile)) {
        return { ok: false, cause: "unreadable", detail: "path is not a safe relative path" };
      }
      const target = join(absoluteRoot, runId, stateFile);
      try {
        lstatSync(target);
      } catch {
        return { ok: false, cause: "missing", detail: `${runId}/${stateFile} does not exist` };
      }
      try {
        const realRoot = realpathSync(absoluteRoot);
        const realTarget = realpathSync(target);
        if (!realTarget.startsWith(`${realRoot}${sep}`)) {
          return {
            ok: false,
            cause: "unreadable",
            detail: `${runId}/${stateFile} resolves outside the evidence root`,
          };
        }
        const stat = lstatSync(realTarget);
        if (!stat.isFile()) {
          return { ok: false, cause: "unreadable", detail: `${runId}/${stateFile} is not a file` };
        }
        if (stat.size > STATE_FILE_LIMIT) {
          return { ok: false, cause: "unreadable", detail: `${runId}/${stateFile} is too large` };
        }
        return { ok: true, bytes: new Uint8Array(readFileSync(realTarget)) };
      } catch (error) {
        return { ok: false, cause: "unreadable", detail: `read failed: ${String(error)}` };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

export interface GateConfig {
  readonly tasks: TaskRegistry;
  readonly reader: EvidenceReader;
  readonly now?: () => Date;
  /**
   * Called with every result before it is returned (the decision log for R1). If it
   * throws, the gate fails closed: the result becomes `uncertain` with AUDIT_FAILED.
   */
  readonly onDecision?: (result: GateResult) => void;
}

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

export function createGate(config: GateConfig): Gate {
  const now = config.now ?? (() => new Date());

  function finish(parts: {
    verdict: GateVerdict;
    codes: ReasonCode[];
    reasons: string[];
    request: GateResult["request"];
    refs?: EvidenceRef[];
    oracle?: GateResult["oracle"];
  }): GateResult {
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
      config.onDecision(result);
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
    const task = config.tasks.get(taskId);
    if (!task) {
      return finish({
        verdict: "uncertain",
        codes: ["UNKNOWN_TASK"],
        reasons: [`no task ${JSON.stringify(taskId)} in the gate's registry`],
        request,
      });
    }

    let read: ReadOutcome;
    try {
      read = await config.reader.read(runId, task.stateFile);
    } catch (error) {
      read = { ok: false, cause: "unreadable", detail: `reader threw: ${String(error)}` };
    }
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

    let output: unknown;
    try {
      // A fresh copy of the spec per call: an oracle that mutates its input cannot
      // change what the next call checks.
      output = task.family.decide(
        read.bytes,
        structuredClone(task.spec),
        `${runId}/${task.stateFile}`,
      );
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
    const valid = validOracleOutput(output);
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
