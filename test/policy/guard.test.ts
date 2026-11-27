/**
 * Track O guard: fail closed on engine error, timeout and unrecognised actions; a closed,
 * codes-only log entry per decision; agent-facing results carry a code and an opaque id only.
 */
import { describe, expect, it } from "vitest";
import {
  POLICY_AGENT_CODES,
  POLICY_DECISION_CODES,
  POLICY_DECISIONS,
} from "../../src/policy/codes.ts";
import type { ActionFacts } from "../../src/policy/engine.ts";
import { UnrecognisedAction } from "../../src/policy/guard.ts";
import { allStrings } from "../handoff/helpers.ts";
import { ALL_RULES, fixture, guardFor, MARKER, oneRule } from "./helpers.ts";

const NONE: ActionFacts = {
  writes: [],
  deletes: [],
  launches: [],
  credentialInput: false,
  destructive: 0,
};

describe("policy guard: fail closed", () => {
  it("a reducer that throws denies with POLICY_ENGINE_ERROR (sync and async)", async () => {
    const g = guardFor(fixture(), ALL_RULES);
    const boom = () => {
      throw new Error(MARKER);
    };
    expect(g.decide("linux-actuator.act", boom)).toMatchObject({
      decision: "deny",
      code: "POLICY_ENGINE_ERROR",
      agent: { code: "POLICY_DENIED", policyId: null },
    });
    expect(await g.decideAsync("app-adapter.act", boom)).toMatchObject({
      decision: "deny",
      code: "POLICY_ENGINE_ERROR",
    });
  });

  it("an action the reducer cannot reduce is denied as unrecognised", () => {
    const g = guardFor(fixture(), ALL_RULES);
    expect(
      g.decide("app-adapter.act", () => {
        throw new UnrecognisedAction();
      }),
    ).toMatchObject({ decision: "deny", code: "POLICY_ACTION_UNRECOGNISED" });
  });

  it("a screen sensor that throws, or returns a non-boolean, denies", async () => {
    const f = fixture();
    const throwing = guardFor(f, ALL_RULES, {
      screen: () => {
        throw new Error("x");
      },
    });
    expect(throwing.decide("linux-actuator.act", () => NONE)).toMatchObject({
      code: "POLICY_ENGINE_ERROR",
    });
    expect(await throwing.decideAsync("app-adapter.act", () => NONE)).toMatchObject({
      code: "POLICY_ENGINE_ERROR",
    });
    const weird = guardFor(f, ALL_RULES, { screen: () => "yes" as unknown as boolean });
    expect(weird.decide("linux-actuator.act", () => NONE)).toMatchObject({
      code: "POLICY_ENGINE_ERROR",
    });
    expect(await weird.decideAsync("app-adapter.act", () => NONE)).toMatchObject({
      code: "POLICY_ENGINE_ERROR",
    });
  });

  it("a sync path given an async sensor reading denies (it cannot wait)", () => {
    const g = guardFor(fixture(), ALL_RULES, { screen: async () => false });
    expect(g.decide("linux-actuator.act", () => NONE)).toMatchObject({
      decision: "deny",
      code: "POLICY_ENGINE_ERROR",
    });
  });

  it("a sync path given a rejecting async sensor denies and leaves no unhandled rejection", async () => {
    const g = guardFor(fixture(), ALL_RULES, {
      screen: () => Promise.reject(new Error("sensor down")),
    });
    expect(g.decide("linux-actuator.act", () => NONE)).toMatchObject({
      decision: "deny",
      code: "POLICY_ENGINE_ERROR",
    });
    // Give the rejection a turn to surface; vitest fails the run on an unhandled rejection.
    await new Promise((r) => setTimeout(r, 10));
  });

  it("an engine that takes longer than the timeout denies with POLICY_ENGINE_TIMEOUT", async () => {
    const g = guardFor(fixture(), ALL_RULES, {
      screen: () => new Promise<boolean>(() => {}),
      timeoutMs: 20,
    });
    const t0 = Date.now();
    expect(await g.decideAsync("app-adapter.act", () => NONE)).toMatchObject({
      decision: "deny",
      code: "POLICY_ENGINE_TIMEOUT",
      agent: { code: "POLICY_DENIED" },
    });
    expect(Date.now() - t0).toBeLessThan(2_000);
  });

  it("an async sensor that answers in time is honoured", async () => {
    const g = guardFor(fixture(), ALL_RULES, { screen: async () => true });
    expect(await g.decideAsync("app-adapter.act", () => NONE)).toMatchObject({
      decision: "require-approval",
      code: "POLICY_FLAGGED_SCREEN",
      agent: { code: "POLICY_APPROVAL_REQUIRED" },
    });
  });
});

