/**
 * Agent-written checks (M2 capability track C; plan §7.1 row C): "The agent writes a check for
 * its own task. The check goes through R5's mutation self-test before anything relies on it,
 * and is never the grader."
 *
 * A check is a `myco.plugin/1` oracle directory (track T's manifest and SDK), written by the
 * agent for the task it was assigned. This module:
 *
 *  1. PROPOSE (`proposeAgentCheck`): binds the check to one task and run of one supported
 *     family, then registers it through track T (`registerPlugin`) with HOST-OWNED self-test
 *     cases: the R5 subjects of that family (`src/oracle-selftest/subjects.ts`), plus the host
 *     read corruptions track T adds to every case. The check's own `selftestCases` hook is
 *     never called, so its author cannot pick the damage it happens to catch. The check is
 *     refused unless R5 passes for EVERY class it claims (an over-claim, a crash, a timeout,
 *     an always-pass or an always-refute check is refused), it claims at least one value class
 *     (a check for a task must check the edit, not only that a file exists), and it is an
 *     oracle only (no reader).
 *  2. RUN (`runAgentCheck`): runs an accepted check, in track T's sandbox (no network, no
 *     filesystem write, empty environment, bounded time, memory and output), over one captured
 *     document of the SAME task and run it was proposed for. The answer is an
 *     `AgentCheckSignal`: advisory, labelled with its provenance, `r1Evidence: false`, and
 *     carrying the markers of `label.ts` that the ledger checks refuse as evidence.
 *
 * What an agent-written check can NEVER do, each proven by `test/agent-checks/`:
 *  - be the grader: nothing here is reachable from `src/benchmark/grade/`, and this module
 *    imports nothing from it (`test/agent-checks/boundaries.test.ts`);
 *  - change a gate verdict: `myco.gate/v1` takes taskId/runId/claim only, so a request that
 *    carries a signal is rejected and the oracle does not run; no gate module imports this one;
 *  - count as R1 evidence: `checkBenchmark` and `checkPack` refuse any row carrying a signal.
 *
 * Fail closed: every refusal and every run failure is a code only (no host path, no oracle
 * input), so an agent may see it. Operator-facing detail stays in `reasons` on refusals.
 */
import type { OracleReport } from "../oracle-selftest/run.ts";
import { calcCases } from "../oracle-selftest/subjects.ts";
import {
  CORRUPTION_CLASSES,
  type CorruptionClass,
  EXPECTED_STATUS,
  type SavedDocument,
  type SelfTestCase,
} from "../oracle-selftest/types.ts";
import {
  type PluginRegistration,
  registerPlugin,
  runPluginOracle,
} from "../plugins/host/registry.ts";
import {
  AGENT_CHECK_EVIDENCE_CLASS,
  AGENT_CHECK_SIGNAL_KIND,
  AGENT_CHECK_SOURCE,
} from "./label.ts";

/** The task this check was written for. All three must match on every run. */
export interface AgentCheckBinding {
  readonly taskId: string;
  readonly runId: string;
  readonly family: AgentCheckFamily;
}

/**
 * Families an agent may write a check for, each with the host-owned R5 cases its check must
 * pass. Writer and multi-step Calc join here when their cases fit the sandbox budget.
 */
const FAMILY_CASES = {
  "calc-record-edit": (): SelfTestCase<unknown>[] => calcCases(3),
} as const satisfies Record<string, () => SelfTestCase<unknown>[]>;
export type AgentCheckFamily = keyof typeof FAMILY_CASES;
export const AGENT_CHECK_FAMILIES = Object.keys(FAMILY_CASES) as AgentCheckFamily[];

