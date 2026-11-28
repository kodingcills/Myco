/**
 * Track O: the policy engine. Pure decisions over host-reduced facts.
 *
 * The engine never sees what the agent typed or which path it spelled. Each actuator wrapper
 * (`./actuators.ts`) reduces a proposed action, host-side, to `ActionFacts`: the resolved
 * absolute paths it will write or delete, the app ids it will launch, whether it types into a
 * credential field (the host's classifier, never the agent's claim), and how many destructive
 * operations it is. The guard adds the host screen sensor's flag. The engine then evaluates
 * EVERY declared rule; the most restrictive result wins (`deny` over `require-approval` over
 * `allow`), and among equals the first rule in config order names the decision.
 *
 * Fail closed: facts that are not exactly the closed shape (a relative or unnormalised path,
 * a non-boolean flag, a negative count) are `POLICY_ACTION_UNRECOGNISED`, denied. An engine
 * built from an invalid config denies every action with `POLICY_CONFIG_INVALID`.
 *
 * The engine holds one piece of trial state: the destructive operations already forwarded plus
 * those reserved by decided actions that have not settled yet. `decide` judges and reserves in
 * one synchronous step, so concurrent async actions can never all pass against the same count
 * (the limit holds exactly); the caller commits the hold when it forwards and releases it when
 * it does not. Nothing on the engine can relax, disable or replace a rule: the rules are frozen
 * at construction and there is no setter.
 *
 * It has no reference to the gate, vault, task registry, grader or evidence root, and adds no
 * `myco.gate/v1` field (`test/policy/boundary.test.ts`).
 */

import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  type PolicyDecisionCode,
  type PolicyDecisionKind,
  type PolicyRuleKind,
  RULE_CODE,
} from "./codes.ts";
import type { PolicyConfig, PolicyRule } from "./config.ts";

/** What one proposed action does, reduced by the host. Never agent text. */
export interface ActionFacts {
  /** Resolved absolute host paths the action writes or creates. */
  readonly writes: readonly string[];
  /** Resolved absolute host paths the action deletes. */
  readonly deletes: readonly string[];
  /** App ids the action launches. */
  readonly launches: readonly string[];
  /** The host classifier says the action types into a credential field. */
  readonly credentialInput: boolean;
  /** Destructive operations this action performs (deletes, overwrites of existing bytes). */
  readonly destructive: number;
}

/** The facts plus the host screen sensor's flag, as the engine judges them. */
export interface EngineInput extends ActionFacts {
  readonly screenFlagged: boolean;
}

/** The trial's host-side scope: the original document and its directory. */
export interface TrialScope {
  readonly originalDocument: string;
  readonly documentDir: string;
}

export interface EngineDecision {
  readonly decision: PolicyDecisionKind;
  readonly code: PolicyDecisionCode;
  /** Opaque id of the deciding rule (`pol-<12 hex>`), null when no rule matched. */
  readonly policyId: string | null;
}

export interface PolicyEngine {
  readonly configSha256: string;
  readonly scope: TrialScope;
  /** Rule kinds the config declares (the guard checks it has a sensor for each that needs one). */
  readonly kinds: readonly PolicyRuleKind[];
  /** Judge `input` against the forwarded and reserved destructive counts. Reserves nothing. */
  evaluate(input: EngineInput): EngineDecision;
  /**
   * Judge `input` and, unless denied, reserve its destructive operations in the same
   * synchronous step. The caller settles the hold exactly once: `commit` when the action is
   * forwarded, `release` when it is not.
   */
  decide(input: EngineInput): EngineVerdict;
  /**
   * Host-side snapshot of the destructive accounting: operations forwarded (`spent`) and held
   * by decided, unsettled actions (`reserved`). Never agent-facing.
   */
  usage(): { readonly spent: number; readonly reserved: number };
}

/** A reservation of destructive operations. Settling twice is a no-op. */
export interface DestructiveHold {
  /** The action was forwarded: the reserved operations count as spent. */
  commit(): void;
  /** The action was not forwarded: the reservation is returned. */
  release(): void;
}

export interface EngineVerdict {
  readonly decision: EngineDecision;
  readonly hold: DestructiveHold;
}

export class PolicyScopeError extends Error {
  readonly code = "POLICY_SCOPE_INVALID" as const;
  constructor() {
    super("POLICY_SCOPE_INVALID");
    this.name = "PolicyScopeError";
  }
}

/** The opaque id the agent and the log see for a rule: never the declared id or its text. */
export function opaquePolicyId(configSha256: string, ruleId: string): string {
  const h = createHash("sha256").update(`${configSha256}\0${ruleId}`).digest("hex");
  return `pol-${h.slice(0, 12)}`;
}

