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
 *     cases: the R5 subjects of that family (`src/oracle-selftest/subjects.ts`) built afresh
 *     for this proposal from the bound task's own intent and state-file name plus cases with
 *     random seeds and names, plus the host read corruptions track T adds to every case. The
 *     check's own `selftestCases` hook is never called, so its author cannot pick the damage it
 *     happens to catch; no fixed seed or name marks a call as a self-test; and every
 *     corruption (values, cells, offsets) is drawn from host-side randomness, so the author
 *     cannot compute the self-test documents from the intent. A check that behaves only while
 *     it recognises the self-test is refused; one that lies only on documents unlike anything
 *     the self-test draws is not, which is why its signal stays advisory. The check is
 *     refused unless R5 passes for EVERY class it claims (an over-claim, a crash, a timeout,
 *     an always-pass or an always-refute check is refused), it claims at least one value class
 *     (a check for a task must check the edit, not only that a file exists), and it is an
 *     oracle only (no reader).
 *  2. RUN (`runAgentCheck`): runs an accepted check, in track T's sandbox (no network, no
 *     filesystem write, empty environment, bounded time, memory and output), over one captured
 *     document of the SAME task, run, intent and file name it was proposed for. The answer is an
 *     `AgentCheckSignal`: advisory, labelled with its provenance, `r1Evidence: false`, and
 *     carrying the markers of `label.ts` that the ledger checks refuse as evidence.
 *
 * What an agent-written check can NEVER do, each proven by `test/agent-checks/`:
 *  - be the grader: nothing here is reachable from `src/benchmark/grade/`, and this module
 *    imports nothing from it (`test/agent-checks/boundaries.test.ts`);
 *  - change a gate verdict: `myco.gate/v1` takes taskId/runId/claim only, so a request that
 *    carries a signal is rejected and the oracle does not run; no gate module imports this one;
 *  - count as R1 evidence: `checkBenchmark`, `checkPack` and `checkAbPack` refuse any row
 *    carrying a signal.
 *
 * Fail closed: every refusal and every run failure is a code only (no host path, no oracle
 * input), so an agent may see it. Operator-facing detail stays in `reasons` on refusals.
 */