/** Classes whose corruption provably fails the postcondition (`refuted`). */
export const VALUE_CLASSES: readonly CorruptionClass[] = CORRUPTION_CLASSES.filter(
  (c) => EXPECTED_STATUS[c] === "refuted",
);

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export const AGENT_CHECK_REFUSALS = [
  "AGENT_CHECK_BINDING_INVALID",
  "AGENT_CHECK_FAMILY_UNSUPPORTED",
  "AGENT_CHECK_NOT_ORACLE_ONLY",
  "AGENT_CHECK_NO_VALUE_CLAIM",
  // Track T's registration refusals, prefixed: PLUGIN_DIR_INVALID, MANIFEST_INVALID,
  // SELFTEST_CASES_INVALID, SELFTEST_HARNESS_FAULT, SELFTEST_FAILED, PLUGIN_CHANGED.
  "AGENT_CHECK_PLUGIN_DIR_INVALID",
  "AGENT_CHECK_MANIFEST_INVALID",
  "AGENT_CHECK_SELFTEST_CASES_FAULT",
  "AGENT_CHECK_SELFTEST_CASES_INVALID",
  "AGENT_CHECK_SELFTEST_HARNESS_FAULT",
  "AGENT_CHECK_SELFTEST_FAILED",
  "AGENT_CHECK_PLUGIN_CHANGED",
] as const;
export type AgentCheckRefusal = (typeof AGENT_CHECK_REFUSALS)[number];

export interface AgentCheckSelfTest {
  readonly pass: true;
  readonly claims: readonly CorruptionClass[];
  readonly cases: number;
  readonly caughtClaimed: number;
  readonly runsClaimed: number;
}

export interface AgentCheckProvenance {
  readonly source: typeof AGENT_CHECK_SOURCE;
  readonly taskId: string;
  readonly runId: string;
  readonly family: AgentCheckFamily;
  readonly check: string;
  readonly version: string;
  readonly manifestSha256: string;
  readonly treeSha256: string;
  readonly selftest: AgentCheckSelfTest;
}

/** An accepted check. Only objects issued by `proposeAgentCheck` run (a WeakSet, not a shape). */
export interface AgentCheck {
  readonly binding: AgentCheckBinding;
  readonly provenance: AgentCheckProvenance;
}

export type ProposalResult =
  | { readonly ok: true; readonly check: AgentCheck }
  | {
      readonly ok: false;
      readonly code: AgentCheckRefusal;
      /** Operator-facing detail (host side only; never sent to an agent). */
      readonly reasons: readonly string[];
      readonly selftest: OracleReport | null;
    };

/**
 * The only thing an agent-written check produces. Advisory: it is never a verdict, never a
 * grade and never evidence. `status` is the check's own opinion, or `uncertain` with a host
 * code when the check could not run.
 */
export interface AgentCheckSignal {
  readonly kind: typeof AGENT_CHECK_SIGNAL_KIND;
  readonly advisory: true;
  readonly r1Evidence: false;
  readonly evidenceClass: typeof AGENT_CHECK_EVIDENCE_CLASS;
  readonly status: "verified" | "refuted" | "uncertain";
  readonly code: string;
  /** `host` when the host or the sandbox refused (the check did not answer), else `check`. */
  readonly codeSource: "check" | "host";
  /** Null only when the object passed in was not an issued check. */
  readonly provenance: AgentCheckProvenance | null;
}

const ISSUED = new WeakMap<AgentCheck, PluginRegistration>();

function deepFreeze<T>(v: T): T {
  if (typeof v === "object" && v !== null && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const x of Object.values(v)) deepFreeze(x);
  }
  return v;
}

function refuse(
  code: AgentCheckRefusal,
  reasons: readonly string[],
  selftest: OracleReport | null = null,
): ProposalResult {
  return { ok: false, code, reasons, selftest };
}

function validBinding(b: unknown): b is AgentCheckBinding {
  if (typeof b !== "object" || b === null) return false;
  const o = b as Record<string, unknown>;
  const keys = Object.keys(o).sort();
  return (
    keys.join(",") === "family,runId,taskId" &&
    typeof o.taskId === "string" &&
    ID.test(o.taskId) &&
    typeof o.runId === "string" &&
    ID.test(o.runId) &&
    typeof o.family === "string"
  );
}