function within(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function cleanPath(p: unknown): p is string {
  return (
    typeof p === "string" && p.length > 0 && p.length <= 4096 && isAbsolute(p) && resolve(p) === p
  );
}

function cleanList(v: unknown, check: (x: unknown) => boolean): boolean {
  return Array.isArray(v) && v.length <= 64 && v.every(check);
}

function validInput(i: unknown): i is EngineInput {
  if (typeof i !== "object" || i === null) return false;
  const o = i as Record<string, unknown>;
  return (
    cleanList(o.writes, cleanPath) &&
    cleanList(o.deletes, cleanPath) &&
    cleanList(o.launches, (a) => typeof a === "string" && a.length > 0 && a.length <= 256) &&
    typeof o.credentialInput === "boolean" &&
    typeof o.screenFlagged === "boolean" &&
    typeof o.destructive === "number" &&
    Number.isInteger(o.destructive) &&
    o.destructive >= 0 &&
    o.destructive <= 1000
  );
}

function resolveScope(scope: TrialScope): TrialScope {
  try {
    if (!isAbsolute(scope.originalDocument) || !isAbsolute(scope.documentDir))
      throw new PolicyScopeError();
    const documentDir = realpathSync.native(scope.documentDir);
    const originalDocument = realpathSync.native(scope.originalDocument);
    if (!statSync(documentDir).isDirectory() || !statSync(originalDocument).isFile())
      throw new PolicyScopeError();
    if (!within(originalDocument, documentDir) || originalDocument === documentDir)
      throw new PolicyScopeError();
    return Object.freeze({ originalDocument, documentDir });
  } catch {
    throw new PolicyScopeError();
  }
}

/** Does `rule` match `input`, given `spent` destructive operations already forwarded? */
function matches(rule: PolicyRule, input: EngineInput, scope: TrialScope, spent: number): boolean {
  const touched = [...input.writes, ...input.deletes];
  switch (rule.kind) {
    case "no-overwrite-original":
      return touched.includes(scope.originalDocument);
    case "write-scope":
      return touched.some((p) => !within(p, scope.documentDir));
    case "no-credential-input":
      return input.credentialInput;
    case "app-allowlist":
      return input.launches.some((a) => !rule.apps.includes(a));
    case "destructive-limit":
      return input.destructive > 0 && spent + input.destructive > rule.max;
    case "flagged-screen":
      return input.screenFlagged;
  }
}

const RANK: Readonly<Record<PolicyDecisionKind, number>> = {
  allow: 0,
  "require-approval": 1,
  deny: 2,
};

/**
 * Build the engine for one trial. `config: null` (an invalid file) builds an engine that
 * denies everything. Throws `PolicyScopeError` when the scope does not resolve: the trial
 * refuses to start.
 */
export function createPolicyEngine(
  configSha256: string,
  config: PolicyConfig | null,
  scope: TrialScope,
): PolicyEngine {
  if (typeof configSha256 !== "string" || !/^[0-9a-f]{64}$/.test(configSha256))
    throw new PolicyScopeError();
  const resolved = resolveScope(scope);
  const rules: readonly PolicyRule[] = config === null ? [] : config.policies;
  const kinds: readonly PolicyRuleKind[] = Object.freeze([...new Set(rules.map((r) => r.kind))]);
  const invalidId = opaquePolicyId(configSha256, "\0invalid-config");
  // Destructive operations forwarded (`spent`) and held by decided, not yet settled, actions
  // (`reserved`). A decision judges against both, so concurrent actions cannot share a slot.
  let spent = 0;
  let reserved = 0;

  const evaluate = (input: EngineInput): EngineDecision => {
    if (config === null)
      return { decision: "deny", code: "POLICY_CONFIG_INVALID", policyId: invalidId };
    if (!validInput(input))
      return { decision: "deny", code: "POLICY_ACTION_UNRECOGNISED", policyId: null };
    let best: EngineDecision = { decision: "allow", code: "POLICY_ALLOWED", policyId: null };
    for (const rule of rules) {
      if (!matches(rule, input, resolved, spent + reserved)) continue;
      if (RANK[rule.effect] > RANK[best.decision])
        best = {
          decision: rule.effect,
          code: RULE_CODE[rule.kind],
          policyId: opaquePolicyId(configSha256, rule.id),
        };
    }
    return best;
  };

  const hold = (n: number): DestructiveHold => {
    reserved += n;
    let open = true;
    return Object.freeze({
      commit(): void {
        if (!open) return;
        open = false;
        reserved -= n;
        spent += n;
      },
      release(): void {
        if (!open) return;
        open = false;
        reserved -= n;
      },
    });
  };

  return Object.freeze({
    configSha256,
    scope: resolved,
    kinds,
    evaluate,
    usage: () => Object.freeze({ spent, reserved }),
    decide(input: EngineInput): EngineVerdict {
      // One synchronous step: judge, then reserve. Nothing can run between the two.
      const decision = evaluate(input);
      const n = decision.decision === "deny" ? 0 : input.destructive;
      return Object.freeze({ decision, hold: hold(n) });
    },
  });
}
