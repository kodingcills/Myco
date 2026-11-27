/**
 * Track O (policies and guardrails): the closed vocabularies.
 *
 * Every value a policy decision can carry is a member of a closed list here: the decision, the
 * rule kind, the host-side reason code, and the agent-facing code. Nothing a policy writes is
 * derived from agent-supplied text, paths or identities, so a record built from these lists
 * carries no agent content (`docs/policy/guardrails.md`).
 *
 * Q's proof bundles (`src/proof/closed.ts`, `POLICY_REASON_CODES`) admit `POLICY_DECISION_CODES`
 * as is (the N1 note: "track O's own enum replaces the policy half when it lands"). Adding a
 * member is a reviewed change: `test/policy/codes.test.ts` pins every list.
 */

/** What a policy decides for one proposed action. */
export const POLICY_DECISIONS = ["allow", "deny", "require-approval"] as const;
export type PolicyDecisionKind = (typeof POLICY_DECISIONS)[number];

/** The rule kinds a host config may declare (capability spec 2, section O, its examples). */
export const POLICY_RULE_KINDS = [
  "no-overwrite-original",
  "write-scope",
  "no-credential-input",
  "app-allowlist",
  "destructive-limit",
  "flagged-screen",
] as const;
export type PolicyRuleKind = (typeof POLICY_RULE_KINDS)[number];

/** The effect a rule has when it matches. `allow` is never declared: allow is the absence of a match. */
export const POLICY_EFFECTS = ["deny", "require-approval"] as const;
export type PolicyEffect = (typeof POLICY_EFFECTS)[number];

/**
 * Host-side reason codes, one per decision recorded in the policy log. Closed.
 *
 * - `POLICY_ALLOWED`: no rule matched.
 * - one code per rule kind, naming WHICH declared rule matched (never what the agent sent);
 * - fail-closed codes: an action the engine cannot reduce to facts, an engine error, an
 *   engine timeout, and a config that could not be parsed (every action is denied).
 */
export const POLICY_DECISION_CODES = [
  "POLICY_ALLOWED",
  "POLICY_OVERWRITE_ORIGINAL",
  "POLICY_WRITE_OUTSIDE_SCOPE",
  "POLICY_CREDENTIAL_INPUT",
  "POLICY_APP_NOT_ALLOWED",
  "POLICY_DESTRUCTIVE_LIMIT",
  "POLICY_FLAGGED_SCREEN",
  "POLICY_ACTION_UNRECOGNISED",
  "POLICY_ENGINE_ERROR",
  "POLICY_ENGINE_TIMEOUT",
  "POLICY_CONFIG_INVALID",
] as const;
export type PolicyDecisionCode = (typeof POLICY_DECISION_CODES)[number];

/** The code each rule kind records when it matches. */
export const RULE_CODE: Readonly<Record<PolicyRuleKind, PolicyDecisionCode>> = {
  "no-overwrite-original": "POLICY_OVERWRITE_ORIGINAL",
  "write-scope": "POLICY_WRITE_OUTSIDE_SCOPE",
  "no-credential-input": "POLICY_CREDENTIAL_INPUT",
  "app-allowlist": "POLICY_APP_NOT_ALLOWED",
  "destructive-limit": "POLICY_DESTRUCTIVE_LIMIT",
  "flagged-screen": "POLICY_FLAGGED_SCREEN",
};

/**
 * What the agent sees for a held or refused action: one of these two codes and an opaque policy
 * id, never the policy text, the rule kind or the host reason code. An engine error, timeout or
 * unparseable config is `POLICY_DENIED` to the agent (the host log keeps the real code).
 */
export const POLICY_AGENT_CODES = ["POLICY_DENIED", "POLICY_APPROVAL_REQUIRED"] as const;
export type PolicyAgentCode = (typeof POLICY_AGENT_CODES)[number];

/** Why a policed trial refuses to start (it never runs unpoliced instead). */
export const POLICY_START_REFUSALS = [
  "POLICY_CONFIG_MISSING",
  "POLICY_CONFIG_NOT_HOST",
  "POLICY_SCOPE_INVALID",
] as const;
export type PolicyStartRefusal = (typeof POLICY_START_REFUSALS)[number];

/** Why a pack of policed rows is refused (`checkPolicyPack`). */
export const POLICY_PACK_REFUSALS = [
  "POLICY_PACK_EMPTY",
  "POLICY_PACK_BAD_ROW",
  "POLICY_PACK_HASH_MISSING",
  "POLICY_PACK_HASH_UNEXPECTED",
  "POLICY_PACK_MIXED_HASH",
] as const;
export type PolicyPackRefusal = (typeof POLICY_PACK_REFUSALS)[number];

/** The actuator entry points the guard wraps (`src/policy/actuators.ts`). Closed. */
export const ACTUATOR_IDS = [
  "app-adapter.act",
  "desktop-transport.act",
  "linux-actuator.act",
  "cross-app.calc-set",
  "cross-app.writer-append",
  "action-router.policy",
] as const;
export type ActuatorId = (typeof ACTUATOR_IDS)[number];
