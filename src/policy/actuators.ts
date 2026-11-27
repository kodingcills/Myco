/**
 * Track O: policed wrappers, one per actuator entry point.
 *
 * Every path by which an agent action reaches an app or the guest is one of these interfaces:
 *
 *   app-adapter.act          `AppAdapter.act`              (src/core/adapter.ts)       async
 *   desktop-transport.act    `DesktopTransport.act`        (src/discovery/live-runner.ts) async
 *   linux-actuator.act       `Actuator.act`                (src/linux/actuator.ts)     sync
 *   cross-app.calc-set       `CrossAppActuator.calcSet`    (src/gate/cross-app-demo.ts) sync
 *   cross-app.writer-append  `CrossAppActuator.writerAppend`                           sync
 *   action-router.policy     `ActionPolicy.check`          (src/actions/policy.ts: every
 *                            route of track J's router goes through it before it runs)
 *
 * Each wrapper reduces the action to `ActionFacts` HOST-SIDE, asks the guard, and forwards only
 * on allow (or, on the async paths, on a human's approval through track N's handoff). A refusal
 * returns the closed agent code through the interface's existing result channel; nothing the
 * agent sent is echoed. `test/policy/actuators.test.ts` enumerates `ACTUATOR_WRAPPERS` against
 * the interfaces in `src/` and proves each wrapper calls the guard before forwarding.
 *
 * The desktop-transport, Linux and cross-app interfaces are declared here structurally (the same
 * shapes; a type test pins compatibility) so the policy module never imports the evidence
 * writer, a process launcher or the gate package that host those interfaces.
 *
 * Known limit (follow-up): a `click` carries only a target ref, so these reducers cannot tell a
 * click on a Save or Delete button from any other click; the independent violation checker
 * (`src/violations/`) still sees the result in the file-system diff. Classifying click targets
 * needs track I's live state.
 */

import { existsSync } from "node:fs";
import { basename, isAbsolute } from "node:path";
import { type ActionPolicy, type PolicyRequest, resolveScoped } from "../actions/policy.ts";
import type { ActResult, AppAdapter, ProgramAction, TargetRef } from "../core/adapter.ts";
import type { PauseGate, PolicyTrigger } from "../handoff/broker.ts";
import { guardAction } from "../handoff/policy.ts";
import { chordEffect } from "./chord.ts";
import type { ActuatorId, PolicyAgentCode } from "./codes.ts";
import type { ActionFacts, TrialScope } from "./engine.ts";
import { type GuardDecision, type PolicyGuard, UnrecognisedAction } from "./guard.ts";

/** The wrapper guarding each actuator entry point. A test pins that this is complete. */
export const ACTUATOR_WRAPPERS: Readonly<Record<ActuatorId, string>> = {
  "app-adapter.act": "policedAppAdapter",
  "desktop-transport.act": "policedDesktopTransport",
  "linux-actuator.act": "policedLinuxActuator",
  "cross-app.calc-set": "policedCrossAppActuator",
  "cross-app.writer-append": "policedCrossAppActuator",
  "action-router.policy": "guardedActionPolicy",
};

/** What the agent can see of a refusal: a code, never more. */
export type PolicedCode = PolicyAgentCode | "ATTEMPT_ENDED";

/** Thrown by sync wrappers whose interface returns nothing. The message is the code only. */
export class PolicyRefusal extends Error {
  readonly code: PolicedCode;
  readonly policyId: string | null;
  constructor(code: PolicedCode, policyId: string | null) {
    super(code);
    this.name = "PolicyRefusal";
    this.code = code;
    this.policyId = policyId;
  }
}

const NO_FACTS: ActionFacts = Object.freeze({
  writes: Object.freeze([]),
  deletes: Object.freeze([]),
  launches: Object.freeze([]),
  credentialInput: false,
  destructive: 0,
});

/** A refusal's agent-facing text: the closed code and the opaque policy id. */
export function refusalText(code: PolicedCode, policyId: string | null): string {
  return policyId === null ? code : `${code} ${policyId}`;
}

// ---------------------------------------------------------------------------------------------
// Host-side reducers.