describe("policy guard: the host log and the agent surface", () => {
  it("logs {actionSeq, actuator, policyId, decision, code, configSha256} per decision", () => {
    const g = guardFor(fixture(), ALL_RULES);
    g.decide("linux-actuator.act", () => NONE);
    g.decide("linux-actuator.act", () => ({ ...NONE, credentialInput: true }));
    const log = g.log();
    expect(log.map((e) => e.actionSeq)).toEqual([1, 2]);
    for (const e of log) {
      expect(Object.keys(e).sort()).toEqual(
        ["actionSeq", "actuator", "code", "configSha256", "decision", "policyId"].sort(),
      );
      expect(POLICY_DECISIONS).toContain(e.decision);
      expect(POLICY_DECISION_CODES).toContain(e.code);
      expect(e.configSha256).toBe(g.configSha256);
      expect(e.policyId === null || /^pol-[0-9a-f]{12}$/.test(e.policyId)).toBe(true);
    }
    expect(log[1]).toMatchObject({ decision: "deny", code: "POLICY_CREDENTIAL_INPUT" });
    // The log is a copy: mutating it changes nothing.
    expect(Object.isFrozen(log)).toBe(true);
  });

  it("never echoes agent-supplied text, paths or identities into the log or agent result", async () => {
    const f = fixture();
    const g = guardFor(f, ALL_RULES);
    const seen: unknown[] = [];
    seen.push(g.decide("linux-actuator.act", () => ({ ...NONE, writes: [`/${MARKER}/x`] })));
    seen.push(g.decide("linux-actuator.act", () => ({ ...NONE, launches: [MARKER] })));
    seen.push(
      g.decide("linux-actuator.act", () => {
        throw new Error(`/home/${MARKER}`);
      }),
    );
    seen.push(await g.decideAsync("app-adapter.act", () => ({ ...NONE, writes: [MARKER] })));
    const strings = allStrings(JSON.parse(JSON.stringify([...seen, g.log(), g.row("B+O", "t1")])));
    expect(strings.join("\n")).not.toContain(MARKER);
    expect(strings.join("\n")).not.toContain(f.root);
    for (const d of seen as { agent: { code: string } | null }[])
      if (d.agent) expect(POLICY_AGENT_CODES).toContain(d.agent.code);
  });

  it("the agent sees a code and an opaque id, never the declared rule id or kind", () => {
    const g = guardFor(fixture(), oneRule({ kind: "no-credential-input", effect: "deny" }));
    const d = g.decide("app-adapter.act", () => ({ ...NONE, credentialInput: true }));
    expect(Object.keys(d.agent ?? {}).sort()).toEqual(["code", "policyId"]);
    expect(JSON.stringify(d.agent)).not.toMatch(/r1|credential/i);
  });

  it("the guard exposes no way to relax or disable a policy", () => {
    const g = guardFor(fixture(), oneRule({ kind: "no-credential-input", effect: "deny" }));
    expect(Object.isFrozen(g)).toBe(true);
    const proto = Object.getOwnPropertyNames(Object.getPrototypeOf(g)).sort();
    expect(proto).toEqual(
      [
        "commit",
        "configSha256",
        "constructor",
        "decide",
        "decideAsync",
        "handoffPolicy",
        "log",
        "row",
        "scope",
      ].sort(),
    );
    expect(g.decide("app-adapter.act", () => ({ ...NONE, credentialInput: true }))).toMatchObject({
      decision: "deny",
    });
  });

  it("the policy row records the config hash and decision counts", () => {
    const g = guardFor(fixture(), ALL_RULES);
    g.decide("linux-actuator.act", () => NONE);
    g.decide("linux-actuator.act", () => ({ ...NONE, credentialInput: true }));
    expect(g.row("B+O", "t1")).toEqual({
      schema: "myco.policy.row/1",
      arm: "B+O",
      trialKey: "t1",
      policed: true,
      policyConfigSha256: g.configSha256,
      decisions: { allow: 1, deny: 1, requireApproval: 0 },
    });
  });
});
