/**
 * Recursive orchestration (capability track V): a planner agent spawns desktop worker
 * agents, and Myco verifies each worker's result before the planner can use it.
 *
 * Trust split (docs/orchestrate/recursive-orchestration.md, "Security model"):
 *  - The planner holds only a `PlannerHandle`: a frozen object with `submit` and a frozen,
 *    read-only copy of the limits. A submission names a registered task (or a goal for a
 *    sub-planner) and an optional note; every other field is refused, and a field that looks
 *    like a limit is refused with its own countable code (`LIMIT_WRITE_REJECTED`).
 *  - Workers run through `runGatedTrial` (launch audit, seal, sealed gate bound to the
 *    worker's run, capture after stop), each in its own isolated trial. A worker's transport
 *    gets only its own assignment; its gate answers only its own run.
 *  - The orchestrator (operator side) holds the limits, the vault, the ledger key and the
 *    kill switch. Every spawn is admitted host-side against every limit before anything is
 *    sealed or launched; any doubt refuses (fail closed).
 *
 * What reaches the planner is a report the orchestrator builds from the gate's result:
 * `status: "done"` only when the gate VERIFIED the worker's persisted state (and, when an
 * operator grader is configured, the grader agreed). Refuted, uncertain, unverified,
 * refused and killed results are returned as such, never as done. Reports carry codes only,
 * never the gate's reason text or any evidence bytes.
 */

import { existsSync } from "node:fs";
import type { GateVerdict, ReasonCode } from "../gate/api.ts";
import { isSafeId } from "../gate/api.ts";
import type { TaskRegistry } from "../gate/gate.ts";
import {
  type GatedTrialOutcome,
  type GatedTrialTransport,
  runGatedTrial,
} from "../gate/gated-trial.ts";
import type { AgentLaunchPlan } from "../integrity/launch.ts";
import { appendChainedRow } from "../integrity/ledger.ts";
import type { VerdictVault } from "../integrity/vault.ts";
import type { IsolatedTrial, TrialIsolation } from "./isolation.ts";
import {
  agentReachable,
  estimateMicroUsd,
  type OrchestratorLimits,
  parseLimits,
  realish,
  within,
} from "./limits.ts";

export const ORCHESTRATOR_RECORD_VERSION = "myco.orchestrate.run/v1";

/** Orchestrator codes. Stable; adding one is additive. */
export const ORCH_CODES = [
  /** The submission is not an object or a field has the wrong form. */
  "SUBMISSION_INVALID",
  /** The submission carried a field the API does not define (run id, path, verdict, ...). */
  "SUBMISSION_FIELD_REJECTED",
  /** The submission tried to set a limit, budget or the kill switch. Counted as tamper. */
  "LIMIT_WRITE_REJECTED",
  /** `taskId` is not in the operator's registry. */
  "UNKNOWN_TASK",
  /** The kill switch was thrown: nothing more is spawned, in-flight trials are stopped. */
  "KILLED",
  /** The run is over (or not started): nothing more is spawned. */
  "RUN_NOT_ACTIVE",
  "DEPTH_CAP",
  "PLANNER_SPAWN_CAP",
  "TOTAL_SPAWN_CAP",
  "CONCURRENCY_CAP",
  "BUDGET_TOKENS",
  "BUDGET_COST",
  "BUDGET_WALL",
  /** A worker's or planner's usage could not be metered: the budget can't be proven, so stop spawning. */
  "BUDGET_UNMETERED",
  /** The orchestrator ledger could not be written; the run halts (an unlogged spawn can't be audited). */
  "LEDGER_FAILED",
  "ISOLATION_FAILED",
  /** A provisioned workspace overlaps another trial's workspace. */
  "ISOLATION_OVERLAP",
  /** The worker's launch plan failed the launch audit; nothing was launched. */
  "LAUNCH_REFUSED",
  /** The worker's transport or gate path threw; no verdict. */
  "WORKER_FAILED",
  /** The gate verified, the operator's independent grader did not. */
  "GRADER_DISAGREES",
  /** The gate verified, the operator's grader gave no answer. */
  "GRADER_UNAVAILABLE",
  /** A sub-planner threw or could not be started. */
  "PLANNER_FAILED",
  /** A sub-planner finished with no child, or a child that is not done. */
  "CHILDREN_INCOMPLETE",
] as const;
export type OrchCode = (typeof ORCH_CODES)[number];

