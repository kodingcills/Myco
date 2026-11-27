/**
 * Track O: the guard. One per policed trial; every actuator wrapper asks it before forwarding.
 *
 * `startPolicy` is the only way to get one. It loads the host config (`./config.ts`), resolves
 * the trial scope, and checks a sensor exists for every declared rule kind that needs one. Any
 * failure refuses the trial with a closed code (`PolicyStartRefusal`); there is no fallback to
 * an unpoliced run.
 *
 * Each decision is appended to the host-side policy log as
 * `{ actionSeq, actuator, policyId, decision, code, configSha256 }`: closed values only (an
 * integer, two enums, an opaque id, a digest). Nothing the agent sent is written there or
 * returned to it. The agent-facing result of a held or refused action is `PolicyAgentCode` plus
 * the opaque policy id.
 *
 * Fail closed, everywhere:
 * - the facts reducer or the screen sensor throws  -> deny, `POLICY_ENGINE_ERROR`;
 * - the reducer says it cannot reduce the action   -> deny, `POLICY_ACTION_UNRECOGNISED`;
 * - the async path takes longer than `timeoutMs`    -> deny, `POLICY_ENGINE_TIMEOUT`;
 * - a synchronous path gets an async sensor reading -> deny, `POLICY_ENGINE_ERROR`;
 * - the config did not parse                         -> deny, `POLICY_CONFIG_INVALID`.
 *
 * The async path plugs into track N's seam (`guardAction`, `HandoffPolicy`, `PauseGate`):
 * `require-approval` becomes a forced handoff (N records it; the human approves, fixes or
 * rejects), `deny` a `PolicyDenial`. Synchronous actuators cannot wait for a human, so for them
 * `require-approval` is a refusal with `POLICY_APPROVAL_REQUIRED` (never an allow).
 */

import type { PolicyPauseRequest } from "../handoff/broker.ts";
import type { HandoffPolicy, PolicyDenial, ProposedAction } from "../handoff/policy.ts";
import type {
  ActuatorId,
  PolicyAgentCode,
  PolicyDecisionCode,
  PolicyDecisionKind,
  PolicyStartRefusal,
} from "./codes.ts";
import { loadPolicyConfig } from "./config.ts";
import {
  type ActionFacts,
  createPolicyEngine,
  type EngineDecision,
  type PolicyEngine,
  type TrialScope,
} from "./engine.ts";

export const POLICY_LOG_SCHEMA = "myco.policy.log/1" as const;
export const POLICY_ROW_SCHEMA = "myco.policy.row/1" as const;
export const DEFAULT_POLICY_TIMEOUT_MS = 2_000;

/** One host-side policy decision. Closed values only. */
export interface PolicyLogEntry {
  readonly actionSeq: number;
  readonly actuator: ActuatorId;
  readonly policyId: string | null;
  readonly decision: PolicyDecisionKind;
  readonly code: PolicyDecisionCode;
  readonly configSha256: string;
}

/** What a wrapper does with a decision. `agent` is all the agent may learn. */
export interface GuardDecision {
  readonly decision: PolicyDecisionKind;
  readonly code: PolicyDecisionCode;
  readonly policyId: string | null;
  readonly agent: { readonly code: PolicyAgentCode; readonly policyId: string | null } | null;
}

/** The per-trial row a pack is built from (`./pack.ts`). */
export interface PolicyRow {
  readonly schema: typeof POLICY_ROW_SCHEMA;
  readonly arm: string;
  readonly trialKey: string;
  readonly policed: boolean;
  readonly policyConfigSha256: string | null;
  readonly decisions: {
    readonly allow: number;
    readonly deny: number;
    readonly requireApproval: number;
  };
}

/** Thrown by a facts reducer for an action it cannot reduce: the action is denied. */
export class UnrecognisedAction extends Error {
  constructor() {
    super("POLICY_ACTION_UNRECOGNISED");
    this.name = "UnrecognisedAction";
  }
}

/** The host's screen sensor: true when the screen shows an instruction the policy flags. */
export type ScreenSensor = () => boolean | Promise<boolean>;