import { randomBytes, randomInt } from "node:crypto";
import type { OracleReport } from "../oracle-selftest/run.ts";
import { calcCasesFor } from "../oracle-selftest/subjects.ts";
import {
  CORRUPTION_CLASSES,
  type CorruptionClass,
  type Draw,
  EXPECTED_STATUS,
  type SavedDocument,
  type SelfTestCase,
} from "../oracle-selftest/types.ts";
import {
  type PluginRegistration,
  type RegisterOptions,
  registerPlugin,
  runPluginOracle,
} from "../plugins/host/registry.ts";
import { type CalcRecordEditParams, generateParameterSets } from "../tasks/intent.ts";
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
 * The task as the check will see it on a real run: the intent the check is called with and
 * the basename of the captured state file. The self-test is built from these (D1, round 1 of
 * #590), so only a document's content can tell a self-test call from a real one, and the
 * corrupted content is drawn at random (round 3).
 */
export interface AgentCheckTask {
  readonly intent: CalcRecordEditParams;
  readonly fileName: string;
}

/**
 * Cases of the bound task itself per registration, each with its corruptions drawn afresh
 * (D1, round 2 of #590): a check that recognises its own task's self-test documents would
 * otherwise only need to be honest on one fixed set of them.
 */
const OWN_CASES = 3;
/** Fresh, host-side random cases per registration (beside the bound task's own cases). */
const RANDOM_CASES = 2;

/** A seed or name nobody, the check's author included, can predict or recognise. */
const unpredictable = (): string => randomBytes(9).toString("hex");

/**
 * The host's random source for every corruption the self-test draws (values, cells, rows,
 * truncation points and byte-flip offsets). It lives in the host process; the sandboxed check
 * cannot observe or seed it.
 */
const hostDraw: Draw = (n) => randomInt(n);

/**
 * The calc-record-edit self-test: the bound task's own intent and file name (several cases,
 * each with corruptions drawn afresh from `hostDraw`), plus fresh cases with random seeds,
 * random parameter picks and random file names. Every corruption carries its case's intent
 * and name, so a check sees the bound task's real intent and name on every one of them.
 */
function calcSelfTestCases(task: AgentCheckTask): SelfTestCase<unknown>[] {
  // A case whose clean copy equals one of its corruptions (an intent that changes nothing)
  // has no edit to check and no clean copy to tell apart.
  const same = (a: SavedDocument, b: SavedDocument) =>
    a.bytes !== null && b.bytes !== null && Buffer.from(a.bytes).equals(Buffer.from(b.bytes));
  const sound = (c: SelfTestCase<unknown>) => !c.corruptions.some((x) => same(x.doc, c.correct));
  // The first carries the wider drawn corruptions (two errors, out-of-grammar values, inserted
  // and deleted rows; #610): every shape once per proposal, freshly drawn, on the bound task.
  const own = Array.from(
    { length: OWN_CASES },
    (_, k) =>
      calcCasesFor([task.intent], task.fileName, hostDraw, k === 0)[0] as SelfTestCase<unknown>,
  );
  if (!own.every(sound)) throw new Error("the intent changes nothing");
  const ext = task.fileName.slice(task.fileName.lastIndexOf("."));
  const randomCase = (): SelfTestCase<unknown> => {
    // A random pick can, rarely, be unusable (a no-op value, or a value the generator
    // rejects); draw again rather than fail an honest proposal.
    for (let attempt = 0; attempt < 32; attempt++) {
      try {
        const params = generateParameterSets([unpredictable()]);
        const pick = params[randomInt(params.length)] as CalcRecordEditParams;
        const [c] = calcCasesFor([pick], `${unpredictable()}${ext}`, hostDraw);
        if (c !== undefined && sound(c)) return c;
      } catch {
        // draw again
      }
    }
    throw new Error("no usable random self-test case");
  };
  return [...own, ...Array.from({ length: RANDOM_CASES }, randomCase)].map((c, k) => ({
    ...c,
    id: `case-${k + 1}`,
  }));
}

/**
 * Families an agent may write a check for, each with the host-owned R5 cases its check must
 * pass. Writer and multi-step Calc join here when their cases fit the sandbox budget.
 */
const FAMILY_CASES = {
  "calc-record-edit": calcSelfTestCases,
} as const satisfies Record<string, (task: AgentCheckTask) => SelfTestCase<unknown>[]>;
export type AgentCheckFamily = keyof typeof FAMILY_CASES;
export const AGENT_CHECK_FAMILIES = Object.keys(FAMILY_CASES) as AgentCheckFamily[];

/**
 * The host-owned cases one proposal is self-tested on (fresh on every call). Host side only:
 * exported so the tests can show no two proposals share a seed or a name.
 */
export function agentCheckSelfTestCases(
  family: AgentCheckFamily,
  task: AgentCheckTask,
): SelfTestCase<unknown>[] {
  return FAMILY_CASES[family](task);
}

/**
 * What a proposal registers the check with: the host-owned cases (fresh on every call) and
 * the host's random source for track T's read corruptions (random truncation and byte-flip
 * offsets, not fixed ones). Host side only; exported so the tests can show both are drawn.
 */
export function agentCheckRegisterOptions(
  family: AgentCheckFamily,
  task: AgentCheckTask,
): RegisterOptions {
  return { hostCases: agentCheckSelfTestCases(family, task), draw: hostDraw };
}

/** Classes whose corruption provably fails the postcondition (`refuted`). */
export const VALUE_CLASSES: readonly CorruptionClass[] = CORRUPTION_CLASSES.filter(
  (c) => EXPECTED_STATUS[c] === "refuted",
);

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** A state-file basename the calc-record-edit self-test can carry (CSV cases only, for now). */
const TASK_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,123}\.csv$/;
const INTENT_KEYS = "column,fixtureSeed,newValue,rowKey";
/** One CSV cell the self-test fixture can carry unquoted. */
const CELL = /^[^,"\r\n]{1,256}$/;

export const AGENT_CHECK_REFUSALS = [
  "AGENT_CHECK_BINDING_INVALID",
  "AGENT_CHECK_TASK_INVALID",
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
  /** The intent and file name the check was self-tested on; a run must carry exactly these. */
  readonly task: AgentCheckTask;
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

/** A copy of `t` with exactly the task fields, or null when `t` is not a valid task. */
function validTask(t: unknown): AgentCheckTask | null {
  if (typeof t !== "object" || t === null) return null;
  const o = t as Record<string, unknown>;
  if (Object.keys(o).sort().join(",") !== "fileName,intent") return null;
  if (typeof o.fileName !== "string" || !TASK_FILE.test(o.fileName)) return null;
  const i = o.intent;
  if (typeof i !== "object" || i === null) return null;
  const p = i as Record<string, unknown>;
  if (Object.keys(p).sort().join(",") !== INTENT_KEYS) return null;
  const fields = [p.fixtureSeed, p.rowKey, p.column, p.newValue];
  if (!fields.every((f) => typeof f === "string" && CELL.test(f))) return null;
  const [fixtureSeed, rowKey, column, newValue] = fields as string[];
  return {
    intent: {
      fixtureSeed: fixtureSeed as string,
      rowKey: rowKey as string,
      column: column as string,
      newValue: newValue as string,
    },
    fileName: o.fileName,
  };
}

function sameIntent(a: unknown, b: CalcRecordEditParams): boolean {
  if (typeof a !== "object" || a === null) return false;
  const o = a as Record<string, unknown>;
  return (
    Object.keys(o).sort().join(",") === INTENT_KEYS &&
    o.fixtureSeed === b.fixtureSeed &&
    o.rowKey === b.rowKey &&
    o.column === b.column &&
    o.newValue === b.newValue
  );
}

/**
 * Propose an agent-written check for one task. Never throws. On success the check is bound to
 * `binding` and `task`, and may run only over that task's documents. The R5 self-test is built
 * here, per proposal, from `task` and fresh host-side randomness (`calcSelfTestCases`).
 */
export function proposeAgentCheck(
  checkDir: string,
  binding: AgentCheckBinding,
  task: AgentCheckTask,
): ProposalResult {
  if (!validBinding(binding))
    return refuse("AGENT_CHECK_BINDING_INVALID", ["binding is { taskId, runId, family } only"]);
  if (!Object.hasOwn(FAMILY_CASES, binding.family))
    return refuse("AGENT_CHECK_FAMILY_UNSUPPORTED", [`no host cases for ${binding.family}`]);
  const bound = validTask(task);
  if (bound === null)
    return refuse("AGENT_CHECK_TASK_INVALID", [
      "task is { intent, fileName } of a .csv state file",
    ]);
  let opts: RegisterOptions;
  try {
    opts = agentCheckRegisterOptions(binding.family, bound);
  } catch {
    return refuse("AGENT_CHECK_TASK_INVALID", [
      "the intent names no record and column, or changes nothing",
    ]);
  }
  const reg = registerPlugin(checkDir, opts);
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
    task: bound,
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
    binding.family !== check.binding.family ||
    !sameIntent(intent, check.task.intent) ||
    typeof doc?.fileName !== "string" ||
    doc.fileName.split(/[\\/]/).pop() !== check.task.fileName
  )
    return signal("uncertain", "AGENT_CHECK_TASK_MISMATCH", "host");
  // The bound copy, so the check sees exactly what its self-test showed it.
  const v = runPluginOracle(reg, doc, check.task.intent);
  return v.codeSource === "plugin"
    ? signal(v.status, v.code, "check")
    : signal("uncertain", v.code, "host");
}
