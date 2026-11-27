/**
 * Track O closed vocabularies: pinned, and admitted as is by Q's proof bundles (the N1 note:
 * policy reason codes become a closed enum once track O lands).
 */
import { describe, expect, it } from "vitest";
import {
  ACTUATOR_IDS,
  POLICY_AGENT_CODES,
  POLICY_DECISION_CODES,
  POLICY_DECISIONS,
  POLICY_EFFECTS,
  POLICY_PACK_REFUSALS,
  POLICY_RULE_KINDS,
  POLICY_START_REFUSALS,
  RULE_CODE,
} from "../../src/policy/codes.ts";
import {
  closedPolicyCode,
  POLICY_CODE_SOURCE,
  POLICY_REASON_CODES,
} from "../../src/proof/closed.ts";
import { hashedId } from "../../src/proof/hashed.ts";

describe("track O closed vocabularies", () => {
  it("pins every list", () => {
    expect(POLICY_DECISIONS).toEqual(["allow", "deny", "require-approval"]);
    expect(POLICY_EFFECTS).toEqual(["deny", "require-approval"]);
    expect(POLICY_RULE_KINDS).toEqual([
      "no-overwrite-original",
      "write-scope",
      "no-credential-input",
      "app-allowlist",
      "destructive-limit",
      "flagged-screen",
    ]);
    expect(POLICY_DECISION_CODES).toEqual([
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
    ]);
    expect(POLICY_AGENT_CODES).toEqual(["POLICY_DENIED", "POLICY_APPROVAL_REQUIRED"]);
    expect(POLICY_START_REFUSALS).toEqual([
      "POLICY_CONFIG_MISSING",
      "POLICY_CONFIG_NOT_HOST",
      "POLICY_SCOPE_INVALID",
      "POLICY_SENSOR_MISSING",
    ]);
    expect(POLICY_PACK_REFUSALS).toHaveLength(5);
    expect(ACTUATOR_IDS).toHaveLength(6);
  });

  it("every rule kind has its own decision code", () => {
    const codes = POLICY_RULE_KINDS.map((k) => RULE_CODE[k]);
    expect(new Set(codes).size).toBe(POLICY_RULE_KINDS.length);
    for (const c of codes) expect(POLICY_DECISION_CODES).toContain(c);
  });

  it("every code is a closed upper-case token (nothing derived from agent input)", () => {
    for (const c of [...POLICY_DECISION_CODES, ...POLICY_AGENT_CODES, ...POLICY_START_REFUSALS])
      expect(c).toMatch(/^POLICY_[A-Z_]+$/);
  });

  it("Q's proof bundles write every O code as is, and digest anything else", () => {
    const re = new RegExp(POLICY_CODE_SOURCE);
    for (const c of [...POLICY_DECISION_CODES, ...POLICY_AGENT_CODES]) {
      expect(POLICY_REASON_CODES).toContain(c);
      expect(closedPolicyCode(c)).toBe(c);
      expect(re.test(c)).toBe(true);
    }
    expect(closedPolicyCode("POLICY_ALLOWED_X")).toBe(hashedId("POLICY_ALLOWED_X"));
  });
});
