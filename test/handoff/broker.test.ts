/**
 * Track N: the handoff broker's state machine, timeouts (fail closed), the policy trigger and
 * the pause gate. Fake clock: no sleeping, no network, no model.
 */
import { describe, expect, it, vi } from "vitest";
import { handoffLogSchema } from "../../schemas/handoff.ts";
import { validateSchema } from "../../schemas/validate.ts";
import { HandoffBroker, type HandoffNotice, type HandoffStatus } from "../../src/handoff/broker.ts";
import { memoryHandoffEventSink } from "../../src/handoff/events.ts";
import { parseHandoffRows } from "../../src/handoff/evidence.ts";
import { guardAction, type HandoffPolicy } from "../../src/handoff/policy.ts";
import {
  assistanceOf,
  MAX_HANDOFF_TIMEOUT_MS,
  MIN_HANDOFF_TIMEOUT_MS,
  noteRejection,
} from "../../src/handoff/protocol.ts";
import { FakeClock, flush } from "./helpers.ts";

const INF = Number.POSITIVE_INFINITY;

function setup(timeoutMs = 60_000) {
  const clock = new FakeClock();
  const events = memoryHandoffEventSink();
  const notices: HandoffNotice[] = [];
  const ends: string[] = [];
  const broker = new HandoffBroker({
    runId: "run-1",
    taskId: "df-s01",
    timeoutMs,
    clock,
    events,
    notifier: { notify: (n) => void notices.push(n) },
    onAttemptEnd: (e) => ends.push(e),
  });
  const agent = broker.agentChannel();
  const operator = broker.operatorChannel();
  const policy = broker.policyTrigger();
  return { clock, events, notices, ends, broker, agent, operator, policy };
}

