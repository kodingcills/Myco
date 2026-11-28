/**
 * `myco verify` core (spec #589 §3, build PR V1 subset; issue #666): re-verify a recorded run
 * from its captured data, with the gate's own code, read-only.
 *
 * This build covers the mock / development source only (`--mock-evidence`, a harness-filled
 * evidence root read through `fileEvidenceReader`). Its result is always `trust: "mock"` and
 * `simulated: true`: never R1 evidence, never a grader result. The sealed-vault source waits
 * for the lead's ruling on persisting the vault key (spec §1.3, §8 question 2) and for runner
 * changes held for the R1 pilot; the recording source and proof bundles are later PRs.
 *
 * What it does (§3.2):
 *  1. A fresh gate (`createGate`, unchanged) is bound to the operator's (task, run) over the
 *     evidence root, and decides `{ taskId, runId }` built from the operator's flags only.
 *  2. With a decision log (the audit log of the one gate bound to this trial), every line is
 *     this run's call, attributed by that binding (§1.2), never by `request.runId`. The log
 *     must pass the binding check, or the result is `uncertain` VERIFY_LOG_BINDING.
 *  3. Each line is recomputed by its shape: a parse rejection (S1) is reported and never
 *     compared; an assignment rejection (S2) and a line past the assignment check (S3) are
 *     re-run through the same bound gate with the logged request.
 *  4. Compare, never adopt (v5 comparison set): S2 lines are compared; an S3 line is compared
 *     only when its evidence refs equal the recompute's (the same bytes were read). A compared
 *     disagreement makes the result `uncertain` VERIFY_LOG_DISAGREES.
 *
 * Read-only: the gate's reader opens state files read-only; the log is read with
 * `readRegular` (`O_RDONLY | O_NOFOLLOW`). Nothing is written. Output ids are closed ids or
 * `h-<60hex>` (the shared export guard's form), never a value carrying an identity; no path,
 * claim, reason text or evidence path is in the output.
 */
import { createHash } from "node:crypto";
import {
  type EvidenceRef,
  type GateResult,
  type GateVerdict,
  isSafeId,
  type ReasonCode,
} from "../gate/api.ts";
import { createGate, fileEvidenceReader, type TaskRegistry } from "../gate/gate.ts";
import type { IdentityGuard } from "../proof/identity.ts";
import { bindingHolds, logLines, parseLoggedDecision } from "../watch/timeline.ts";

export const VERIFY_SCHEMA = "myco.verify/1";

/** The closed verify codes (§1.1), plus `integrity:<code>` once the vault source lands. */
export const VERIFY_CODES = [
  "VERIFY_LOG_DISAGREES",
  "VERIFY_LOG_BINDING",
  "VERIFY_CHECKPOINT_MISMATCH",
  "VERIFY_KEY_REFUSED",
  "VERIFY_RECORDING_MISMATCH",
  "VERIFY_R5_FAILED",
  "VERIFY_BUNDLE_REFUSED",
  "VERIFY_TRANSCRIPT_REFUSED",
  "VERIFY_EPISODE_REFUSED",
  "VERIFY_LEDGER_REFUSED",
] as const;
export type VerifyCode = (typeof VERIFY_CODES)[number];

/** Parse-rejection codes: a line led by one of these is shape S1 (§1.2). */
const PARSE_CODES: readonly ReasonCode[] = [
  "INVALID_REQUEST",
  "UNKNOWN_FIELD",
  "ORACLE_INPUT_REJECTED",
  "UNSUPPORTED_API_VERSION",
];

export interface VerifyCall {
  readonly call: number;
  readonly source: "decision-log";
  readonly verdictForCall: GateVerdict;
  readonly reasonCodes: readonly ReasonCode[];
  /** true / false when compared; null when outside the comparison set (never compared). */
  readonly loggedVerdictAgrees: boolean | null;
}

export interface VerifyResult {
  readonly schema: typeof VERIFY_SCHEMA;
  readonly runId: string;
  readonly taskId: string;
  readonly verdict: GateVerdict;
  readonly reasonCodes: readonly ReasonCode[];
  readonly verifyCodes: readonly VerifyCode[];
  readonly trust: "mock";
  readonly simulated: true;
  readonly oracle: {
    readonly family: string;
    readonly version: string;
    readonly specSha256: string;
  } | null;
  readonly calls: readonly VerifyCall[];
  readonly agentReported: readonly never[];
  readonly bundle: null;
}

export interface VerifyInput {
  readonly runId: string;
  readonly taskId: string;
  readonly tasks: TaskRegistry;
  /** The harness-filled evidence root (`--mock-evidence`). */
  readonly evidenceRoot: string;
  /** The run's own decision log bytes, if given. */
  readonly decisionLog?: Uint8Array;
  readonly guard: IdentityGuard;
}