export interface StartPolicyOptions {
  /** Absolute host path of the policy config. */
  readonly configPath: string;
  readonly scope: TrialScope;
  /**
   * Roots the agent or guest can reach. The trial's document directory is always added; a
   * config inside any of them is refused.
   */
  readonly agentRoots?: readonly string[];
  /** Required when the config declares `flagged-screen`. */
  readonly screenSensor?: ScreenSensor;
  readonly timeoutMs?: number;
}

export type StartPolicyResult =
  | { readonly ok: true; readonly guard: PolicyGuard }
  | { readonly ok: false; readonly code: PolicyStartRefusal };

const AGENT_CODE: Readonly<Record<Exclude<PolicyDecisionKind, "allow">, PolicyAgentCode>> = {
  deny: "POLICY_DENIED",
  "require-approval": "POLICY_APPROVAL_REQUIRED",
};

const APPROVAL_NOTE = "A host policy requires approval for the agent's next action.";

function isThenable(v: unknown): v is PromiseLike<unknown> {
  return (
    (typeof v === "object" || typeof v === "function") &&
    v !== null &&
    typeof (v as { then?: unknown }).then === "function"
  );
}

export class PolicyGuard {
  readonly #engine: PolicyEngine;
  readonly #screen: ScreenSensor | null;
  readonly #timeoutMs: number;
  readonly #log: PolicyLogEntry[] = [];
  #seq = 0;

  /** Use `startPolicy`; the constructor is for tests that build an engine directly. */
  constructor(engine: PolicyEngine, screen: ScreenSensor | null, timeoutMs: number) {
    this.#engine = engine;
    this.#screen = screen;
    this.#timeoutMs = timeoutMs;
    Object.freeze(this);
  }

  get configSha256(): string {
    return this.#engine.configSha256;
  }

  get scope(): TrialScope {
    return this.#engine.scope;
  }