describe("handoff broker: request, notify, resolve, resume", () => {
  it("an agent request pauses until the human approves, then resumes with the note", async () => {
    const s = setup();
    const call = s.agent.request({ reason: "needs-approval", note: "ok to overwrite?" }, INF);
    await flush();
    expect(s.notices).toHaveLength(1);
    expect(s.notices[0]).toMatchObject({
      handoffId: "ho-1",
      reason: "needs-approval",
      source: "agent",
    });
    expect(s.operator.pending().map((p) => p.handoffId)).toEqual(["ho-1"]);
    s.clock.advance(4_000);
    const r = s.operator.resolve({
      handoffId: "ho-1",
      outcome: "approve",
      via: "cli",
      note: "yes",
    });
    expect(r.ok).toBe(true);
    expect(await call).toEqual({
      status: "resumed",
      handoffId: "ho-1",
      outcome: "approve",
      humanNote: "yes",
    });
    const log = s.broker.log();
    expect(log.assistance).toBe("human-gated");
    expect(log.attemptEnd).toBeNull();
    expect(log.entries[0]).toMatchObject({
      resolution: "approve",
      resolvedBy: "operator:cli",
      operatorLabel: "operator",
      durationMs: 4_000,
      requestedAt: "2026-11-26T15:00:00.000Z",
      resolvedAt: "2026-11-26T15:00:04.000Z",
    });
    expect(validateSchema(log, handoffLogSchema)).toEqual([]);
    expect(s.events.events.map((e) => e.event)).toEqual(["requested", "resolved"]);
  });

  it("a bounded wait returns paused, and await picks the resolution up later", async () => {
    const s = setup();
    const first = s.agent.request({ reason: "blocked", note: "dialog will not close" }, 1_000);
    s.clock.advance(1_000);
    expect(await first).toEqual({ status: "paused", handoffId: "ho-1" });
    const again = s.agent.await("ho-1", 1_000);
    s.operator.resolve({ handoffId: "ho-1", outcome: "fixed-it", via: "watch-view" });
    expect(await again).toMatchObject({ status: "resumed", outcome: "fixed-it", humanNote: null });
    // Awaiting a closed handoff returns its final status at once.
    expect(await s.agent.await("ho-1", 1_000)).toMatchObject({ status: "resumed" });
    expect(s.broker.log().assistance).toBe("assisted");
  });

  it("reject tells the agent not to proceed", async () => {
    const s = setup();
    const call = s.agent.request({ reason: "needs-approval", note: "delete row 4?" }, INF);
    s.operator.resolve({ handoffId: "ho-1", outcome: "reject", via: "cli", note: "keep it" });
    expect(await call).toEqual({ status: "rejected", handoffId: "ho-1", humanNote: "keep it" });
  });

  it("refuses a second request while one is pending, and bad reasons and notes", async () => {
    const s = setup();
    void s.agent.request({ reason: "uncertain", note: "which sheet?" }, INF);
    expect(await s.agent.request({ reason: "uncertain", note: "again" }, INF)).toEqual({
      status: "refused",
      code: "HANDOFF_PENDING",
    });
    const t = setup();
    const cases: [unknown, unknown, string][] = [
      ["approve", "x", "INVALID_REASON"],
      ["UNCERTAIN", "x", "INVALID_REASON"],
      [undefined, "x", "INVALID_REASON"],
      ["uncertain", 7, "NOTE_NOT_STRING"],
      ["uncertain", "x".repeat(281), "NOTE_TOO_LONG"],
      ["uncertain", "line\nbreak", "NOTE_CONTROL_CHAR"],
      ["uncertain", "\u001b[2Jclear", "NOTE_CONTROL_CHAR"],
      ["uncertain", "see /home/alice/file.csv", "NOTE_HOST_PATH"],
      // Round-1 verifier holes (G2): all were accepted before.
      ["uncertain", `open file:///${"Users"}/alice/a.csv`, "NOTE_HOST_PATH"],
      ["uncertain", "file://server/share", "NOTE_HOST_PATH"],
      ["uncertain", "in $HOME/.myco/x", "NOTE_HOST_PATH"],
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal ${HOME} text is the case under test.
      ["uncertain", "in ${HOME}/x", "NOTE_HOST_PATH"],
      ["uncertain", "in %USERPROFILE%\\x", "NOTE_HOST_PATH"],
      ["uncertain", "x/home/user/a", "NOTE_HOST_PATH"],
      ["uncertain", "read /etc/passwd", "NOTE_HOST_PATH"],
      ["uncertain", "/mnt/data/a.csv", "NOTE_HOST_PATH"],
      ["uncertain", "(/opt/app/x)", "NOTE_HOST_PATH"],
      // Round-2 verifier nit 1: other punctuation boundaries.
      ["uncertain", "see `/etc/passwd`", "NOTE_HOST_PATH"],
      ["uncertain", "[/etc/passwd]", "NOTE_HOST_PATH"],
      ["uncertain", "{/etc/shadow}", "NOTE_HOST_PATH"],
      ["uncertain", "</opt/app/x>", "NOTE_HOST_PATH"],
      ["uncertain", "a;/srv/data/x", "NOTE_HOST_PATH"],
      ["uncertain", "a|/opt/a/b", "NOTE_HOST_PATH"],
      ["uncertain", "key sk-abcdefghijklmnop", "NOTE_SECRET_SHAPED"],
    ];
    for (const [reason, note, code] of cases)
      expect(await t.agent.request({ reason, note }, INF)).toEqual({ status: "refused", code });
    expect(t.operator.pending()).toEqual([]);
    expect(t.broker.log().entries).toEqual([]);
  });

  it("validates the operator's resolve input", async () => {
    const s = setup();
    void s.agent.request({ reason: "uncertain", note: "?" }, INF);
    const bad: [Record<string, unknown>, string][] = [
      [{ handoffId: "ho-9", outcome: "approve", via: "cli" }, "UNKNOWN_HANDOFF"],
      [{ handoffId: "../x", outcome: "approve", via: "cli" }, "UNKNOWN_HANDOFF"],
      [{ handoffId: "ho-1", outcome: "timeout", via: "cli" }, "INVALID_OUTCOME"],
      [{ handoffId: "ho-1", outcome: "approve", via: "agent" }, "INVALID_VIA"],
      [
        { handoffId: "ho-1", outcome: "approve", via: "cli", operatorLabel: "Alice Smith" },
        "INVALID_OPERATOR_LABEL",
      ],
      [
        { handoffId: "ho-1", outcome: "approve", via: "cli", note: "C:\\Users\\a" },
        "NOTE_HOST_PATH",
      ],
    ];
    for (const [input, code] of bad)
      expect(s.operator.resolve(input as never)).toEqual({ ok: false, code });
    expect(s.operator.resolve({ handoffId: "ho-1", outcome: "approve", via: "cli" }).ok).toBe(true);
    expect(s.operator.resolve({ handoffId: "ho-1", outcome: "reject", via: "cli" })).toEqual({
      ok: false,
      code: "ALREADY_RESOLVED",
    });
  });

  it("a notifier that throws never resolves or fails the handoff", async () => {
    const clock = new FakeClock();
    const diags: string[] = [];
    const broker = new HandoffBroker({
      runId: "r",
      taskId: "t",
      clock,
      timeoutMs: 5_000,
      notifier: {
        notify: () => {
          throw new Error("no display");
        },
      },
      onDiagnostic: (m) => diags.push(m),
    });
    const op = broker.operatorChannel();
    const call = broker.agentChannel().request({ reason: "uncertain", note: "?" }, INF);
    await flush();
    expect(diags.join("")).toMatch(/notifier failed/);
    expect(op.pending()).toHaveLength(1);
    op.resolve({ handoffId: "ho-1", outcome: "approve", via: "cli" });
    expect((await call).status).toBe("resumed");
  });
});