/** A host path the action writes, resolved through symlinks; unresolvable is unrecognised. */
function hostPath(raw: unknown): string {
  if (typeof raw !== "string" || !isAbsolute(raw)) throw new UnrecognisedAction();
  const p = resolveScoped(raw, "/");
  if (p === null) throw new UnrecognisedAction();
  return p;
}

function writeFacts(paths: readonly string[]): ActionFacts {
  const writes = paths.map(hostPath);
  return {
    ...NO_FACTS,
    writes,
    destructive: writes.filter((p) => existsSync(p)).length,
  };
}

/**
 * Key chords, parsed exactly as the guest parses them (`./chord.ts`): Save writes over the
 * original document; any chord not on the closed allow-list (Save As, menu accelerators, close
 * chords whose dialog defaults to Save, a chord the guest would refuse) is unrecognised.
 */
export function keyFacts(keys: unknown, scope: TrialScope): ActionFacts {
  const effect = chordEffect(keys);
  if (effect === "unknown") throw new UnrecognisedAction();
  if (effect === "save") return { ...NO_FACTS, writes: [scope.originalDocument], destructive: 1 };
  return NO_FACTS;
}

// C0 controls other than tab, newline and carriage return, and DEL. Typed through XTest such a
// character can arrive as a control chord (U+0013 is Ctrl+S), so typed text carrying one is
// unrecognised rather than guessed at.
// biome-ignore lint/suspicious/noControlCharactersInRegex: the control characters are the point.
const CONTROL_CHAR = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

/** Typed text: refuse control characters; otherwise only the credential classifier matters. */
function typedFacts(text: unknown, credentialInput: () => boolean): ActionFacts {
  if (typeof text !== "string" || CONTROL_CHAR.test(text)) throw new UnrecognisedAction();
  return { ...NO_FACTS, credentialInput: credentialInput() };
}

/** Reduce an `AppAdapter` action. */
export function adapterFacts(
  action: ProgramAction,
  scope: TrialScope,
  isCredentialTarget: (ref: TargetRef) => boolean,
): ActionFacts {
  if (typeof action !== "object" || action === null) throw new UnrecognisedAction();
  switch (action.kind) {
    case "click":
    case "waitFor":
      return NO_FACTS;
    case "typeText":
      return typedFacts(action.text, () => isCredentialTarget(action.ref));
    case "setValue":
      return { ...NO_FACTS, credentialInput: isCredentialTarget(action.ref) };
    case "keyPress":
      return keyFacts(action.keys, scope);
    default:
      throw new UnrecognisedAction();
  }
}

function policedCode(decided: GuardDecision | null): PolicedCode {
  if (decided === null) return "ATTEMPT_ENDED";
  return decided.agent?.code ?? "POLICY_DENIED";
}

/**
 * The async guard step shared by the async wrappers: wait on N's pause gate, decide (which
 * reserves the action's destructive operations), open a handoff for `require-approval`. On
 * proceed the reservation is committed before the caller forwards; on anything else it is
 * released. The reservation is taken at decision time, so actions running concurrently (or
 * waiting on a human) can never all pass `destructive-limit` against the same count.
 */
async function guardAsync(
  guard: PolicyGuard,
  trigger: PolicyTrigger & PauseGate,
  actuator: ActuatorId,
  reduce: () => ActionFacts,
): Promise<{ ok: true } | { ok: false; code: PolicedCode; policyId: string | null }> {
  let reduced = false;
  let decided: GuardDecision | null = null;
  const memo = (): ActionFacts => {
    const facts = reduce();
    reduced = true;
    return facts;
  };
  const policy = guard.handoffPolicy(actuator, memo, (d) => {
    decided = d;
  });
  let proceed = false;
  try {
    const outcome = await guardAction(policy, trigger, { tool: actuator, args: {} });
    proceed = outcome.kind === "proceed" && reduced && decided !== null;
  } finally {
    // Settled exactly once, on every path (a throw included): a hold is never left reserved.
    const d = decided as GuardDecision | null;
    if (proceed) d?.hold.commit();
    else d?.hold.release();
  }
  if (proceed) return { ok: true };
  const d = decided as GuardDecision | null;
  return { ok: false, code: policedCode(d), policyId: d?.policyId ?? null };
}

