/**
 * Track O: policed wrappers, one per actuator entry point.
 *
 * Every host actuator interface by which an agent action reaches an app or the guest is one of
 * these (the `myco-rt` MCP tools the agent calls directly are not wrapped; `./surface.ts` keeps
 * them out of policed trials):
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
 * click on a Save or Delete button from any other click, nor a click that opens the File menu
 * (after which a plain `s`, the mnemonic, saves); the independent violation checker
 * (`src/violations/`) still sees the result in the file-system diff. Classifying click targets
 * needs track I's live state.
 *
 * A desktop `launch` is recognised only for a program the host lists by its real absolute path
 * (`LaunchTable`), with no arguments or exactly one argument vector the host declared for it.
 * Its base name is never judged: the guest runs any command with any arguments, and the file
 * effect of an argument vector is not inferred here. What a listed program does once running
 * (typed text into a launched terminal or editor) is the remaining limit, governed only by
 * `app-allowlist`.
 *
 * A forwarded action's destructive slot stays spent even if the app then fails: the policy
 * cannot know whether the write happened, so it counts it.
 *
 * What runs is what was judged (#605 item 2). Each async wrapper takes a frozen copy of the
 * action when it is called, reading every field once (`frozenAdapterAction`,
 * `frozenDesktopAction`), reduces THAT copy, and forwards THAT copy. The caller's object can be
 * changed while the action waits on the pause gate or a human's approval, or can carry getters
 * that answer differently on each read; neither reaches the inner actuator. A copy that cannot be
 * taken (a getter throws, a field has the wrong type) is `POLICY_ACTION_UNRECOGNISED`. The sync
 * wrappers take primitives only and run with no wait between judging and forwarding; the router
 * wrapper returns a frozen copy of the decision whose writes it judged.
 */

import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
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

/** A frozen copy of a target ref: a string, or `{ nodeId }` with nothing else carried over. */
function frozenRef(ref: unknown): TargetRef | null {
  if (typeof ref === "string") return ref;
  if (typeof ref !== "object" || ref === null) return null;
  const nodeId: unknown = (ref as { nodeId?: unknown }).nodeId;
  return typeof nodeId === "string" ? Object.freeze({ nodeId }) : null;
}

/**
 * A frozen copy of an `AppAdapter` action, each field read once; null when it is malformed or a
 * read throws. The policy judges this copy and the wrapper forwards this copy.
 */
export function frozenAdapterAction(action: unknown): ProgramAction | null {
  try {
    if (typeof action !== "object" || action === null) return null;
    const a = action as Record<string, unknown>;
    const kind = a.kind;
    switch (kind) {
      case "click": {
        const ref = frozenRef(a.ref);
        return ref === null ? null : Object.freeze({ kind, ref });
      }
      case "typeText": {
        const ref = frozenRef(a.ref);
        const text = a.text;
        return ref === null || typeof text !== "string" ? null : Object.freeze({ kind, ref, text });
      }
      case "setValue": {
        const ref = frozenRef(a.ref);
        const value = a.value;
        return ref === null || typeof value !== "string"
          ? null
          : Object.freeze({ kind, ref, value });
      }
      case "keyPress": {
        const keys = a.keys;
        return typeof keys === "string" ? Object.freeze({ kind, keys }) : null;
      }
      case "waitFor": {
        // Has no file effect; the predicate is the host's own function and is passed as is.
        const predicate = a.predicate;
        const timeoutMs = a.timeoutMs;
        return typeof predicate === "function" && typeof timeoutMs === "number"
          ? Object.freeze({
              kind,
              predicate: predicate as Extract<ProgramAction, { kind: "waitFor" }>["predicate"],
              timeoutMs,
            })
          : null;
      }
      default:
        return null;
    }
  } catch {
    return null;
  }
}

