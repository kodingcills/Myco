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
    // A name inside the directory that merely starts with two dots is inside.
    expect(e.evaluate({ ...NONE, writes: [join(e.scope.documentDir, "..notes")] })).toMatchObject({
      decision: "allow",
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
    e.decide({ ...one, screenFlagged: false }).hold.commit();
    e.decide({ ...one, screenFlagged: false }).hold.commit();
    expect(e.evaluate({ ...one, screenFlagged: false })).toMatchObject({
      decision: "deny",
      code: "POLICY_DESTRUCTIVE_LIMIT",
    });
    // A non-destructive action is still allowed at the limit.
    expect(e.evaluate(NONE)).toMatchObject({ decision: "allow" });
  });

  it("decide reserves before the action; release returns the slot, commit spends it once", () => {
    const { e } = engine(); // at-most-2
    const one: EngineInput = { ...NONE, destructive: 1 };
    const a = e.decide(one);
    const b = e.decide(one);
    expect([a.decision.decision, b.decision.decision]).toEqual(["allow", "allow"]);
    // Two unsettled reservations already fill the limit: a third is denied, and reserves nothing.
    const c = e.decide(one);
    expect(c.decision).toMatchObject({ decision: "deny", code: "POLICY_DESTRUCTIVE_LIMIT" });
    expect(e.evaluate(one)).toMatchObject({ code: "POLICY_DESTRUCTIVE_LIMIT" });
    c.hold.release(); // a deny's hold is empty: releasing it frees nothing
    expect(e.evaluate(one)).toMatchObject({ code: "POLICY_DESTRUCTIVE_LIMIT" });
    a.hold.release();
    a.hold.release(); // settling twice is a no-op
    a.hold.commit();
    expect(e.evaluate(one)).toMatchObject({ decision: "allow" });
    b.hold.commit();
    b.hold.commit();
    const d = e.decide(one);
    expect(d.decision).toMatchObject({ decision: "allow" });
    d.hold.commit();
    expect(e.evaluate(one)).toMatchObject({ code: "POLICY_DESTRUCTIVE_LIMIT" });
    // A non-destructive action still passes and reserves nothing.
    expect(e.decide(NONE).decision).toMatchObject({ decision: "allow" });
  });

  it("require-approval reserves too (the human may approve while others decide)", () => {
    const { e } = engine({
      schema: "myco.policy-config/1",
      policies: [
        { id: "lim", kind: "destructive-limit", effect: "deny", max: 1 },
        { id: "inj", kind: "flagged-screen", effect: "require-approval" },
      ],
    });
    const held = e.decide({ ...NONE, destructive: 1, screenFlagged: true });
    expect(held.decision.decision).toBe("require-approval");
    expect(e.evaluate({ ...NONE, destructive: 1 })).toMatchObject({ decision: "deny" });
    held.hold.release();
    expect(e.evaluate({ ...NONE, destructive: 1 })).toMatchObject({ decision: "allow" });
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

  it("write-scope: one path inside and one outside the doc dir is outside (any, not every)", () => {
    const { e } = engine();
    const inside = join(e.scope.documentDir, "copy.xlsx");
    for (const writes of [
      [inside, "/etc/passwd"],
      ["/etc/passwd", inside],
    ])
      expect(e.evaluate({ ...NONE, writes })).toMatchObject({
        decision: "deny",
        code: "POLICY_WRITE_OUTSIDE_SCOPE",
      });
    // The same through deletes, and split across writes and deletes.
    expect(e.evaluate({ ...NONE, deletes: [inside, "/etc/passwd"] })).toMatchObject({
      code: "POLICY_WRITE_OUTSIDE_SCOPE",
    });
    expect(e.evaluate({ ...NONE, writes: [inside], deletes: ["/etc/passwd"] })).toMatchObject({
      code: "POLICY_WRITE_OUTSIDE_SCOPE",
    });
  });

  it("among equally restrictive matches, the first rule in the file names the decision", () => {
    const rules = [
      { id: "creds-first", kind: "no-credential-input", effect: "deny" },
      { id: "scope-second", kind: "write-scope", effect: "deny" },
      { id: "flag-third", kind: "flagged-screen", effect: "require-approval" },
      { id: "flag-fourth", kind: "flagged-screen", effect: "require-approval" },
    ];
    const both: EngineInput = { ...NONE, credentialInput: true, writes: ["/etc/passwd"] };
    const a = engine({ schema: "myco.policy-config/1", policies: rules }).e;
    expect(a.evaluate(both)).toEqual({
      decision: "deny",
      code: "POLICY_CREDENTIAL_INPUT",
      policyId: opaquePolicyId(SHA, "creds-first"),
    });
    // Swap the two deny rules: the other one now names the decision.
    const swapped = [rules[1], rules[0], rules[2], rules[3]];
    const b = engine({ schema: "myco.policy-config/1", policies: swapped }).e;
    expect(b.evaluate(both)).toEqual({
      decision: "deny",
      code: "POLICY_WRITE_OUTSIDE_SCOPE",
      policyId: opaquePolicyId(SHA, "scope-second"),
    });
    // Same kind, same effect: the earlier id wins.
    expect(a.evaluate({ ...NONE, screenFlagged: true })).toEqual({
      decision: "require-approval",
      code: "POLICY_FLAGGED_SCREEN",
      policyId: opaquePolicyId(SHA, "flag-third"),
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