/** Codes that mean a limit was hit (recorded in `limitsHit`). */
const LIMIT_CODES: ReadonlySet<OrchCode> = new Set<OrchCode>([
  "KILLED",
  "DEPTH_CAP",
  "PLANNER_SPAWN_CAP",
  "TOTAL_SPAWN_CAP",
  "CONCURRENCY_CAP",
  "BUDGET_TOKENS",
  "BUDGET_COST",
  "BUDGET_WALL",
  "BUDGET_UNMETERED",
]);

export type ReportStatus = "done" | "refuted" | "uncertain" | "unverified" | "refused" | "killed";

export interface WorkerReport {
  readonly kind: "worker";
  readonly nodeId: string;
  readonly taskId?: string;
  readonly runId?: string;
  /** `done` only when the gate verified (and the grader, when configured, agreed). */
  readonly status: ReportStatus;
  /** The gate's verdict, present when the gate decided. */
  readonly verdict?: GateVerdict;
  /** The gate's reason codes (codes only, never reason text). */
  readonly gateCodes: readonly ReasonCode[];
  readonly codes: readonly OrchCode[];
  readonly graded?: GradeOutcome;
}

export interface PlannerReport {
  readonly kind: "planner";
  readonly nodeId: string;
  /** `done` only when every child is done (and there is at least one). */
  readonly status: ReportStatus;
  readonly codes: readonly OrchCode[];
  readonly children: readonly Report[];
}

export type Report = WorkerReport | PlannerReport;

export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export type GradeOutcome = "pass" | "fail" | "unknown";

/** What the orchestrator gives the operator's worker factory: one trial, nothing else. */
export interface WorkerAssignment {
  readonly nodeId: string;
  readonly taskId: string;
  readonly runId: string;
  readonly depth: number;
  /** The trial's own isolated workspace. */
  readonly workspace: string;
  /** The planner's note for the worker (recorded; never an oracle input). */
  readonly note?: string;
  /** Aborted by the kill switch or the wall budget: the transport must stop the agent. */
  readonly signal: AbortSignal;
}

export interface WorkerTransport extends GatedTrialTransport {
  /**
   * Host-metered usage of this worker's agent (the harness's own meter, never the worker's
   * claim), read after the trial. `null` when it could not be metered.
   */
  usage(): TokenUsage | null;
}

export interface WorkerFactory {
  /** Absolute host paths of the oracle sources, hashed at seal. */
  readonly oracleSources: readonly string[];
  plan(assignment: WorkerAssignment): AgentLaunchPlan;
  transport(assignment: WorkerAssignment): WorkerTransport;
}

/** A planner: anything that drives a handle. Scripted in tests; an agent in a live run. */
export type Planner = (handle: PlannerHandle) => Promise<unknown>;

export interface PlannerHandle {
  readonly nodeId: string;
  readonly depth: number;
  /** A frozen copy of the operator's limits. Read-only: writing it changes nothing. */
  readonly limits: OrchestratorLimits;
  /** Submit a sub-task: `{ taskId, note? }` for a worker, `{ kind: "planner", goal }` for a sub-planner. */
  submit(submission: unknown): Promise<Report>;
}

export interface OrchestratorConfig {
  /** Operator limits (parsed again here; a raw object is accepted and validated). */
  readonly limits: unknown;
  readonly tasks: TaskRegistry;
  /** The vault; its `agentRoots` must include `isolation.agentRoots`. */
  readonly vault: VerdictVault;
  readonly isolation: TrialIsolation;
  readonly worker: WorkerFactory;
  /** Operator factory for sub-planners (in a live run: launches a planner agent). */
  readonly planners: (
    goal: string,
    ctx: { readonly nodeId: string; readonly depth: number },
  ) => Planner;
  /** Orchestration run id; worker run ids are `<runId>-w<n>`. */
  readonly runId: string;
  /** `mock` rows are never evidence; this PR only ever runs `mock`. */
  readonly provenance: "mock" | "live";
  /** Append-only MAC-chained ledger, outside every agent root. */
  readonly ledger: { readonly path: string; readonly key: Uint8Array };
  /** Optional independent grader (src/benchmark/grade shape), operator side. */
  readonly grader?: (trial: {
    readonly taskId: string;
    readonly runId: string;
  }) => Promise<GradeOutcome>;
  /** Optional operator kill-switch file: when it exists, the run halts. Outside every agent root. */
  readonly killSwitchFile?: string;
  /** Clock (ms); tests inject one. */
  readonly now?: () => number;
  /** Operator diagnostics (full errors); never reaches a planner. */
  readonly onDiagnostic?: (stage: string, error: unknown) => void;
}