/** Reduce a frozen copy, or refuse a copy that could not be taken. */
function reduceFrozen<A>(frozen: A | null, reduce: (a: A) => ActionFacts): () => ActionFacts {
  return () => {
    if (frozen === null) throw new UnrecognisedAction();
    return reduce(frozen);
  };
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
      // Copied before any wait: the copy is judged, and the copy is what runs.
      const frozen = frozenAdapterAction(action);
      const r = await guardAsync(
        guard,
        options.trigger,
        "app-adapter.act",
        reduceFrozen(frozen, (a) => adapterFacts(a, guard.scope, options.isCredentialTarget)),
      );
      if (!r.ok) return { outcome: "failed", details: refusalText(r.code, r.policyId) };
      // Unreachable (a null copy is unrecognised, so denied); kept so nothing else is forwarded.
      if (frozen === null) return { outcome: "failed", details: "POLICY_DENIED" };
      return inner.act(frozen);
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

/**
 * One program the host lets the agent launch. The guest runs `Command::new(command).args(args)`
 * (`runtime/crates/myco-rt-agent/src/processes.rs`), so a launch's file effect depends on its
 * whole argument vector, not on the program's name: `cp A B` overwrites B, and
 * `soffice --convert-to xlsx --outdir D F` overwrites `D/F.xlsx` without asking.
 */
export interface LaunchEntry {
  /** The app id `app-allowlist` judges (for example `soffice`). */
  readonly app: string;
  /**
   * The exact argument vectors the host allows, compared element by element (a closed shape,
   * as track J's `SHELL_PROGRAMS` is). Absent or empty: the program launches with no arguments
   * only. The host lists only vectors with no file effect (no path operands, no output or
   * conversion options).
   */
  readonly argv?: readonly (readonly string[])[];
}

/**
 * The host's launch list, keyed by the program's real absolute path (no symlink hop, no `..`,
 * no `.`, no doubled `/`). A launch is judged by that path, never by its base name.
 */
export type LaunchTable = Readonly<Record<string, LaunchEntry>>;

/** The canonical spelling of an absolute path: what the kernel would resolve, hop-free. */
function canonicalCommand(raw: unknown): string | null {
  // `resolveScoped` refuses control characters and hard-linked files, and resolves every symlink
  // hop, `.`, `..` and doubled or trailing `/` to an absolute real path. A spelling that differs
  // from that resolution (a bare or relative name included) is not the listed program itself.
  if (typeof raw !== "string") return null;
  return resolveScoped(raw, "/") === raw ? raw : null;
}

function cleanArgv(v: unknown): v is readonly string[] {
  return Array.isArray(v) && v.length <= 64 && v.every((a) => typeof a === "string");
}

/** Copy and check a host launch table at wrapper construction; a malformed one throws. */
export function freezeLaunchTable(table: LaunchTable): ReadonlyMap<string, LaunchEntry> {
  const out = new Map<string, LaunchEntry>();
  if (typeof table !== "object" || table === null) throw new Error("POLICY_LAUNCH_TABLE_INVALID");
  for (const [path, entry] of Object.entries(table)) {
    const argv = entry?.argv ?? [];
    if (
      typeof path !== "string" ||
      !isAbsolute(path) ||
      resolve(path) !== path ||
      typeof entry?.app !== "string" ||
      entry.app.length === 0 ||
      entry.app.length > 256 ||
      !Array.isArray(argv) ||
      !argv.every(cleanArgv)
    )
      throw new Error("POLICY_LAUNCH_TABLE_INVALID");
    out.set(path, Object.freeze({ app: entry.app, argv: argv.map((a) => Object.freeze([...a])) }));
  }
  return out;
}

/**
 * Reduce a launch. Unrecognised unless the command is the canonical real path of a program the
 * host listed AND its arguments are empty or exactly one of that program's declared vectors.
 * A bare name (the guest would search its PATH), a relative or symlinked spelling, another
 * binary sharing a listed base name, and any undeclared argument all fail closed.
 */
export function launchFacts(
  command: unknown,
  args: unknown,
  table: ReadonlyMap<string, LaunchEntry>,
): ActionFacts {
  const path = canonicalCommand(command);
  if (path === null) throw new UnrecognisedAction();
  const entry = table.get(path);
  if (entry === undefined || !Array.isArray(args)) throw new UnrecognisedAction();
  if (args.length > 0) {
    // Strict element equality with a declared vector of strings: a non-string argument, an
    // extra or missing argument, or any other spelling never matches.
    const declared = entry.argv ?? [];
    const same = (v: readonly string[]) =>
      v.length === args.length && v.every((x, k) => x === args[k]);
    if (!declared.some(same)) throw new UnrecognisedAction();
  }
  return { ...NO_FACTS, launches: [entry.app] };
}

/**
 * A frozen copy of a desktop action, each field read once; null when it is malformed or a read
 * throws. A launch's arguments are copied into a frozen array of strings.
 */
export function frozenDesktopAction(action: unknown): GuardedDesktopAction | null {
  try {
    if (typeof action !== "object" || action === null) return null;
    const a = action as Record<string, unknown>;
    const kind = a.kind;
    switch (kind) {
      case "launch": {
        const command = a.command;
        const raw = a.args;
        if (typeof command !== "string" || !Array.isArray(raw) || raw.length > 64) return null;
        const args: unknown[] = Array.from(raw);
        if (!args.every((x) => typeof x === "string")) return null;
        return Object.freeze({ kind, command, args: Object.freeze(args as string[]) });
      }
      case "typeTextGlobal": {
        const text = a.text;
        return typeof text === "string" ? Object.freeze({ kind, text }) : null;
      }
      case "clickAt": {
        const x = a.x;
        const y = a.y;
        return Number.isFinite(x) && Number.isFinite(y)
          ? Object.freeze({ kind, x: x as number, y: y as number })
          : null;
      }
      case "keyPress": {
        const keys = a.keys;
        return typeof keys === "string" ? Object.freeze({ kind, keys }) : null;
      }
      default:
        return null;
    }
  } catch {
    return null;
  }
}

export function desktopFacts(
  action: GuardedDesktopAction,
  scope: TrialScope,
  focusIsCredential: () => boolean,
  launches: ReadonlyMap<string, LaunchEntry>,
): ActionFacts {
  if (typeof action !== "object" || action === null) throw new UnrecognisedAction();
  switch (action.kind) {
    case "launch":
      return launchFacts(action.command, action.args, launches);
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
  /** The programs the agent may launch (`LaunchTable`). Empty: every launch is unrecognised. */
  readonly launches: LaunchTable;
}

/**
 * The transport's `act` has no code channel: a refusal is `failed` (the guard's log keeps the
 * code). Every other method passes through; none of them acts on the agent's behalf.
 *
 * The result is a fresh object with exactly the six interface methods (#605 item 4). It never
 * spreads the inner transport, so none of its own fields (a class's raw MCP client, say) is
 * reachable through the policed transport, and the type claims nothing more than it has.
 */
export function policedDesktopTransport<S>(
  inner: GuardedDesktopTransport<S>,
  guard: PolicyGuard,
  options: DesktopGuardOptions<S>,
): GuardedDesktopTransport<S> {
  const launches = freezeLaunchTable(options.launches);
  return Object.freeze({
    create: () => inner.create(),
    observe: (s: S) => inner.observe(s),
    readFile: (s: S, p: string) => inner.readFile(s, p),
    reset: (s: S) => inner.reset(s),
    destroy: (s: S) => inner.destroy(s),
    async act(session: S, action: GuardedDesktopAction): Promise<GuardedOutcome> {
      // Copied before any wait: the copy is judged, and the copy is what runs.
      const frozen = frozenDesktopAction(action);
      const r = await guardAsync(
        guard,
        options.trigger,
        "desktop-transport.act",
        reduceFrozen(frozen, (a) =>
          desktopFacts(a, guard.scope, () => options.focusIsCredential(session), launches),
        ),
      );
      if (!r.ok || frozen === null) return "failed";
      return inner.act(session, frozen);
    },
  });
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
      // One frozen copy of J's decision: its writes are judged, and it is what the router runs.
      const writes = Object.freeze(Array.from(base.writes));
      const reads = Object.freeze(Array.from(base.reads));
      const argv = base.argv === undefined ? undefined : Object.freeze(Array.from(base.argv));
      const d = guard.decide("action-router.policy", () => writeFacts(writes));
      if (!settle(d)) return { allow: false, code: policedCode(d) as PolicyAgentCode };
      return Object.freeze(
        argv === undefined
          ? { allow: true, code: "ALLOWED", reads, writes }
          : { allow: true, code: "ALLOWED", reads, writes, argv },
      );
    },
  };
}
