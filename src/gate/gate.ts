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
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readlinkSync,
  realpathSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import {
  type CheckpointSummary,
  type CheckpointVerdict,
  type EvidenceRef,
  GATE_API_VERSION,
  type GateResult,
  type GateVerdict,
  isSafeId,
  ORACLE_DETAIL_CODES,
  type OracleDetailCode,
  parseGateRequest,
  type ReasonCode,
} from "./api.ts";
import { FAMILIES, type OracleFamily, type OracleOutput, StateCorruptError } from "./families.ts";
import { errorCode } from "./reasons.ts";

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

/** The digest `buildRegistry` records as a task's `specSha256` (canonical JSON, sha256). */
export function specDigest(spec: unknown): string {
  return sha256(canonical(spec));
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
    const specProblem =
      family.checkSpec(entry.spec) ?? family.checkStateFile?.(entry.stateFile, entry.spec);
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
      specSha256: specDigest(spec),
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
 * Where the gate reads persisted state from: an operator-configured host location that a
 * harness fills per trial after the agent stops (a capture of the saved file), never the
 * live guest and never anything the agent can write. The agent names a run; the reader
 * decides what that means. A gated run uses `sealedEvidenceReader` (`./sealed.ts`), which
 * reads only the bound trial's sealed host capture from TIF-266's vault;
 * `fileEvidenceReader` is the mock-path and development stand-in only.
 */
export interface EvidenceReader {
  /** A description of the location for logs (never agent-controlled). */
  readonly describe: string;
  /**
   * `detail` of a failed outcome reaches the agent (as "could not look: <detail>"), so it
   * must name paths relative to the run and never carry a host path or a raw error
   * message (see `errorCode`). A reader that throws or rejects is reported by error code
   * only.
   */
  read(runId: string, stateFile: string): Promise<ReadOutcome>;
  /**
   * The operator's sealed fixture `file` for the run: the exact document the guest was given
   * (TIF-270 round 3). Asked for only when the task's spec names one (`fixtureFile` +
   * `fixtureSha256`); the gate checks the bytes against the spec's digest before any oracle
   * sees them. A reader without this method cannot serve such a task (FIXTURE_UNREADABLE).
   * Same `detail` rules as `read`.
   */
  readFixture?(runId: string, file: string): Promise<ReadOutcome>;
}

export const STATE_FILE_LIMIT = 16 * 1024 * 1024;

/**
 * Test seams, used to swap path components deterministically. Operator code never needs
 * them; the agent cannot reach them (it only sends a request).
 */
export interface FileReaderHooks {
  /** Runs before each `lstat` of a walk, with the path about to be checked. */
  readonly beforeLstat?: (path: string) => void;
  /** Runs after the first walk and before `open`. */
  readonly beforeOpen?: () => void;
  /** Runs after `open` and the descriptor checks, before the second walk. */
  readonly afterOpen?: () => void;
  /** Runs after the second walk and the dev/ino check, right before the descriptor-path binding. */
  readonly beforeBind?: () => void;
  /**
   * The platform whose descriptor-path binding applies (default `process.platform`). Tests
   * set "darwin" on Linux to show the gap the binding closes.
   */
  readonly platform?: NodeJS.Platform;
  /** Where descriptor paths are read on Linux (default `/proc/self/fd`). */
  readonly procFdDir?: string;
}

type Walk =
  | { readonly ok: true; readonly final: { readonly dev: number; readonly ino: number } }
  | { readonly ok: false; readonly cause: "missing" | "unreadable"; readonly detail: string };

/**
 * lstat every component of `<root>/<segments...>`: no symlink anywhere, every intermediate
 * a directory, the final component a regular file (so a FIFO or device is refused before
 * any `open` could block).
 */
function walk(
  root: string,
  segments: readonly string[],
  where: string,
  beforeLstat?: (path: string) => void,
): Walk {
  let path = root;
  let final = { dev: -1, ino: -1 };
  for (const [index, segment] of segments.entries()) {
    path = join(path, segment);
    let stat: ReturnType<typeof lstatSync>;
    beforeLstat?.(path);
    try {
      stat = lstatSync(path);
    } catch {
      return { ok: false, cause: "missing", detail: `${where} does not exist` };
    }
    if (stat.isSymbolicLink()) {
      return {
        ok: false,
        cause: "unreadable",
        detail: `${where} passes through a symlink at ${segment}`,
      };
    }
    const last = index === segments.length - 1;
    if (!last && !stat.isDirectory()) {
      return { ok: false, cause: "unreadable", detail: `${where}: ${segment} is not a directory` };
    }
    if (last && !stat.isFile()) {
      return { ok: false, cause: "unreadable", detail: `${where} is not a regular file` };
    }
    if (last) final = { dev: stat.dev, ino: stat.ino };
  }
  return { ok: true, final };
}

/**
 * Linux: require the kernel's path for the open descriptor to be the expected path under
 * the real root. Fails closed if /proc cannot be read. Other platforms: no binding (see
 * `fileEvidenceReader`).
 */
function bindDescriptorPath(
  fd: number,
  absoluteRoot: string,
  segments: readonly string[],
  where: string,
  hooks: FileReaderHooks,
):
  | { readonly ok: true }
  | { readonly ok: false; readonly cause: "unreadable"; readonly detail: string } {
  if ((hooks.platform ?? process.platform) !== "linux") return { ok: true };
  let realRoot: string;
  let actual: string;
  try {
    realRoot = realpathSync(absoluteRoot);
  } catch (error) {
    return {
      ok: false,
      cause: "unreadable",
      detail: `${where}: cannot resolve the evidence root (realpath failed: ${errorCode(error)})`,
    };
  }
  try {
    actual = readlinkSync(join(hooks.procFdDir ?? "/proc/self/fd", String(fd)));
  } catch (error) {
    return {
      ok: false,
      cause: "unreadable",
      detail: `${where}: cannot bind the descriptor to its path (/proc/self/fd: ${errorCode(error)})`,
    };
  }
  if (actual !== join(realRoot, ...segments)) {
    // Report the path relative to the root: reasons reach the agent, host paths need not.
    const shown = actual.startsWith(`${realRoot}/`)
      ? actual.slice(realRoot.length + 1)
      : "a path outside the evidence root";
    return {
      ok: false,
      cause: "unreadable",
      detail: `${where}: the opened file is at ${shown}, not at ${where} (descriptor path check)`,
    };
  }
  return { ok: true };
}

/**
 * Reads `<root>/<runId>/<stateFile>`, refusing a symlink below `root`. `root` itself may be
 * a symlink: the operator chose it.
 *
 * Node has no `openat`, so the reader cannot descend from directory descriptors. Instead:
 *  1. walk: lstat every component (no symlink, directories, then a regular file);
 *  2. open the path with O_NOFOLLOW (a final-component symlink fails) and O_NONBLOCK (a FIFO
 *     swapped in after the walk returns at once instead of blocking), then fstat the
 *     descriptor: it must be a regular file within the size limit;
 *  3. walk again, and require the final component's dev/ino (from both walks) to equal the
 *     descriptor's;
 *  4. Linux only: bind the descriptor to its path. `readlink("/proc/self/fd/<fd>")` (the
 *     path the kernel says the open file is at) must equal
 *     `realpath(root)/<runId>/<stateFile>` exactly. If /proc cannot be read, or the root
 *     cannot be resolved, the read fails. A file unlinked after the open reads back as
 *     `<path> (deleted)`, so it fails too.
 * The bytes are read from the verified descriptor.
 *
 * What each platform guarantees (see docs/gate/api.md, "What the file reader guarantees"):
 *  - Both: a symlink present below the root when the reader looks is refused; a final
 *    component swapped for a symlink or FIFO during the read is refused; a run directory
 *    swapped for a symlink between steps is refused.
 *  - Linux: an INTERMEDIATE component (the run directory or a parent of the state file)
 *    swapped for a symlink to another run while a walk is in progress is refused too: the
 *    walks' lstat calls resolve intermediate components, so they and the dev/ino check can
 *    all agree on another run's file, but the descriptor's kernel path then names that
 *    other run and step 4 fails.
 *  - macOS and every other non-Linux platform (the binding is skipped): that race is NOT
 *    refused. A concurrent writer on the evidence root can make the reader return another
 *    run's bytes. Closing that race there needs fd-relative opens (or F_GETPATH), which
 *    Node lacks, so on these platforms the reader is not a defence against a concurrent
 *    writer.
 *  - Neither: a writer that puts a hard link, or another run's real directory or file,
 *    at the run's own path. At read time that IS the run's evidence; keeping writers off
 *    the root is TIF-266's job (and the host-capture requirement).
 * On every platform the gated path relies on host capture: the agent has no write access
 * to the evidence root, so nothing can swap components while the gate reads.
 *
 * Mock-path stand-in only: this reader is for `myco-gate demo --transport mock`, tests and
 * development. It checks paths, not provenance, so it is not acceptable for a gated run.
 * A gated run reads through `sealedEvidenceReader` (`./sealed.ts`): the bound trial's
 * sealed host capture, taken after the agent stopped (TIF-266, #470).
 *
 * All I/O here is synchronous and bounded by refusing non-regular files; `readTimeoutMs`
 * guards readers that return a pending promise, not a filesystem that blocks a syscall.
 */
export function fileEvidenceReader(root: string, hooks: FileReaderHooks = {}): EvidenceReader {
  const absoluteRoot = resolve(root);
  return {
    describe: absoluteRoot,
    async read(runId, stateFile) {
      if (!isSafeId(runId) || !isSafeRelativePath(stateFile)) {
        return { ok: false, cause: "unreadable", detail: "path is not a safe relative path" };
      }
      const where = `${runId}/${stateFile}`;
      const segments = [runId, ...stateFile.split("/")];
      const first = walk(absoluteRoot, segments, where, hooks.beforeLstat);
      if (!first.ok) return first;
      hooks.beforeOpen?.();
      let fd: number;
      try {
        fd = openSync(
          join(absoluteRoot, ...segments),
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
      } catch (error) {
        const code = (error as { code?: unknown }).code;
        return {
          ok: false,
          cause: code === "ENOENT" ? "missing" : "unreadable",
          detail:
            code === "ELOOP"
              ? `${where} is a symlink (refused at open)`
              : `${where}: open failed: ${errorCode(error)}`,
        };
      }
      try {
        const opened = fstatSync(fd);
        if (!opened.isFile()) {
          return { ok: false, cause: "unreadable", detail: `${where}: opened a non-regular file` };
        }
        if (opened.size > STATE_FILE_LIMIT) {
          return { ok: false, cause: "unreadable", detail: `${where} is too large` };
        }
        hooks.afterOpen?.();
        const second = walk(absoluteRoot, segments, where, hooks.beforeLstat);
        if (!second.ok) {
          return { ok: false, cause: "unreadable", detail: `${second.detail} (after open)` };
        }
        if (
          second.final.dev !== opened.dev ||
          second.final.ino !== opened.ino ||
          first.final.dev !== opened.dev ||
          first.final.ino !== opened.ino
        ) {
          return {
            ok: false,
            cause: "unreadable",
            detail: `${where} changed between the check and the open`,
          };
        }
        hooks.beforeBind?.();
        const bound = bindDescriptorPath(fd, absoluteRoot, segments, where, hooks);
        if (!bound.ok) return bound;
        return { ok: true, bytes: new Uint8Array(readFileSync(fd)) };
      } catch (error) {
        return {
          ok: false,
          cause: "unreadable",
          detail: `${where}: read failed: ${errorCode(error)}`,
        };
      } finally {
        closeSync(fd);
      }
    },
    // Mock path: the sealed fixture lives beside the state file under the run's directory,
    // read with the same walk. The gate's digest check is what makes it trustworthy.
    readFixture(runId, file) {
      return this.read(runId, file);
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
  /**
   * Operator-side diagnostics. Agent-facing reasons carry only an error code (see
   * `errorCode`), never a raw message, because a message can hold a host path. When the
   * reader throws, the oracle throws (or reports corrupt state with a `cause`), the
   * decision log fails, or the gate itself errors, this is called with the full error so
   * the operator can see it. It is never shown to the agent; the CLI writes it to stderr.
   * A throw here is ignored: diagnostics never change a verdict.
   */
  readonly onDiagnostic?: (diagnostic: GateDiagnostic) => void;
}

/** One operator-side diagnostic: where the error happened, its reason code, the raw error. */
export interface GateDiagnostic {
  readonly stage: "reader" | "oracle" | "decision-log" | "gate";
  /** The same code the agent-facing reason carries. */
  readonly code: string;
  /** The raw error, for the operator only. */
  readonly error: unknown;
}

export const DEFAULT_READ_TIMEOUT_MS = 30_000;

export interface Gate {
  readonly apiVersion: typeof GATE_API_VERSION;
  /** Total: never throws, never rejects. Any input yields a `GateResult`. */
  check(raw: unknown): Promise<GateResult>;
}

const MAX_CHECKPOINTS = 64;

/**
 * Narrow an oracle's return value; anything malformed is not a verdict. The TIF-270
 * fields are checked for consistency too, so a buggy oracle cannot pair `verified` with a
 * failure code or a refuted checkpoint:
 *  - `codes`: only `ORACLE_DETAIL_CODES`, no repeats, and only on `refuted`;
 *  - `checkpoints`: 1-64 entries numbered 1..n in order, each verified or refuted, with
 *    the last one equal to the status (so `uncertain` never carries checkpoints) and every
 *    one verified when the status is.
 */
function validOracleOutput(value: unknown): OracleOutput | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  if (typeof (value as { then?: unknown }).then === "function") return undefined;
  const { status, reasons, codes, checkpoints } = value as {
    status?: unknown;
    reasons?: unknown;
    codes?: unknown;
    checkpoints?: unknown;
  };
  if (status !== "verified" && status !== "refuted" && status !== "uncertain") return undefined;
  if (!Array.isArray(reasons) || !reasons.every((r) => typeof r === "string")) return undefined;
  let detail: OracleDetailCode[] | undefined;
  if (codes !== undefined) {
    if (!Array.isArray(codes) || status !== "refuted") return undefined;
    if (!codes.every((code) => (ORACLE_DETAIL_CODES as readonly unknown[]).includes(code)))
      return undefined;
    if (new Set(codes).size !== codes.length) return undefined;
    detail = [...(codes as OracleDetailCode[])];
  }
  let steps: CheckpointVerdict[] | undefined;
  if (checkpoints !== undefined) {
    if (
      !Array.isArray(checkpoints) ||
      checkpoints.length === 0 ||
      checkpoints.length > MAX_CHECKPOINTS
    )
      return undefined;
    steps = [];
    for (const [index, entry] of checkpoints.entries()) {
      if (typeof entry !== "object" || entry === null) return undefined;
      const { checkpoint, verdict } = entry as { checkpoint?: unknown; verdict?: unknown };
      if (checkpoint !== index + 1) return undefined;
      if (verdict !== "verified" && verdict !== "refuted") return undefined;
      steps.push({ checkpoint, verdict });
    }
    if (steps[steps.length - 1]?.verdict !== status) return undefined;
    if (status === "verified" && steps.some((cp) => cp.verdict !== "verified")) return undefined;
  }
  return {
    status,
    reasons: [...reasons],
    ...(detail ? { codes: detail } : {}),
    ...(steps ? { checkpoints: steps } : {}),
  };
}

/** The gate's own summary of an oracle's checkpoints: `lastVerified` is never taken on trust. */
function summarize(checkpoints: readonly CheckpointVerdict[]): CheckpointSummary {
  const firstRefuted = checkpoints.findIndex((cp) => cp.verdict !== "verified");
  return {
    total: checkpoints.length,
    lastVerified: firstRefuted === -1 ? checkpoints.length : firstRefuted,
    verdicts: checkpoints.map((cp) => ({ ...cp })),
  };
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
  read: () => Promise<ReadOutcome>,
  timeoutMs: number,
  diagnose: (stage: GateDiagnostic["stage"], error: unknown) => string,
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
      // Promise.resolve().then: a reader that throws synchronously is a reader error too.
      Promise.resolve()
        .then(read)
        .catch(
          (error): ReadOutcome => ({
            ok: false,
            cause: "unreadable",
            detail: `reader threw: ${diagnose("reader", error)}`,
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

  /** Hand the raw error to the operator; return the path-free code for the agent's reason. */
  function diagnose(stage: GateDiagnostic["stage"], error: unknown): string {
    const code = errorCode(error);
    try {
      config.onDiagnostic?.({ stage, code, error });
    } catch {
      // Diagnostics never change a verdict.
    }
    return code;
  }

  async function finish(parts: {
    verdict: GateVerdict;
    codes: ReasonCode[];
    reasons: string[];
    request: GateResult["request"];
    refs?: EvidenceRef[];
    oracle?: GateResult["oracle"];
    checkpoints?: CheckpointSummary;
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
      ...(parts.oracle && parts.checkpoints ? { checkpoints: parts.checkpoints } : {}),
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
        reasons: [
          ...result.reasons,
          `decision log write failed: ${diagnose("decision-log", error)}`,
        ],
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

    const read = await readWithin(
      () => config.reader.read(runId, task.stateFile),
      readTimeoutMs,
      diagnose,
    );
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

    // The sealed fixture (TIF-270 round 3): when the operator's spec names one, the expected
    // document is built from it, not regenerated from the seed. The bytes come from the
    // operator's reader, and must match the digest the operator registered in the spec, so
    // nothing the agent writes can stand in for them. No request field reaches this step.
    let fixture: Uint8Array | undefined;
    const sealed = task.family.sealedFixture?.(task.spec);
    if (sealed) {
      const readFixture = config.reader.readFixture?.bind(config.reader);
      const got: ReadOutcome = readFixture
        ? await readWithin(() => readFixture(runId, sealed.file), readTimeoutMs, diagnose)
        : {
            ok: false,
            cause: "unreadable",
            detail: "this gate's evidence reader serves no sealed fixture",
          };
      if (!got.ok) {
        return finish({
          verdict: "uncertain",
          codes: ["FIXTURE_UNREADABLE"],
          reasons: [`could not look: sealed fixture ${sealed.file}: ${got.detail}`],
          request,
          refs,
        });
      }
      const digest = sha256(got.bytes);
      refs.push({
        kind: "sealed-fixture",
        runId,
        path: sealed.file,
        sha256: digest,
        bytes: got.bytes.length,
      });
      if (digest !== sealed.sha256) {
        return finish({
          verdict: "uncertain",
          codes: ["FIXTURE_MISMATCH"],
          reasons: [
            `could not look: sealed fixture ${sealed.file} does not match the digest the operator registered (altered or swapped after sealing)`,
          ],
          request,
          refs,
        });
      }
      fixture = got.bytes;
    }
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
        fixture === undefined ? {} : { fixture: new Uint8Array(fixture) },
      );
      // Inside the try: a throwing getter on the output is an oracle error, and the
      // result keeps its request and evidence refs.
      valid = validOracleOutput(output);
    } catch (error) {
      // `instanceof` can itself throw (a revoked Proxy, a throwing getPrototypeOf trap); such
      // a value is an oracle error, not a gate error.
      let corrupt: StateCorruptError | undefined;
      try {
        if (error instanceof StateCorruptError) corrupt = error;
      } catch {
        corrupt = undefined;
      }
      // A StateCorruptError's message is written by the family to be agent-facing (no host
      // path, no raw error text; see families.ts); its `cause`, if any, goes to the operator.
      if (corrupt && corrupt.cause !== undefined) diagnose("oracle", corrupt.cause);
      return finish({
        verdict: "uncertain",
        codes: [corrupt ? "STATE_CORRUPT" : "ORACLE_ERROR"],
        reasons: [
          corrupt
            ? `could not look: ${corrupt.message}`
            : `oracle threw: ${diagnose("oracle", error)}`,
        ],
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
    return finish({
      verdict,
      codes: [code, ...(valid.codes ?? [])],
      reasons: [...valid.reasons],
      request,
      refs,
      oracle,
      ...(valid.checkpoints ? { checkpoints: summarize(valid.checkpoints) } : {}),
    });
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
          reasons: [`gate error: ${diagnose("gate", error)}`],
          request: {},
        });
      }
    },
  };
}