export interface NodeRecord {
  readonly nodeId: string;
  readonly parentId: string | null;
  readonly kind: "planner" | "worker";
  readonly depth: number;
  readonly taskId?: string;
  readonly runId?: string;
  readonly status: ReportStatus;
  readonly verdict?: GateVerdict;
  readonly gateCodes: readonly ReasonCode[];
  readonly codes: readonly OrchCode[];
  readonly graded?: GradeOutcome;
  readonly sealDigest?: string;
}

export interface LimitHit {
  readonly code: OrchCode;
  readonly parentId: string | null;
  readonly atMs: number;
}

export interface RunRecord {
  readonly version: typeof ORCHESTRATOR_RECORD_VERSION;
  readonly runId: string;
  readonly provenance: "mock" | "live";
  /** Always false: an orchestration record is never a benchmark evidence row. */
  readonly countsAsEvidence: false;
  readonly limits: OrchestratorLimits;
  readonly halt: { readonly code: OrchCode; readonly detail: string; readonly atMs: number } | null;
  readonly limitsHit: readonly LimitHit[];
  /** Spawn tree, in spawn order; refused submissions are nodes too (status `refused`). */
  readonly nodes: readonly NodeRecord[];
  readonly totals: {
    readonly spawns: number;
    readonly workers: number;
    readonly planners: number;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly unmetered: number;
    /** Token-derived ESTIMATE in micro-USD; null when any usage was unmetered (never 0). */
    readonly estimatedCostMicroUsd: number | null;
  };
  readonly root: PlannerReport;
  readonly ledger: { readonly path: string; readonly head: string | null };
  readonly wallMs: number;
}

/** Submission fields the API defines. */
const SUBMISSION_FIELDS = new Set(["kind", "taskId", "note", "goal"]);
/** Field names that would write a limit, a budget or the kill switch. */
const LIMIT_FIELD = /limit|budget|depth|concurren|max|token|cost|wall|kill|quota|deadline|timeout/i;
export const NOTE_LIMIT = 4000;

type Parsed =
  | { readonly ok: true; readonly kind: "worker"; readonly taskId: string; readonly note?: string }
  | { readonly ok: true; readonly kind: "planner"; readonly goal: string }
  | { readonly ok: false; readonly code: OrchCode };

export function parseSubmission(raw: unknown, tasks: TaskRegistry): Parsed {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    return { ok: false, code: "SUBMISSION_INVALID" };
  const record = raw as Record<string, unknown>;
  const keys = Reflect.ownKeys(record);
  if (keys.some((key) => typeof key !== "string")) return { ok: false, code: "SUBMISSION_INVALID" };
  const names = keys as string[];
  if (names.some((key) => LIMIT_FIELD.test(key)))
    return { ok: false, code: "LIMIT_WRITE_REJECTED" };
  if (names.some((key) => !SUBMISSION_FIELDS.has(key)))
    return { ok: false, code: "SUBMISSION_FIELD_REJECTED" };
  const kind = record.kind ?? "worker";
  if (kind === "planner") {
    if (record.taskId !== undefined || record.note !== undefined)
      return { ok: false, code: "SUBMISSION_FIELD_REJECTED" };
    const goal = record.goal;
    if (typeof goal !== "string" || goal.length === 0 || goal.length > NOTE_LIMIT)
      return { ok: false, code: "SUBMISSION_INVALID" };
    return { ok: true, kind: "planner", goal };
  }
  if (kind !== "worker") return { ok: false, code: "SUBMISSION_INVALID" };
  if (record.goal !== undefined) return { ok: false, code: "SUBMISSION_FIELD_REJECTED" };
  const { taskId, note } = record;
  if (typeof taskId !== "string" || !isSafeId(taskId))
    return { ok: false, code: "SUBMISSION_INVALID" };
  if (note !== undefined && (typeof note !== "string" || note.length > NOTE_LIMIT))
    return { ok: false, code: "SUBMISSION_INVALID" };
  if (!tasks.has(taskId)) return { ok: false, code: "UNKNOWN_TASK" };
  return { ok: true, kind: "worker", taskId, ...(typeof note === "string" ? { note } : {}) };
}