  #record(actuator: ActuatorId, d: EngineDecision): GuardDecision {
    this.#seq += 1;
    this.#log.push(
      Object.freeze({
        actionSeq: this.#seq,
        actuator,
        policyId: d.policyId,
        decision: d.decision,
        code: d.code,
        configSha256: this.#engine.configSha256,
      }),
    );
    return Object.freeze({
      decision: d.decision,
      code: d.code,
      policyId: d.policyId,
      agent:
        d.decision === "allow"
          ? null
          : Object.freeze({ code: AGENT_CODE[d.decision], policyId: d.policyId }),
    });
  }

  #fail(code: PolicyDecisionCode): EngineDecision {
    return { decision: "deny", code, policyId: null };
  }

  #reduce(reduce: () => ActionFacts): ActionFacts | EngineDecision {
    try {
      return reduce();
    } catch (err) {
      return this.#fail(
        err instanceof UnrecognisedAction ? "POLICY_ACTION_UNRECOGNISED" : "POLICY_ENGINE_ERROR",
      );
    }
  }

  #evaluate(facts: ActionFacts, screenFlagged: boolean): EngineDecision {
    try {
      return this.#engine.evaluate({ ...facts, screenFlagged });
    } catch {
      return this.#fail("POLICY_ENGINE_ERROR");
    }
  }

  /** Synchronous decision (sync actuators). An async sensor reading is a denial. */
  decide(actuator: ActuatorId, reduce: () => ActionFacts): GuardDecision {
    const facts = this.#reduce(reduce);
    if ("decision" in facts) return this.#record(actuator, facts);
    let flagged: unknown = false;
    if (this.#screen !== null) {
      try {
        flagged = this.#screen();
      } catch {
        return this.#record(actuator, this.#fail("POLICY_ENGINE_ERROR"));
      }
      if (isThenable(flagged)) {
        // A sync path cannot wait; swallow the reading so it never surfaces as unhandled.
        Promise.resolve(flagged).catch(() => {});
        return this.#record(actuator, this.#fail("POLICY_ENGINE_ERROR"));
      }
    }
    if (typeof flagged !== "boolean")
      return this.#record(actuator, this.#fail("POLICY_ENGINE_ERROR"));
    return this.#record(actuator, this.#evaluate(facts, flagged));
  }

  /** Asynchronous decision, bounded by `timeoutMs`. */
  async decideAsync(actuator: ActuatorId, reduce: () => ActionFacts): Promise<GuardDecision> {
    const work = (async (): Promise<EngineDecision> => {
      const facts = this.#reduce(reduce);
      if ("decision" in facts) return facts;
      let flagged: unknown = false;
      try {
        flagged = this.#screen === null ? false : await this.#screen();
      } catch {
        return this.#fail("POLICY_ENGINE_ERROR");
      }
      if (typeof flagged !== "boolean") return this.#fail("POLICY_ENGINE_ERROR");
      return this.#evaluate(facts, flagged);
    })();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<EngineDecision>((resolve) => {
      timer = setTimeout(() => resolve(this.#fail("POLICY_ENGINE_TIMEOUT")), this.#timeoutMs);
    });
    work.catch(() => {});
    try {
      const d = await Promise.race([work, timeout]);
      return this.#record(actuator, d);
    } catch {
      return this.#record(actuator, this.#fail("POLICY_ENGINE_ERROR"));
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * A one-shot `HandoffPolicy` for track N's `guardAction`, deciding one action. `onDecision`
   * receives the guard's decision (the wrapper needs the agent-facing code).
   */
  handoffPolicy(
    actuator: ActuatorId,
    reduce: () => ActionFacts,
    onDecision: (d: GuardDecision) => void,
  ): HandoffPolicy {
    return {
      id: "myco.policy.guard/1",
      evaluate: async (_action: ProposedAction) => {
        const d = await this.decideAsync(actuator, reduce);
        onDecision(d);
        if (d.decision === "allow") return null;
        // A denial with no deciding rule (engine error, timeout, unrecognised action) still
        // carries a valid id for the host record.
        const policyId = d.policyId ?? "pol-guard";
        if (d.decision === "deny") return { deny: true, policyId } satisfies PolicyDenial;
        return {
          policyId,
          reason: "needs-approval",
          note: APPROVAL_NOTE,
        } satisfies PolicyPauseRequest;
      },
    };
  }

  /** Record that an allowed action was forwarded (destructive-operation count). */
  commit(facts: ActionFacts): void {
    this.#engine.commit(facts);
  }

  log(): readonly PolicyLogEntry[] {
    return Object.freeze([...this.#log]);
  }

  row(arm: string, trialKey: string): PolicyRow {
    let allow = 0;
    let deny = 0;
    let requireApproval = 0;
    for (const e of this.#log) {
      if (e.decision === "allow") allow += 1;
      else if (e.decision === "deny") deny += 1;
      else requireApproval += 1;
    }
    return Object.freeze({
      schema: POLICY_ROW_SCHEMA,
      arm,
      trialKey,
      policed: true,
      policyConfigSha256: this.#engine.configSha256,
      decisions: Object.freeze({ allow, deny, requireApproval }),
    });
  }
}

/** The row of a trial run with policies off (arm `B`): no hash, no decisions. */
export function unpolicedRow(arm: string, trialKey: string): PolicyRow {
  return Object.freeze({
    schema: POLICY_ROW_SCHEMA,
    arm,
    trialKey,
    policed: false,
    policyConfigSha256: null,
    decisions: Object.freeze({ allow: 0, deny: 0, requireApproval: 0 }),
  });
}

/** Start a policed trial's guard, or refuse the trial. */
export function startPolicy(options: StartPolicyOptions): StartPolicyResult {
  const timeoutMs = options.timeoutMs ?? DEFAULT_POLICY_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000)
    return { ok: false, code: "POLICY_SCOPE_INVALID" };
  const scope = options.scope;
  if (typeof scope !== "object" || scope === null)
    return { ok: false, code: "POLICY_SCOPE_INVALID" };
  const loaded = loadPolicyConfig(options.configPath, {
    agentRoots: [scope.documentDir, ...(options.agentRoots ?? [])],
  });
  if (!loaded.ok) return loaded;
  let engine: PolicyEngine;
  try {
    engine = createPolicyEngine(loaded.sha256, loaded.config, scope);
  } catch {
    // `PolicyScopeError`, or anything else: the scope could not be pinned.
    return { ok: false, code: "POLICY_SCOPE_INVALID" };
  }
  const screen = options.screenSensor ?? null;
  if (engine.kinds.has("flagged-screen") && typeof screen !== "function")
    return { ok: false, code: "POLICY_SENSOR_MISSING" };
  return { ok: true, guard: new PolicyGuard(engine, screen, timeoutMs) };
}