describe("handoff timeouts fail closed", () => {
  it("the attempt is ended before any waiter or synchronous sink sees the timeout", async () => {
    const clock = new FakeClock();
    const seen: unknown[] = [];
    let broker!: HandoffBroker;
    broker = new HandoffBroker({
      runId: "run-1",
      taskId: "df-s01",
      timeoutMs: 5_000,
      clock,
      events: {
        append: (e) => {
          if (e.event === "resolved") seen.push(broker.attemptEnd, broker.log().attemptEnd);
        },
      },
    });
    const agent = broker.agentChannel();
    void agent.request({ reason: "blocked", note: "?" }, INF);
    clock.advance(5_000);
    expect(seen).toEqual(["handoff-timeout", "handoff-timeout"]);
  });

  it("a handoff nobody answers ends the attempt as handoff-timeout, never approved", async () => {
    const s = setup(30_000);
    const call = s.agent.request({ reason: "needs-approval", note: "proceed?" }, INF);
    s.clock.advance(29_999);
    expect(s.operator.pending()).toHaveLength(1);
    s.clock.advance(1);
    const status: HandoffStatus = await call;
    expect(status).toEqual({ status: "ended", code: "HANDOFF_TIMEOUT" });
    expect(s.ends).toEqual(["handoff-timeout"]);
    const log = s.broker.log();
    expect(log.attemptEnd).toBe("handoff-timeout");
    expect(log.entries[0]).toMatchObject({
      resolution: "timeout",
      resolvedBy: "host:timeout",
      operatorLabel: null,
      humanNote: null,
      durationMs: 30_000,
    });
    expect(log.entries.some((e) => e.resolution === "approve")).toBe(false);
    expect(s.events.events.map((e) => e.event)).toEqual(["requested", "resolved", "attempt-ended"]);
    expect(validateSchema(log, handoffLogSchema)).toEqual([]);
  });

  it("after a timeout: a late human resolve, new requests and policy pauses are all refused", async () => {
    const s = setup(1_000);
    void s.agent.request({ reason: "blocked", note: "stuck" }, INF);
    s.clock.advance(1_000);
    expect(s.operator.resolve({ handoffId: "ho-1", outcome: "approve", via: "cli" })).toEqual({
      ok: false,
      code: "ALREADY_RESOLVED",
    });
    expect(await s.agent.request({ reason: "uncertain", note: "now?" }, INF)).toEqual({
      status: "ended",
      code: "HANDOFF_TIMEOUT",
    });
    expect(await s.agent.await("ho-1", 0)).toEqual({ status: "ended", code: "HANDOFF_TIMEOUT" });
    expect(
      await s.policy.forcePause({ policyId: "o.save", reason: "needs-approval", note: "x" }),
    ).toEqual({ status: "ended", code: "HANDOFF_TIMEOUT" });
    expect(await s.policy.awaitClear()).toBe("ended");
    expect(s.broker.log().entries).toHaveLength(1);
  });

  it("a paused long-poll that sees the timeout gets ended, not paused", async () => {
    const s = setup(2_000);
    const call = s.agent.request({ reason: "uncertain", note: "?" }, 5_000);
    s.clock.advance(2_000);
    expect(await call).toEqual({ status: "ended", code: "HANDOFF_TIMEOUT" });
  });

  it("the timeout is configurable within bounds and rejects anything else", () => {
    for (const bad of [
      0,
      MIN_HANDOFF_TIMEOUT_MS - 1,
      MAX_HANDOFF_TIMEOUT_MS + 1,
      1.5,
      Number.NaN,
      INF,
    ])
      expect(() => new HandoffBroker({ runId: "r", taskId: "t", timeoutMs: bad })).toThrow(
        RangeError,
      );
    expect(new HandoffBroker({ runId: "r", taskId: "t" }).timeoutMs).toBe(15 * 60 * 1000);
    expect(new HandoffBroker({ runId: "r", taskId: "t", timeoutMs: 5_000 }).timeoutMs).toBe(5_000);
  });

  it("closing the trial cancels a pending handoff (host:harness), never approves it", async () => {
    const s = setup();
    const call = s.agent.request({ reason: "uncertain", note: "?" }, INF);
    s.broker.close();
    expect(await call).toEqual({ status: "ended", code: "HANDOFF_CANCELLED" });
    expect(s.broker.log().entries[0]).toMatchObject({
      resolution: "cancelled",
      resolvedBy: "host:harness",
    });
    expect(s.broker.log().assistance).toBe("human-gated");
    expect(s.clock.pending).toBe(0);
  });
});