/**
 * Propose an agent-written check for one task. Never throws. On success the check is bound to
 * `binding` and may run only over that task's documents.
 */
export function proposeAgentCheck(checkDir: string, binding: AgentCheckBinding): ProposalResult {
  if (!validBinding(binding))
    return refuse("AGENT_CHECK_BINDING_INVALID", ["binding is { taskId, runId, family } only"]);
  if (!Object.hasOwn(FAMILY_CASES, binding.family))
    return refuse("AGENT_CHECK_FAMILY_UNSUPPORTED", [`no host cases for ${binding.family}`]);
  const cases = FAMILY_CASES[binding.family]();
  const reg = registerPlugin(checkDir, { hostCases: cases });
  if (!reg.ok) return refuse(`AGENT_CHECK_${reg.code}`, reg.reasons, reg.selftest);
  const { manifest, provenance } = reg.registration;
  if (manifest.kinds.length !== 1 || manifest.kinds[0] !== "oracle")
    return refuse("AGENT_CHECK_NOT_ORACLE_ONLY", ["an agent-written check is an oracle only"]);
  // An oracle registration exists only after its R5 self-test passed for every claim
  // (`registerPlugin` refuses otherwise), so the report is present and passing here.
  const selftest = reg.registration.selftest as OracleReport;
  if (!manifest.claims.some((c) => VALUE_CLASSES.includes(c)))
    return refuse(
      "AGENT_CHECK_NO_VALUE_CLAIM",
      [`claims none of ${VALUE_CLASSES.join(", ")}`],
      selftest,
    );
  const claimed = selftest.claims.map((c) => selftest.perClass[c]);
  const check: AgentCheck = deepFreeze({
    binding: { taskId: binding.taskId, runId: binding.runId, family: binding.family },
    provenance: {
      source: AGENT_CHECK_SOURCE,
      taskId: binding.taskId,
      runId: binding.runId,
      family: binding.family,
      check: manifest.name,
      version: manifest.version,
      manifestSha256: provenance.manifestSha256,
      treeSha256: provenance.treeSha256,
      selftest: {
        pass: true,
        claims: [...selftest.claims],
        cases: selftest.cases,
        caughtClaimed: claimed.reduce((n, s) => n + s.caught, 0),
        runsClaimed: claimed.reduce((n, s) => n + s.runs, 0),
      },
    },
  });
  ISSUED.set(check, reg.registration);
  return { ok: true, check };
}

/**
 * Run an accepted check over one captured document of its own task. Never throws. Anything
 * other than an issued check bound to exactly this task and run is `uncertain` with a host
 * code, and the check does not run.
 */
export function runAgentCheck(
  check: AgentCheck,
  binding: AgentCheckBinding,
  doc: SavedDocument,
  intent: unknown,
): AgentCheckSignal {
  const reg = ISSUED.get(check);
  const provenance = reg === undefined ? null : check.provenance;
  const signal = (
    status: AgentCheckSignal["status"],
    code: string,
    codeSource: AgentCheckSignal["codeSource"],
  ): AgentCheckSignal =>
    deepFreeze({
      kind: AGENT_CHECK_SIGNAL_KIND,
      advisory: true,
      r1Evidence: false,
      evidenceClass: AGENT_CHECK_EVIDENCE_CLASS,
      status,
      code,
      codeSource,
      provenance,
    });
  if (reg === undefined) return signal("uncertain", "AGENT_CHECK_NOT_ACCEPTED", "host");
  if (
    !validBinding(binding) ||
    binding.taskId !== check.binding.taskId ||
    binding.runId !== check.binding.runId ||
    binding.family !== check.binding.family
  )
    return signal("uncertain", "AGENT_CHECK_TASK_MISMATCH", "host");
  const v = runPluginOracle(reg, doc, intent);
  return v.codeSource === "plugin"
    ? signal(v.status, v.code, "check")
    : signal("uncertain", v.code, "host");
}