/** The output form of an operator string: as written when a closed id with no identity. */
export function outputId(value: string, guard: IdentityGuard): string {
  if (isSafeId(value) && guard.hit(value) === null) return value;
  const hex = createHash("sha256").update(`myco.verify/1/text\u0000${value}`).digest("hex");
  return `h-${hex.slice(0, 60)}`;
}

const sameRefs = (a: readonly EvidenceRef[], b: readonly EvidenceRef[]): boolean =>
  a.length === b.length &&
  a.every((r, i) => {
    const o = b[i];
    return (
      o !== undefined &&
      r.kind === o.kind &&
      r.path === o.path &&
      r.sha256 === o.sha256 &&
      r.bytes === o.bytes
    );
  });

const sameDecision = (logged: GateResult, recomputed: GateResult): boolean =>
  logged.verdict === recomputed.verdict &&
  logged.reasonCodes.length === recomputed.reasonCodes.length &&
  logged.reasonCodes.every((c, i) => c === recomputed.reasonCodes[i]);

/** Recompute a run's verdict and its recorded calls. Total: never throws. */
export async function verifyRun(input: VerifyInput): Promise<VerifyResult> {
  const binding = { taskId: input.taskId, runId: input.runId };
  const gate = createGate({
    tasks: input.tasks,
    reader: fileEvidenceReader(input.evidenceRoot),
    assignment: binding,
  });
  // The request comes from the operator's flags only: nothing from the log reaches it.
  const decided = await gate.check({ taskId: input.taskId, runId: input.runId });
  const verifyCodes = new Set<VerifyCode>();
  const calls: VerifyCall[] = [];

  if (input.decisionLog !== undefined) {
    const lines = logLines(input.decisionLog).map((line) => {
      const closed = parseLoggedDecision(line.bytes);
      let raw: GateResult | null = null;
      try {
        raw = JSON.parse(Buffer.from(line.bytes).toString("utf8")) as GateResult;
      } catch {
        raw = null;
      }
      return { closed, raw };
    });
    // A line that cannot be attributed (malformed) or breaks the binding check: no call is
    // compared, and the result is uncertain.
    const bound = lines.every(
      ({ closed, raw }) =>
        closed !== null &&
        raw !== null &&
        Array.isArray(raw.evidenceRefs) &&
        bindingHolds(closed, binding),
    );
    if (!bound) verifyCodes.add("VERIFY_LOG_BINDING");
    else {
      for (const [i, { closed, raw }] of lines.entries()) {
        if (closed === null || raw === null) continue;
        const shapeS1 = PARSE_CODES.includes(closed.reasonCodes[0] as ReasonCode);
        if (shapeS1) {
          calls.push({
            call: i + 1,
            source: "decision-log",
            verdictForCall: closed.verdict,
            reasonCodes: [...closed.reasonCodes],
            loggedVerdictAgrees: null,
          });
          continue;
        }
        const request = raw.request ?? {};
        const recomputed = await gate.check({
          ...(request.taskId === undefined ? {} : { taskId: request.taskId }),
          ...(request.runId === undefined ? {} : { runId: request.runId }),
          ...(request.claim === undefined ? {} : { claim: request.claim }),
        });
        const compared =
          recomputed.reasonCodes.includes("ASSIGNMENT_MISMATCH") ||
          sameRefs(raw.evidenceRefs, recomputed.evidenceRefs);
        const agrees = compared ? sameDecision(raw, recomputed) : null;
        if (agrees === false) verifyCodes.add("VERIFY_LOG_DISAGREES");
        calls.push({
          call: i + 1,
          source: "decision-log",
          verdictForCall: recomputed.verdict,
          reasonCodes: [...recomputed.reasonCodes],
          loggedVerdictAgrees: agrees,
        });
      }
    }
  }

  const codes = [...verifyCodes];
  return {
    schema: VERIFY_SCHEMA,
    runId: outputId(input.runId, input.guard),
    taskId: outputId(input.taskId, input.guard),
    verdict: codes.length > 0 ? "uncertain" : decided.verdict,
    reasonCodes: [...decided.reasonCodes],
    verifyCodes: codes,
    trust: "mock",
    simulated: true,
    oracle:
      decided.oracle === undefined
        ? null
        : {
            family: outputId(decided.oracle.family, input.guard),
            version: outputId(decided.oracle.version, input.guard),
            specSha256: decided.oracle.specSha256,
          },
    calls,
    agentReported: [],
    bundle: null,
  };
}

/** Exit codes, as `myco-gate check`: 0 verified, 1 refuted, 2 uncertain, 3 usage. */
export function exitCodeFor(result: VerifyResult): 0 | 1 | 2 {
  return result.verdict === "verified" ? 0 : result.verdict === "refuted" ? 1 : 2;
}
