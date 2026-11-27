/**
 * Track O guardrail: every row records the policy config hash; a pack mixing hashes within an
 * arm is refused.
 */
import { describe, expect, it } from "vitest";
import { type PolicyRow, unpolicedRow } from "../../src/policy/guard.ts";
import { checkPolicyPack } from "../../src/policy/pack.ts";
import { ALL_RULES, fixture, guardFor, oneRule } from "./helpers.ts";

describe("policy pack: one config hash per arm", () => {
  it("accepts B (unpoliced, no hash) and B+O (one hash) side by side", () => {
    const f = fixture();
    const g1 = guardFor(f, ALL_RULES);
    const g2 = guardFor(f, ALL_RULES);
    const rows = [
      unpolicedRow("B", "t1"),
      unpolicedRow("B", "t2"),
      g1.row("B+O", "t1"),
      g2.row("B+O", "t2"),
    ];
    expect(g1.configSha256).toBe(g2.configSha256);
    expect(checkPolicyPack(rows)).toEqual({
      ok: true,
      arms: { B: null, "B+O": g1.configSha256 },
    });
  });

  it("refuses two config hashes within one arm", () => {
    const f = fixture();
    const a = guardFor(f, ALL_RULES).row("B+O", "t1");
    const b = guardFor(f, oneRule({ kind: "write-scope", effect: "deny" })).row("B+O", "t2");
    expect(checkPolicyPack([a, b])).toEqual({
      ok: false,
      code: "POLICY_PACK_MIXED_HASH",
      arm: "B+O",
    });
  });

  it("refuses policed and unpoliced rows mixed in one arm", () => {
    const f = fixture();
    const a = guardFor(f, ALL_RULES).row("B+O", "t1");
    const b: PolicyRow = { ...unpolicedRow("B+O", "t2") };
    expect(checkPolicyPack([b, a])).toMatchObject({ ok: false, code: "POLICY_PACK_MIXED_HASH" });
  });

  it("refuses a policed row with no hash, and an unpoliced row with one", () => {
    const f = fixture();
    const a = guardFor(f, ALL_RULES).row("B+O", "t1");
    expect(checkPolicyPack([{ ...a, policyConfigSha256: null }])).toMatchObject({
      ok: false,
      code: "POLICY_PACK_HASH_MISSING",
    });
    expect(checkPolicyPack([{ ...a, policyConfigSha256: "abc" }])).toMatchObject({
      code: "POLICY_PACK_HASH_MISSING",
    });
    expect(
      checkPolicyPack([{ ...unpolicedRow("B", "t1"), policyConfigSha256: a.policyConfigSha256 }]),
    ).toMatchObject({ ok: false, code: "POLICY_PACK_HASH_UNEXPECTED" });
  });

  it("refuses an empty pack and malformed rows", () => {
    expect(checkPolicyPack([])).toMatchObject({ ok: false, code: "POLICY_PACK_EMPTY" });
    expect(
      checkPolicyPack([{ ...unpolicedRow("B", "t1"), schema: "x" } as unknown as PolicyRow]),
    ).toMatchObject({ code: "POLICY_PACK_BAD_ROW" });
    expect(checkPolicyPack([unpolicedRow("a b", "t1")])).toMatchObject({
      code: "POLICY_PACK_BAD_ROW",
    });
  });
});