/** Settle a sync decision's hold: commit on allow (the caller forwards), release otherwise. */
function settle(d: GuardDecision): boolean {
  if (d.decision === "allow") {
    d.hold.commit();
    return true;
  }
  d.hold.release();
  return false;
}

/**
 * A trigger for a policed trial run without track N's broker: nothing is ever paused, and a
 * `require-approval` cannot reach a human, so it is cancelled (the action is not forwarded).
 */
export const NO_APPROVALS: PolicyTrigger & PauseGate = Object.freeze({
  awaitClear: async () => "clear" as const,
  forcePause: async () => ({ status: "ended" as const, code: "HANDOFF_CANCELLED" as const }),
});

// ---------------------------------------------------------------------------------------------
// app-adapter.act

export interface AdapterGuardOptions {
  /** Track N's broker (`broker.policyTrigger()`), or `NO_APPROVALS`. */
  readonly trigger: PolicyTrigger & PauseGate;
  /** Host classifier: does this target ref name a credential field? */
  readonly isCredentialTarget: (ref: TargetRef) => boolean;
}

export function policedAppAdapter(
  inner: AppAdapter,
  guard: PolicyGuard,
  options: AdapterGuardOptions,
): AppAdapter {
  const wrapped: AppAdapter = {
    observe: () => inner.observe(),
    capabilities: () => inner.capabilities(),
    async act(action: ProgramAction): Promise<ActResult> {
      const r = await guardAsync(guard, options.trigger, "app-adapter.act", () =>
        adapterFacts(action, guard.scope, options.isCredentialTarget),
      );
      if (!r.ok) return { outcome: "failed", details: refusalText(r.code, r.policyId) };
      return inner.act(action);
    },
  };
  if (inner.issueRef) {
    const issue = inner.issueRef.bind(inner);
    return { ...wrapped, issueRef: (nodeId: string) => issue(nodeId) };
  }
  return wrapped;
}

// ---------------------------------------------------------------------------------------------
// desktop-transport.act (structural copy of src/discovery/live-runner.ts's types)

export type GuardedDesktopAction =
  | { readonly kind: "launch"; readonly command: string; readonly args: readonly string[] }
  | { readonly kind: "typeTextGlobal"; readonly text: string }
  | { readonly kind: "clickAt"; readonly x: number; readonly y: number }
  | { readonly kind: "keyPress"; readonly keys: string };

export type GuardedOutcome = "delivered_verified" | "delivered_unverified" | "failed";

export interface GuardedDesktopTransport<S> {
  create(): Promise<S>;
  observe(session: S): Promise<unknown>;
  act(session: S, action: GuardedDesktopAction): Promise<GuardedOutcome>;
  readFile(session: S, path: string): Promise<string>;
  reset(session: S): Promise<void>;
  destroy(session: S): Promise<void>;
}

/** The app id a launch names: the command's base name, lower-cased. Compared, never echoed. */
export function launchedApp(command: unknown): string {
  if (typeof command !== "string" || command.length === 0) throw new UnrecognisedAction();
  return basename(command).toLowerCase();
}

export function desktopFacts(
  action: GuardedDesktopAction,
  scope: TrialScope,
  focusIsCredential: () => boolean,
): ActionFacts {
  if (typeof action !== "object" || action === null) throw new UnrecognisedAction();
  switch (action.kind) {
    case "launch":
      return { ...NO_FACTS, launches: [launchedApp(action.command)] };
    case "typeTextGlobal":
      return typedFacts(action.text, focusIsCredential);
    case "clickAt":
      return NO_FACTS;
    case "keyPress":
      return keyFacts(action.keys, scope);
    default:
      throw new UnrecognisedAction();
  }
}

export interface DesktopGuardOptions<S> {
  readonly trigger: PolicyTrigger & PauseGate;
  /** Host classifier: is the focused field of `session` a credential field? */
  readonly focusIsCredential: (session: S) => boolean;
}