/**
 * Map a gated trial's outcome to a status. `done` only for a decided trial whose gate result
 * is verified, accepted and carries ORACLE_PASS; anything else is not done.
 */
export function statusOfOutcome(outcome: GatedTrialOutcome): {
  status: ReportStatus;
  verdict?: GateVerdict;
  gateCodes: readonly ReasonCode[];
  codes: OrchCode[];
} {
  if (outcome.status !== "decided")
    return { status: "unverified", gateCodes: [], codes: ["LAUNCH_REFUSED"] };
  const { result } = outcome;
  const gateCodes = [...result.reasonCodes];
  if (
    result.verdict === "verified" &&
    result.accepted === true &&
    gateCodes.includes("ORACLE_PASS")
  )
    return { status: "done", verdict: "verified", gateCodes, codes: [] };
  if (result.verdict === "refuted")
    return { status: "refuted", verdict: "refuted", gateCodes, codes: [] };
  return {
    status: "uncertain",
    verdict: result.verdict === "verified" ? "uncertain" : result.verdict,
    gateCodes,
    codes: [],
  };
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    for (const key of Reflect.ownKeys(value))
      deepFreeze((value as Record<PropertyKey, unknown>)[key]);
    Object.freeze(value);
  }
  return value;
}

interface PlannerNode {
  readonly nodeId: string;
  readonly depth: number;
  spawns: number;
  readonly children: Promise<Report>[];
}

export class Orchestrator {
  readonly #limits: OrchestratorLimits;
  readonly #config: OrchestratorConfig;
  readonly #now: () => number;
  readonly #nodes: NodeRecord[] = [];
  readonly #limitsHit: LimitHit[] = [];
  readonly #inflight = new Map<string, AbortController>();
  readonly #workspaces: string[] = [];
  #state: "new" | "running" | "ended" = "new";
  #halt: RunRecord["halt"] = null;
  #haltResolve: (() => void) | undefined;
  readonly #halted: Promise<void>;
  #startedAt = 0;
  #seq = 0;
  #spawns = 0;
  #workers = 0;
  #planners = 0;
  #activeDesktops = 0;
  #reservedTokens = 0;
  #reservedCost = 0;
  #inputTokens = 0;
  #outputTokens = 0;
  #cost = 0;
  #unmetered = 0;
  #head: string | null = null;

