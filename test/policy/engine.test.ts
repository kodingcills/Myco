/**
 * Track O engine: each example policy from capability spec 2 section O, decided host-side from
 * reduced facts; the most restrictive rule wins; malformed facts and invalid configs fail closed;
 * nothing on the engine relaxes a rule.
 */
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { parsePolicyConfig } from "../../src/policy/config.ts";
import {
  type ActionFacts,
  createPolicyEngine,
  type EngineInput,
  opaquePolicyId,
} from "../../src/policy/engine.ts";
import { ALL_RULES, fixture } from "./helpers.ts";

const SHA = createHash("sha256").update("cfg").digest("hex");
const NONE: EngineInput = {
  writes: [],
  deletes: [],
  launches: [],
  credentialInput: false,
  destructive: 0,
  screenFlagged: false,
};

function engine(config: unknown = ALL_RULES) {
  const f = fixture();
  const parsed = parsePolicyConfig(JSON.stringify(config));
  const e = createPolicyEngine(SHA, parsed, {
    originalDocument: f.original,
    documentDir: f.docDir,
  });
  return { f, e };
}

describe("policy engine: the spec's example policies", () => {
  it("allows an action that touches nothing a rule names", () => {
    const { e, f } = engine();
    expect(e.evaluate(NONE)).toEqual({ decision: "allow", code: "POLICY_ALLOWED", policyId: null });
    expect(e.evaluate({ ...NONE, writes: [join(e.scope.documentDir, "copy.xlsx")] })).toMatchObject(
      { decision: "allow" },
    );
    expect(f).toBeTruthy();
  });

  it("never save over the original document (write or delete)", () => {
    const { e } = engine();
    const o = e.scope.originalDocument;
    expect(e.evaluate({ ...NONE, writes: [o] })).toEqual({
      decision: "deny",
      code: "POLICY_OVERWRITE_ORIGINAL",
      policyId: opaquePolicyId(SHA, "keep-original"),
    });
    expect(e.evaluate({ ...NONE, deletes: [o] })).toMatchObject({
      code: "POLICY_OVERWRITE_ORIGINAL",
    });
  });

  it("no writes outside the task's document directory", () => {
    const { e } = engine();
    for (const p of ["/etc/passwd", join(dirname(e.scope.documentDir), "x")])
      expect(e.evaluate({ ...NONE, writes: [p] })).toMatchObject({
        decision: "deny",
        code: "POLICY_WRITE_OUTSIDE_SCOPE",
      });
    // A sibling directory whose name shares the prefix is outside too.
    expect(e.evaluate({ ...NONE, writes: [`${e.scope.documentDir}-evil/x`] })).toMatchObject({
      code: "POLICY_WRITE_OUTSIDE_SCOPE",
    });
  });

  it("no typing into a credential field", () => {
    const { e } = engine();
    expect(e.evaluate({ ...NONE, credentialInput: true })).toMatchObject({
      decision: "deny",
      code: "POLICY_CREDENTIAL_INPUT",
    });
  });

  it("no app launch outside the allow-list", () => {
    const { e } = engine();
    expect(e.evaluate({ ...NONE, launches: ["soffice"] })).toMatchObject({ decision: "allow" });
    expect(e.evaluate({ ...NONE, launches: ["soffice", "xterm"] })).toMatchObject({
      decision: "deny",
      code: "POLICY_APP_NOT_ALLOWED",
    });
  });

  it("at most k destructive operations per trial (counts only forwarded actions)", () => {
    const { e } = engine();
    const one: ActionFacts = { ...NONE, destructive: 1 };
    expect(e.evaluate({ ...one, screenFlagged: false })).toMatchObject({ decision: "allow" });
    e.commit(one);
    e.commit(one);
    expect(e.evaluate({ ...one, screenFlagged: false })).toMatchObject({
      decision: "deny",
      code: "POLICY_DESTRUCTIVE_LIMIT",
    });
    // A non-destructive action is still allowed at the limit.
    expect(e.evaluate(NONE)).toMatchObject({ decision: "allow" });
  });

  it("an action that alone exceeds the limit is denied", () => {
    const { e } = engine();
    expect(e.evaluate({ ...NONE, destructive: 3 })).toMatchObject({
      code: "POLICY_DESTRUCTIVE_LIMIT",
    });
  });

  it("no action while the screen shows a flagged instruction: require-approval", () => {
    const { e } = engine();
    expect(e.evaluate({ ...NONE, screenFlagged: true })).toEqual({
      decision: "require-approval",
      code: "POLICY_FLAGGED_SCREEN",
      policyId: opaquePolicyId(SHA, "injected"),
    });
  });

  it("deny beats require-approval whatever the config order", () => {
    const { e } = engine();
    expect(e.evaluate({ ...NONE, screenFlagged: true, credentialInput: true })).toMatchObject({
      decision: "deny",
      code: "POLICY_CREDENTIAL_INPUT",
    });
    const reversed = { ...ALL_RULES, policies: [...ALL_RULES.policies].reverse() };
    const r = engine(reversed).e;
    expect(r.evaluate({ ...NONE, screenFlagged: true, credentialInput: true })).toMatchObject({
      decision: "deny",
    });
  });
});