/**
 * The transport's `act` has no code channel: a refusal is `failed` (the guard's log keeps the
 * code). Every other method passes through; none of them acts on the agent's behalf.
 */
export function policedDesktopTransport<S, T extends GuardedDesktopTransport<S>>(
  inner: T,
  guard: PolicyGuard,
  options: DesktopGuardOptions<S>,
): T {
  return {
    ...inner,
    create: () => inner.create(),
    observe: (s: S) => inner.observe(s),
    readFile: (s: S, p: string) => inner.readFile(s, p),
    reset: (s: S) => inner.reset(s),
    destroy: (s: S) => inner.destroy(s),
    async act(session: S, action: GuardedDesktopAction): Promise<GuardedOutcome> {
      const r = await guardAsync(guard, options.trigger, "desktop-transport.act", () =>
        desktopFacts(action, guard.scope, () => options.focusIsCredential(session)),
      );
      if (!r.ok) return "failed";
      return inner.act(session, action);
    },
  };
}

// ---------------------------------------------------------------------------------------------
// linux-actuator.act (structural copy of src/linux/actuator.ts's types)

export interface GuardedActuatorReport {
  readonly ok: boolean;
  readonly error?: string;
}

export interface GuardedLinuxActuator<R extends GuardedActuatorReport> {
  act(docPath: string, cell: string, value: string, save: boolean): R;
}

export function policedLinuxActuator<R extends GuardedActuatorReport>(
  inner: GuardedLinuxActuator<R>,
  guard: PolicyGuard,
): GuardedLinuxActuator<R | GuardedActuatorReport> {
  return {
    act(docPath, cell, value, save) {
      // The cell and value are typed into a spreadsheet cell, never a credential field; the
      // only file effect is the save over `docPath`.
      const d = guard.decide("linux-actuator.act", () =>
        save === false ? NO_FACTS : writeFacts([docPath]),
      );
      if (!settle(d)) return { ok: false, error: refusalText(policedCode(d), d.policyId) };
      return inner.act(docPath, cell, value, save);
    },
  };
}

// ---------------------------------------------------------------------------------------------
// cross-app.* (structural copy of src/gate/cross-app-demo.ts's CrossAppActuator)

export interface GuardedCrossAppActuator {
  readonly name: string;
  calcSet(sheetPath: string, ref: string, value: string): void;
  writerAppend(reportPath: string, label: string, text: string): void;
}

export function policedCrossAppActuator<T extends GuardedCrossAppActuator>(
  inner: T,
  guard: PolicyGuard,
): GuardedCrossAppActuator {
  const step = (actuator: ActuatorId, path: string, forward: () => void): void => {
    const d = guard.decide(actuator, () => writeFacts([path]));
    if (!settle(d)) throw new PolicyRefusal(policedCode(d), d.policyId);
    forward();
  };
  return {
    name: inner.name,
    calcSet(sheetPath, ref, value) {
      step("cross-app.calc-set", sheetPath, () => inner.calcSet(sheetPath, ref, value));
    },
    writerAppend(reportPath, label, text) {
      step("cross-app.writer-append", reportPath, () =>
        inner.writerAppend(reportPath, label, text),
      );
    },
  };
}

// ---------------------------------------------------------------------------------------------
// action-router.policy (track J's seam: every route is checked here before it runs)

/**
 * Compose O's guard after track J's workspace policy: J's check runs first (it resolves the
 * paths and refuses anything outside the workspace); O then judges the resolved writes. A
 * denial never falls back to another route (J's rule). J's program allow-list governs which
 * programs the script route runs, so the router's facts carry no app launch.
 */
export function guardedActionPolicy(inner: ActionPolicy, guard: PolicyGuard): ActionPolicy {
  return {
    id: inner.id,
    check(request: PolicyRequest) {
      const base = inner.check(request);
      if (!base.allow) return base;
      const d = guard.decide("action-router.policy", () => writeFacts(base.writes));
      if (!settle(d)) return { allow: false, code: policedCode(d) as PolicyAgentCode };
      return base;
    },
  };
}