  constructor(config: OrchestratorConfig) {
    this.#limits = parseLimits(config.limits);
    if (!isSafeId(config.runId) || config.runId.length > 96)
      throw new Error("orchestrator runId must be a safe id of at most 96 characters");
    if (config.provenance !== "mock" && config.provenance !== "live")
      throw new Error("orchestrator provenance must be mock or live");
    if (config.ledger.key.length < 32)
      throw new Error("orchestrator ledger key shorter than 32 bytes");
    const roots = config.isolation.agentRoots;
    const ledgerClash = agentReachable(config.ledger.path, roots);
    if (ledgerClash) throw new Error(`orchestrator ledger is agent-reachable: ${ledgerClash}`);
    if (config.killSwitchFile !== undefined) {
      const killClash = agentReachable(config.killSwitchFile, roots);
      if (killClash) throw new Error(`kill-switch file is agent-reachable: ${killClash}`);
    }
    if (existsSync(config.ledger.path))
      throw new Error("orchestrator ledger already exists: one ledger per run (append-only)");
    this.#config = config;
    this.#now = config.now ?? Date.now;
    this.#halted = new Promise((resolve) => {
      this.#haltResolve = resolve;
    });
  }

  /** The operator's kill switch: stops everything and records the stop. */
  kill(detail = "operator kill switch"): void {
    this.#haltWith("KILLED", detail);
  }

  /** Operator-side meter for a planner's own model usage (`null`: could not be metered). */
  chargePlanner(nodeId: string, usage: TokenUsage | null): void {
    this.#charge(usage);
    this.#log({ type: "usage", nodeId, source: "planner", usage });
  }

  /** Run the root planner to completion (or until halted) and return the run record. */
  async run(root: Planner): Promise<RunRecord> {
    if (this.#state !== "new") throw new Error("an orchestrator runs once");
    this.#state = "running";
    this.#startedAt = this.#now();
    const timer = setTimeout(
      () => this.#haltWith("BUDGET_WALL", "wall budget reached"),
      this.#limits.maxWallMs,
    );
    timer.unref?.();
    if (!this.#log({ type: "run-start", limits: this.#limits })) {
      clearTimeout(timer);
      this.#state = "ended";
    }
    const rootNode: PlannerNode = { nodeId: "p0", depth: 0, spawns: 0, children: [] };
    this.#planners += 1;
    const report =
      this.#state === "running"
        ? await this.#drivePlanner(rootNode, null, root)
        : this.#plannerReport(rootNode, "unverified", ["LEDGER_FAILED"], []);
    clearTimeout(timer);
    this.#state = "ended";
    this.#log({ type: "run-end", status: report.status, totals: this.#totals() });
    return deepFreeze({
      version: ORCHESTRATOR_RECORD_VERSION,
      runId: this.#config.runId,
      provenance: this.#config.provenance,
      countsAsEvidence: false,
      limits: this.#limits,
      halt: this.#halt,
      limitsHit: [...this.#limitsHit],
      nodes: [...this.#nodes],
      totals: this.#totals(),
      root: report,
      ledger: { path: this.#config.ledger.path, head: this.#head },
      wallMs: this.#now() - this.#startedAt,
    } satisfies RunRecord);
  }

  #totals(): RunRecord["totals"] {
    return {
      spawns: this.#spawns,
      workers: this.#workers,
      planners: this.#planners,
      inputTokens: this.#inputTokens,
      outputTokens: this.#outputTokens,
      unmetered: this.#unmetered,
      estimatedCostMicroUsd: this.#unmetered > 0 ? null : this.#cost,
    };
  }

  #diag(stage: string, error: unknown): void {
    try {
      this.#config.onDiagnostic?.(stage, error);
    } catch {
      // Diagnostics never change an outcome.
    }
  }

  /** Append one ledger row. On failure the run halts (fail closed) and this returns false. */
  #log(row: Record<string, unknown>): boolean {
    try {
      this.#head = appendChainedRow(
        this.#config.ledger.path,
        this.#config.ledger.key,
        this.#config.runId,
        { ...row, provenance: this.#config.provenance, atMs: this.#now() - this.#startedAt },
      );
      return true;
    } catch (error) {
      this.#diag("ledger", error);
      this.#haltWith("LEDGER_FAILED", "orchestrator ledger write failed", false);
      return false;
    }
  }

  #haltWith(code: OrchCode, detail: string, log = true): void {
    if (this.#halt) return;
    this.#halt = { code, detail, atMs: this.#now() - this.#startedAt };
    if (LIMIT_CODES.has(code))
      this.#limitsHit.push({ code, parentId: null, atMs: this.#halt.atMs });
    const inFlight = [...this.#inflight.keys()];
    for (const controller of this.#inflight.values()) controller.abort(new Error(code));
    if (log) this.#log({ type: "halt", code, detail, inFlight });
    this.#haltResolve?.();
  }

  #charge(usage: TokenUsage | null): void {
    const valid =
      usage !== null &&
      typeof usage === "object" &&
      Number.isSafeInteger(usage.inputTokens) &&
      Number.isSafeInteger(usage.outputTokens) &&
      usage.inputTokens >= 0 &&
      usage.outputTokens >= 0;
    if (!valid) {
      this.#unmetered += 1;
      return;
    }
    this.#inputTokens += usage.inputTokens;
    this.#outputTokens += usage.outputTokens;
    this.#cost += estimateMicroUsd(this.#limits, usage);
  }

  /** The worker reservation's estimated cost: every reserved token at the dearer price. */
  #workerCostReservation(): number {
    const l = this.#limits;
    const dearer = Math.max(l.estimateMicroUsdPerMInputTokens, l.estimateMicroUsdPerMOutputTokens);
    return Math.ceil((l.maxTokensPerWorker * dearer) / 1_000_000);
  }

  /** Host-side admission of one spawn. Synchronous: check and commit happen without a gap. */
  #admit(parent: PlannerNode, kind: "worker" | "planner"): OrchCode | undefined {
    const l = this.#limits;
    if (this.#state !== "running") return "RUN_NOT_ACTIVE";
    if (
      !this.#halt &&
      this.#config.killSwitchFile !== undefined &&
      existsSync(this.#config.killSwitchFile)
    )
      this.#haltWith("KILLED", "kill-switch file present");
    if (!this.#halt && this.#now() - this.#startedAt >= l.maxWallMs)
      this.#haltWith("BUDGET_WALL", "wall budget reached");
    if (this.#halt) return this.#halt.code;
    if (parent.depth + 1 > l.maxDepth) return "DEPTH_CAP";
    if (parent.spawns >= l.maxSpawnsPerPlanner) return "PLANNER_SPAWN_CAP";
    if (this.#spawns >= l.maxTotalSpawns) return "TOTAL_SPAWN_CAP";
    if (this.#unmetered > 0) return "BUDGET_UNMETERED";
    const used = this.#inputTokens + this.#outputTokens;
    const reserveTokens = kind === "worker" ? l.maxTokensPerWorker : 0;
    const reserveCost = kind === "worker" ? this.#workerCostReservation() : 0;
    if (used + this.#reservedTokens + reserveTokens > l.maxTotalTokens || used >= l.maxTotalTokens)
      return "BUDGET_TOKENS";
    if (
      this.#cost + this.#reservedCost + reserveCost > l.maxEstimatedCostMicroUsd ||
      this.#cost >= l.maxEstimatedCostMicroUsd
    )
      return "BUDGET_COST";
    if (kind === "worker" && this.#activeDesktops >= l.maxConcurrentDesktops)
      return "CONCURRENCY_CAP";
    return undefined;
  }

  #record(node: NodeRecord): void {
    this.#nodes.push(deepFreeze(node));
  }

  #refuse(parent: PlannerNode, code: OrchCode, kind: "worker" | "planner" = "worker"): Report {
    this.#seq += 1;
    const nodeId = `r${this.#seq}`;
    if (LIMIT_CODES.has(code))
      this.#limitsHit.push({ code, parentId: parent.nodeId, atMs: this.#now() - this.#startedAt });
    const report: WorkerReport = {
      kind: "worker",
      nodeId,
      status: "refused",
      gateCodes: [],
      codes: [code],
    };
    this.#record({
      nodeId,
      parentId: parent.nodeId,
      kind,
      depth: parent.depth + 1,
      status: "refused",
      gateCodes: [],
      codes: [code],
    });
    this.#log({
      type: "refused",
      nodeId,
      parentId: parent.nodeId,
      code,
      limit: LIMIT_CODES.has(code),
    });
    return deepFreeze(report);
  }

  #handle(node: PlannerNode): PlannerHandle {
    const limits = deepFreeze(structuredClone(this.#limits));
    const submit = (submission: unknown): Promise<Report> => {
      const promise = this.#submit(node, submission);
      node.children.push(promise);
      return promise;
    };
    return Object.freeze({ nodeId: node.nodeId, depth: node.depth, limits, submit });
  }

  #submit(parent: PlannerNode, raw: unknown): Promise<Report> {
    let parsed: Parsed;
    try {
      parsed = parseSubmission(raw, this.#config.tasks);
    } catch {
      parsed = { ok: false, code: "SUBMISSION_INVALID" };
    }
    if (!parsed.ok) return Promise.resolve(this.#refuse(parent, parsed.code));
    const refusal = this.#admit(parent, parsed.kind);
    if (refusal) return Promise.resolve(this.#refuse(parent, refusal, parsed.kind));
    // Commit, synchronously after admission.
    this.#seq += 1;
    parent.spawns += 1;
    this.#spawns += 1;
    const depth = parent.depth + 1;
    if (parsed.kind === "planner") {
      const nodeId = `p${this.#seq}`;
      this.#planners += 1;
      if (!this.#log({ type: "spawn", kind: "planner", nodeId, parentId: parent.nodeId, depth }))
        return Promise.resolve(this.#refuse(parent, "LEDGER_FAILED", "planner"));
      return this.#subPlanner(
        { nodeId, depth, spawns: 0, children: [] },
        parent.nodeId,
        parsed.goal,
      );
    }
    const nodeId = `w${this.#seq}`;
    const runId = `${this.#config.runId}-w${this.#seq}`;
    this.#workers += 1;
    this.#activeDesktops += 1;
    const reservedTokens = this.#limits.maxTokensPerWorker;
    const reservedCost = this.#workerCostReservation();
    this.#reservedTokens += reservedTokens;
    this.#reservedCost += reservedCost;
    const controller = new AbortController();
    this.#inflight.set(nodeId, controller);
    const release = () => {
      this.#activeDesktops -= 1;
      this.#reservedTokens -= reservedTokens;
      this.#reservedCost -= reservedCost;
      this.#inflight.delete(nodeId);
    };
    if (
      !this.#log({
        type: "spawn",
        kind: "worker",
        nodeId,
        parentId: parent.nodeId,
        depth,
        taskId: parsed.taskId,
        runId,
      })
    ) {
      release();
      return Promise.resolve(this.#refuse(parent, "LEDGER_FAILED"));
    }
    return this.#runWorker({
      nodeId,
      parentId: parent.nodeId,
      depth,
      taskId: parsed.taskId,
      runId,
      note: parsed.kind === "worker" ? parsed.note : undefined,
      controller,
      release,
    });
  }

  async #runWorker(w: {
    nodeId: string;
    parentId: string;
    depth: number;
    taskId: string;
    runId: string;
    note: string | undefined;
    controller: AbortController;
    release: () => void;
  }): Promise<Report> {
    let trial: IsolatedTrial | undefined;
    let usage: TokenUsage | null = null;
    let result: {
      status: ReportStatus;
      verdict?: GateVerdict;
      gateCodes: readonly ReasonCode[];
      codes: OrchCode[];
      graded?: GradeOutcome;
      sealDigest?: string;
    };
    try {
      trial = await this.#config.isolation.provision(w.runId);
      const workspace = realish(trial.workspace);
      if (
        trial.runId !== w.runId ||
        this.#workspaces.some((other) => within(workspace, other) || within(other, workspace))
      )
        throw Object.assign(new Error("workspace overlaps another trial"), { overlap: true });
      this.#workspaces.push(workspace);
      const assignment: WorkerAssignment = Object.freeze({
        nodeId: w.nodeId,
        taskId: w.taskId,
        runId: w.runId,
        depth: w.depth,
        workspace,
        ...(w.note !== undefined ? { note: w.note } : {}),
        signal: w.controller.signal,
      });
      const transport = this.#config.worker.transport(assignment);
      try {
        const outcome = await runGatedTrial({
          vault: this.#config.vault,
          runId: w.runId,
          taskId: w.taskId,
          tasks: this.#config.tasks,
          plan: this.#config.worker.plan(assignment),
          transport,
          oracleSources: this.#config.worker.oracleSources,
          onDiagnostic: (d) => this.#diag(`gate:${d.stage}`, d.error),
        });
        result = statusOfOutcome(outcome);
        if (outcome.status === "decided") result.sealDigest = outcome.receipt.sealDigest;
      } catch (error) {
        this.#diag("worker", error);
        result = { status: "unverified", gateCodes: [], codes: ["WORKER_FAILED"] };
      }
      try {
        usage = transport.usage();
      } catch (error) {
        this.#diag("meter", error);
        usage = null;
      }
      if (result.status === "done" && this.#config.grader) {
        let graded: GradeOutcome;
        try {
          const answer = await this.#config.grader({ taskId: w.taskId, runId: w.runId });
          graded = answer === "pass" || answer === "fail" ? answer : "unknown";
        } catch (error) {
          this.#diag("grader", error);
          graded = "unknown";
        }
        result.graded = graded;
        if (graded !== "pass") {
          result.status = "uncertain";
          result.codes.push(graded === "fail" ? "GRADER_DISAGREES" : "GRADER_UNAVAILABLE");
        }
      }
    } catch (error) {
      this.#diag("isolation", error);
      const overlap = (error as { overlap?: unknown } | null)?.overlap === true;
      result = {
        status: "unverified",
        gateCodes: [],
        codes: [overlap ? "ISOLATION_OVERLAP" : "ISOLATION_FAILED"],
      };
    } finally {
      try {
        await trial?.release();
      } catch (error) {
        this.#diag("isolation-release", error);
      }
    }
    // `usage` stays null unless the meter was read: a trial that never reached the meter
    // (isolation failed, factory threw) is unmetered, never free.
    this.#charge(usage);
    w.release();
    // Stopped by the kill switch (or wall budget) while in flight: never handed over as done.
    if (this.#halt && w.controller.signal.aborted) {
      result.status = "killed";
      if (!result.codes.includes("KILLED")) result.codes.push("KILLED");
    }
    const report: WorkerReport = {
      kind: "worker",
      nodeId: w.nodeId,
      taskId: w.taskId,
      runId: w.runId,
      status: result.status,
      ...(result.verdict ? { verdict: result.verdict } : {}),
      gateCodes: result.gateCodes,
      codes: result.codes,
      ...(result.graded ? { graded: result.graded } : {}),
    };
    if (
      !this.#log({
        type: "verdict",
        nodeId: w.nodeId,
        runId: w.runId,
        taskId: w.taskId,
        status: report.status,
        verdict: report.verdict ?? null,
        gateCodes: report.gateCodes,
        codes: report.codes,
        graded: report.graded ?? null,
        sealDigest: result.sealDigest ?? null,
        usage,
      })
    ) {
      // An unlogged verdict can't be audited: never handed over as done.
      if (report.status === "done") (report as { status: ReportStatus }).status = "unverified";
      (report.codes as OrchCode[]).push("LEDGER_FAILED");
    }
    this.#record({
      nodeId: w.nodeId,
      parentId: w.parentId,
      kind: "worker",
      depth: w.depth,
      taskId: w.taskId,
      runId: w.runId,
      status: report.status,
      ...(report.verdict ? { verdict: report.verdict } : {}),
      gateCodes: [...report.gateCodes],
      codes: [...report.codes],
      ...(report.graded ? { graded: report.graded } : {}),
      ...(result.sealDigest ? { sealDigest: result.sealDigest } : {}),
    });
    return deepFreeze(report);
  }

  async #subPlanner(node: PlannerNode, parentId: string, goal: string): Promise<Report> {
    let planner: Planner;
    try {
      planner = this.#config.planners(goal, { nodeId: node.nodeId, depth: node.depth });
    } catch (error) {
      this.#diag("planner", error);
      const report = this.#plannerReport(node, "unverified", ["PLANNER_FAILED"], []);
      this.#recordPlanner(node, parentId, report);
      return report;
    }
    return this.#drivePlanner(node, parentId, planner);
  }

  async #drivePlanner(
    node: PlannerNode,
    parentId: string | null,
    planner: Planner,
  ): Promise<PlannerReport> {
    const handle = this.#handle(node);
    let failed = false;
    try {
      await Promise.race([Promise.resolve().then(() => planner(handle)), this.#halted]);
    } catch (error) {
      this.#diag("planner", error);
      failed = true;
    }
    // When halted, in-flight children may never settle (the transport was aborted): do not wait.
    const children = this.#halt
      ? await settledNow(node.children)
      : await Promise.all(node.children);
    let status: ReportStatus;
    const codes: OrchCode[] = [];
    if (this.#halt) {
      status = "killed";
      codes.push("KILLED");
    } else if (failed) {
      status = "unverified";
      codes.push("PLANNER_FAILED");
    } else if (children.length > 0 && children.every((child) => child.status === "done")) {
      status = "done";
    } else {
      status = "uncertain";
      codes.push("CHILDREN_INCOMPLETE");
    }
    const report = this.#plannerReport(node, status, codes, children);
    this.#recordPlanner(node, parentId, report);
    return report;
  }

  #plannerReport(
    node: PlannerNode,
    status: ReportStatus,
    codes: OrchCode[],
    children: readonly Report[],
  ): PlannerReport {
    return deepFreeze({
      kind: "planner",
      nodeId: node.nodeId,
      status,
      codes,
      children: [...children],
    });
  }

  #recordPlanner(node: PlannerNode, parentId: string | null, report: PlannerReport): void {
    this.#record({
      nodeId: node.nodeId,
      parentId,
      kind: "planner",
      depth: node.depth,
      status: report.status,
      gateCodes: [],
      codes: [...report.codes],
    });
    this.#log({
      type: "planner-end",
      nodeId: node.nodeId,
      parentId,
      status: report.status,
      codes: report.codes,
      children: report.children.map((c) => c.nodeId),
    });
  }
}

/** The children that have already settled; the rest are recorded as killed placeholders. */
async function settledNow(children: readonly Promise<Report>[]): Promise<Report[]> {
  const pending = Symbol("pending");
  const out: Report[] = [];
  for (const child of children) {
    const value = await Promise.race([child, Promise.resolve(pending)]);
    if (value === pending) continue;
    out.push(value as Report);
  }
  return out;
}