describe("policy engine: fail closed", () => {
  it.each([
    ["relative path", { ...NONE, writes: ["doc/x"] }],
    ["unnormalised path", { ...NONE, writes: ["/a/../etc/passwd"] }],
    ["non-boolean credential flag", { ...NONE, credentialInput: "no" }],
    ["negative count", { ...NONE, destructive: -1 }],
    ["fractional count", { ...NONE, destructive: 0.5 }],
    ["missing field", { writes: [], deletes: [], launches: [], credentialInput: false }],
    ["not an object", null],
  ])("unrecognised facts (%s) are denied", (_name, input) => {
    const { e } = engine();
    expect(e.evaluate(input as unknown as EngineInput)).toEqual({
      decision: "deny",
      code: "POLICY_ACTION_UNRECOGNISED",
      policyId: null,
    });
  });

  it("an invalid config denies every action", () => {
    const f = fixture();
    const e = createPolicyEngine(SHA, null, {
      originalDocument: f.original,
      documentDir: f.docDir,
    });
    expect(e.evaluate(NONE)).toMatchObject({ decision: "deny", code: "POLICY_CONFIG_INVALID" });
  });

  it("refuses a scope whose document is outside its directory, or missing", () => {
    const f = fixture();
    expect(() =>
      createPolicyEngine(SHA, null, { originalDocument: f.outside, documentDir: f.docDir }),
    ).toThrow("POLICY_SCOPE_INVALID");
    expect(() =>
      createPolicyEngine(SHA, null, {
        originalDocument: join(f.docDir, "nope.xlsx"),
        documentDir: f.docDir,
      }),
    ).toThrow("POLICY_SCOPE_INVALID");
    expect(() =>
      createPolicyEngine("not-a-hash", null, {
        originalDocument: f.original,
        documentDir: f.docDir,
      }),
    ).toThrow("POLICY_SCOPE_INVALID");
  });

  it("the engine is frozen: no rule can be relaxed, replaced or removed through it", () => {
    const { e } = engine();
    expect(Object.isFrozen(e)).toBe(true);
    expect(() => {
      (e as unknown as Record<string, unknown>).evaluate = () => ({ decision: "allow" });
    }).toThrow();
    expect(e.evaluate({ ...NONE, credentialInput: true })).toMatchObject({ decision: "deny" });
  });

  it("opaque ids reveal neither the declared id nor the config", () => {
    const id = opaquePolicyId(SHA, "keep-original");
    expect(id).toMatch(/^pol-[0-9a-f]{12}$/);
    expect(id).not.toContain("keep");
    expect(opaquePolicyId(SHA, "a")).not.toBe(opaquePolicyId(SHA, "b"));
  });
});