describe("policy trigger (track O interface) and pause gate", () => {
  const savePolicy: HandoffPolicy = {
    id: "o.save-needs-approval",
    evaluate: (a) =>
      a.tool === "save"
        ? { policyId: "o.save", reason: "needs-approval", note: "saving the file" }
        : null,
  };

  it("a policy forces a pause; approve forwards the action, the record names the policy", async () => {
    const s = setup();
    expect(await guardAction(savePolicy, s.policy, { tool: "type", args: {} })).toEqual({
      kind: "proceed",
      handoffId: null,
    });
    const d = guardAction(savePolicy, s.policy, { tool: "save", args: {} });
    await flush();
    expect(s.notices[0]).toMatchObject({ source: "policy", policyId: "o.save" });
    s.operator.resolve({ handoffId: "ho-1", outcome: "approve", via: "watch-view" });
    expect(await d).toEqual({ kind: "proceed", handoffId: "ho-1" });
    expect(s.broker.log().entries[0]).toMatchObject({ source: "policy", policyId: "o.save" });
  });

  it("reject denies, fixed-it skips, timeout ends; a throwing policy denies", async () => {
    const s = setup(10_000);
    const d1 = guardAction(savePolicy, s.policy, { tool: "save", args: {} });
    await flush();
    s.operator.resolve({ handoffId: "ho-1", outcome: "reject", via: "cli" });
    expect(await d1).toMatchObject({ kind: "deny", code: "HUMAN_REJECTED" });
    const d2 = guardAction(savePolicy, s.policy, { tool: "save", args: {} });
    await flush();
    s.operator.resolve({ handoffId: "ho-2", outcome: "fixed-it", via: "cli" });
    expect(await d2).toEqual({ kind: "skip", handoffId: "ho-2" });
    const boom: HandoffPolicy = {
      id: "o.boom",
      evaluate: () => {
        throw new Error("x");
      },
    };
    expect(await guardAction(boom, s.policy, { tool: "save", args: {} })).toMatchObject({
      kind: "deny",
      code: "POLICY_ERROR",
    });
    const d3 = guardAction(savePolicy, s.policy, { tool: "save", args: {} });
    await flush();
    s.clock.advance(10_000);
    expect(await d3).toEqual({ kind: "ended", code: "HANDOFF_TIMEOUT" });
    expect(s.broker.log().attemptEnd).toBe("handoff-timeout");
  });

  it("no action passes the pause gate while an agent handoff is open", async () => {
    const s = setup();
    void s.agent.request({ reason: "blocked", note: "?" }, INF);
    const passed = vi.fn();
    const g = guardAction(savePolicy, s.policy, { tool: "type", args: {} }).then(passed);
    await flush();
    expect(passed).not.toHaveBeenCalled();
    s.operator.resolve({ handoffId: "ho-1", outcome: "approve", via: "cli" });
    await g;
    expect(passed).toHaveBeenCalledWith({ kind: "proceed", handoffId: null });
  });

  it("B5: a policy pause while an agent handoff is open never takes the agent's answer", async () => {
    const s = setup();
    const a = s.agent.request({ reason: "uncertain", note: "which colour do you prefer?" }, INF);
    const settled = vi.fn();
    const p = s.policy
      .forcePause({ policyId: "o.delete", reason: "needs-approval", note: "OK to delete?" })
      .then((v) => {
        settled(v);
        return v;
      });
    // Recorded at once, with its own id, before any human sees it.
    expect(s.events.events.map((e) => [e.event, e.handoffId])).toEqual([
      ["requested", "ho-1"],
      ["queued", "ho-2"],
    ]);
    expect(s.operator.pending().map((h) => h.handoffId)).toEqual(["ho-1"]);
    const gate = vi.fn();
    void s.policy.awaitClear().then(gate);
    s.operator.resolve({ handoffId: "ho-1", outcome: "approve", note: "blue", via: "cli" });
    expect(await a).toMatchObject({ status: "resumed", handoffId: "ho-1", humanNote: "blue" });
    await flush();
    // The agent's approval did not resolve the policy's pause, and the gate stayed shut.
    expect(settled).not.toHaveBeenCalled();
    expect(gate).not.toHaveBeenCalled();
    const shown = s.operator.pending();
    expect(shown).toHaveLength(1);
    expect(shown[0]).toMatchObject({
      handoffId: "ho-2",
      source: "policy",
      policyId: "o.delete",
      note: "OK to delete?",
    });
    expect(s.notices.map((n) => n.handoffId)).toEqual(["ho-1", "ho-2"]);
    s.operator.resolve({ handoffId: "ho-2", outcome: "reject", via: "cli" });
    expect(await p).toEqual({ status: "rejected", handoffId: "ho-2", humanNote: null });
    expect(await s.policy.awaitClear()).toBe("clear");
    const log = s.broker.log();
    expect(
      log.entries.map((e) => [e.handoffId, e.source, e.policyId, e.note, e.resolution]),
    ).toEqual([
      ["ho-1", "agent", null, "which colour do you prefer?", "approve"],
      ["ho-2", "policy", "o.delete", "OK to delete?", "reject"],
    ]);
    expect(validateSchema(log, handoffLogSchema)).toEqual([]);
  });

  it("B5: the race in guardAction (agent opens a handoff while the policy evaluates) fails closed", async () => {
    const s = setup();
    let release!: () => void;
    const evaluating = new Promise<void>((r) => {
      release = r;
    });
    const slowDelete: HandoffPolicy = {
      id: "o.delete",
      evaluate: async (action) => {
        await evaluating;
        return action.tool === "delete"
          ? { policyId: "o.delete", reason: "needs-approval", note: "OK to delete?" }
          : null;
      },
    };
    const decided = vi.fn();
    const d = guardAction(slowDelete, s.policy, { tool: "delete", args: {} }).then((v) => {
      decided(v);
      return v;
    });
    await flush();
    void s.agent.request({ reason: "uncertain", note: "which colour do you prefer?" }, INF);
    release();
    await flush();
    s.operator.resolve({ handoffId: "ho-1", outcome: "approve", note: "blue", via: "cli" });
    await flush();
    expect(decided).not.toHaveBeenCalled();
    // Another action on the actuator path is held too: the policy's handoff is open.
    const other = vi.fn();
    void guardAction(slowDelete, s.policy, { tool: "type", args: {} }).then(other);
    await flush();
    expect(other).not.toHaveBeenCalled();
    expect(s.operator.pending()[0]).toMatchObject({ handoffId: "ho-2", policyId: "o.delete" });
    s.operator.resolve({ handoffId: "ho-2", outcome: "reject", via: "cli" });
    expect(await d).toEqual({ kind: "deny", handoffId: "ho-2", code: "HUMAN_REJECTED" });
  });

  it("B5: queued policy pauses are recorded cancelled and end closed on timeout or close()", async () => {
    const s = setup(5_000);
    void s.agent.request({ reason: "blocked", note: "?" }, INF);
    const p1 = s.policy.forcePause({ policyId: "o.a", reason: "needs-approval", note: "a" });
    const p2 = s.policy.forcePause({ policyId: "o.b", reason: "uncertain", note: "b" });
    s.clock.advance(5_000);
    expect(await p1).toEqual({ status: "ended", code: "HANDOFF_TIMEOUT" });
    expect(await p2).toEqual({ status: "ended", code: "HANDOFF_TIMEOUT" });
    const log = s.broker.log();
    expect(
      log.entries.map((e) => [e.handoffId, e.source, e.policyId, e.resolution, e.resolvedBy]),
    ).toEqual([
      ["ho-1", "agent", null, "timeout", "host:timeout"],
      ["ho-2", "policy", "o.a", "cancelled", "host:harness"],
      ["ho-3", "policy", "o.b", "cancelled", "host:harness"],
    ]);
    expect(validateSchema(log, handoffLogSchema)).toEqual([]);
    const row = { schema: "myco.handoff.trial/1", trialKey: "t1", log };
    expect(parseHandoffRows([row]).errors).toEqual([]);
    expect(parseHandoffRows([row]).byTrial.get("t1")).toBe("human-gated");
    expect(s.operator.pending()).toEqual([]);
    expect(s.operator.resolve({ handoffId: "ho-2", outcome: "approve", via: "cli" })).toEqual({
      ok: false,
      code: "ALREADY_RESOLVED",
    });

    const c = setup();
    void c.agent.request({ reason: "blocked", note: "?" }, INF);
    const q = c.policy.forcePause({ policyId: "o.c", reason: "needs-approval", note: "c" });
    // A queued request cannot be resolved before it is shown.
    expect(c.operator.resolve({ handoffId: "ho-2", outcome: "approve", via: "cli" })).toEqual({
      ok: false,
      code: "UNKNOWN_HANDOFF",
    });
    c.broker.close();
    expect(await q).toEqual({ status: "ended", code: "HANDOFF_CANCELLED" });
    expect(c.broker.log().entries.map((e) => [e.handoffId, e.resolution])).toEqual([
      ["ho-1", "cancelled"],
      ["ho-2", "cancelled"],
    ]);
  });

  it("a pause-gate waiter pending at the deadline gets ended, never clear (fail closed)", async () => {
    const s = setup(5_000);
    void s.agent.request({ reason: "blocked", note: "?" }, INF);
    const gate = s.policy.awaitClear();
    const forwarded = vi.fn();
    const guarded = guardAction(savePolicy, s.policy, { tool: "type", args: {} }).then(forwarded);
    await flush();
    s.clock.advance(5_000);
    expect(await gate).toBe("ended");
    await guarded;
    expect(forwarded).toHaveBeenCalledWith({ kind: "ended", code: "ATTEMPT_ENDED" });
  });

  it("a pause-gate waiter pending at close() gets ended, never clear", async () => {
    const s = setup();
    void s.agent.request({ reason: "blocked", note: "?" }, INF);
    const gate = s.policy.awaitClear();
    const guarded = guardAction(savePolicy, s.policy, { tool: "type", args: {} });
    await flush();
    s.broker.close();
    expect(await gate).toBe("ended");
    expect(await guarded).toEqual({ kind: "ended", code: "ATTEMPT_ENDED" });
  });

  it("refuses a malformed policy request", async () => {
    const s = setup();
    expect(
      await s.policy.forcePause({ policyId: "Bad Id", reason: "uncertain", note: "x" }),
    ).toEqual({
      status: "refused",
      code: "INVALID_POLICY_ID",
    });
  });
});

describe("assistance label", () => {
  it("is derived from the resolutions", () => {
    expect(assistanceOf([])).toBe("unassisted");
    expect(assistanceOf([{ resolution: "approve" }])).toBe("human-gated");
    expect(assistanceOf([{ resolution: "timeout" }, { resolution: "reject" }])).toBe("human-gated");
    expect(assistanceOf([{ resolution: "approve" }, { resolution: "fixed-it" }])).toBe("assisted");
  });

  it("note hygiene accepts plain short text", () => {
    expect(noteRejection("Is it OK to overwrite Sheet1?", 280)).toBeNull();
    // Ordinary prose with slashes and URLs is not a host path.
    for (const ok of [
      "and/or w/o the 1/2 column",
      "see https://example.com/docs/page",
      "Sheet1!A1:B2 /approve",
      "myco.handoff/v1",
    ])
      expect(noteRejection(ok, 280), ok).toBeNull();
    expect(noteRejection("", 280)).toBeNull();
  });
});
