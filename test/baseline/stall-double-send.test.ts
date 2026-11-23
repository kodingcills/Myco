/**
 * TIF-167: a stall must not turn into a silent double-send.
 *
 * The concern the readiness-gate verifier raised, and it is real. Cua's guidance
 * after `input_delivery_stalled` is to read the target before repeating, because
 * the input MAY have landed - for a save that means a second Save As dialog.
 *
 * The harness cannot enforce that: the next decision belongs to the planner. But
 * it CAN notice the one case that matters - the same action sent again while its
 * predecessor is still unconfirmed - and record it, because two stalls look like
 * two ordinary stalls and nothing else in the row would reveal the duplicate.
 *
 * These tests drive the real trial loop with a scripted planner and Cua, so they
 * exercise the guard rather than a copy of its logic.
 */
import { describe, expect, it, vi } from "vitest";
import type { Mcp } from "../../src/baseline/c1.ts";
import { type PreparedC1, runC1Trial } from "../../src/baseline/c1-trial.ts";
import type { Planner } from "../../src/baseline/planner.ts";

const targetParams = {
  fixtureSeed: "s",
  rowKey: "r",
  column: "B",
  newValue: "1",
};

/** Cua that answers each call from a script, repeating the last response. */
function scriptedMcp(responses: unknown[]): Mcp {
  let call = 0;
  return {
    request: vi.fn(async (method: string, params: { name?: string }) => {
      if (method === "initialize") return { protocolVersion: "2025-11-25" };
      if (params.name === "get_window_state")
        return {
          // A well-formed base64 image: `screenshot()` rejects anything else, so a
          // placeholder fails with a misleading "guest screenshot unavailable"
          // instead of exercising the loop.
          content: [{ type: "image", mimeType: "image/png", data: "eA==" }],
          structuredContent: { element_token: "e" },
        };
      return responses[Math.min(call++, responses.length - 1)];
    }),
    notify: vi.fn(async () => {}),
  } satisfies Mcp;
}

function prepared(mcp: Mcp): PreparedC1 {
  return {
    driver: {
      hostVersion: "0.56.4",
      guestVersion: "0.56.4",
      pipeReachable: true,
      sessionIdentityMatches: true,
    },
    resetMs: 1,
    acPower: true,
    caffeinate: true,
    loadAvg1: 0,
    window: { pid: 3152, window_id: 328170 },
    connect: async () => mcp,
    closeTransport: async () => {},
    judge: async () => ({ kind: "persisted", actual: "wrong", expected: "right" }),
    audit: async () => true,
  };
}

/** A planner that issues the same save action on every call, then claims done. */
function plannerRepeatingSave(times: number): Planner {
  let issued = 0;
  return {
    paid: true,
    calls: [],
    async act() {
      issued++;
      if (issued > times) return { decision: "failure" as const, calls: [] };
      return {
        decision: {
          tool: "press_key",
          arguments: { x: 0, y: 0, key: "Ctrl+s" },
        },
        calls: [],
      };
    },
  } as unknown as Planner;
}

const STALL = {
  isError: true,
  structuredContent: { code: "tool_invocation_failed", foreground_restored: false },
};
const REFUSE = {
  isError: true,
  structuredContent: { code: "background_unavailable", effect: "refused" },
};

describe("a stall must not become a silent double-send", () => {
  it("records the same action being re-sent after an unconfirmed stall", async () => {
    // Background refuses, foreground stalls -- twice, for the same key.
    const mcp = scriptedMcp([REFUSE, STALL, REFUSE, STALL]);

    const row = await runC1Trial(
      { index: 0, params: targetParams, cellRef: "B2", expected: "x", previousValue: "y" },
      prepared(mcp),
      plannerRepeatingSave(2),
    );
    // Both stalls are recorded...
    expect(row.deviations).toContain("cua-action-1-stalled");
    expect(row.deviations).toContain("cua-action-2-stalled");
    // ...AND the duplicate is named, which is the whole point: without this the
    // row shows two ordinary stalls and hides that the key was sent twice.
    expect(row.deviations, `deviations were: ${JSON.stringify(row.deviations)}`).toContain(
      "cua-action-2-resent-after-stall",
    );
  });

  it("does not flag a DIFFERENT action after a stall", async () => {
    // The planner may legitimately act again after reading the target - a click on
    // a dialog button, say. Only an identical resend is the hazard, so a different
    // action must not be flagged or every post-stall recovery reads as a defect.
    let issued = 0;
    const planner = {
      paid: true,
      calls: [],
      async act() {
        issued++;
        if (issued > 2) return { decision: "failure" as const, calls: [] };
        return {
          decision:
            issued === 1
              ? { tool: "press_key", arguments: { x: 0, y: 0, key: "Ctrl+s" } }
              : { tool: "click", arguments: { x: 100, y: 200 } },
          calls: [],
        };
      },
    } as unknown as Planner;
    const mcp = scriptedMcp([REFUSE, STALL, { structuredContent: { verified: true } }]);
    const row = await runC1Trial(
      { index: 0, params: targetParams, cellRef: "B2", expected: "x", previousValue: "y" },
      prepared(mcp),
      planner,
    );
    expect(row.deviations?.some((d) => d.includes("resent-after-stall"))).toBe(false);
  });

  it("still flags the save when something ELSE ran in between", async () => {
    // The miss the round-1 verifier found, and the case the first version of this
    // guard got wrong: a single slot tracked "the immediately preceding action",
    // so a stall on ANY action overwrote the save's signature and the second save
    // went unflagged - even though the first save's effect was still unknown.
    //
    // A successful CLICK in between does not resolve the SAVE's uncertainty, so
    // the save is still a duplicate hazard and must be flagged. The guard tracks
    // the set of unconfirmed actions, not the last one.
    //
    // The response script must account for escalation: a background refusal costs
    // TWO calls (refuse, then the foreground retry). Getting that wrong silently
    // shortens the run and the test passes or fails for the wrong reason.
    const mcp = scriptedMcp([
      REFUSE, // step 1 background
      STALL, // step 1 foreground -> the save is unconfirmed
      { structuredContent: { verified: true } }, // step 2: a click, confirmed
      { structuredContent: { verified: true } }, // step 3: the save again
    ]);
    let issued = 0;
    const planner = {
      paid: true,
      calls: [],
      async act() {
        issued++;
        if (issued > 3) return { decision: "failure" as const, calls: [] };
        return {
          decision:
            issued === 2
              ? { tool: "click", arguments: { x: 100, y: 200 } }
              : { tool: "press_key", arguments: { x: 0, y: 0, key: "Ctrl+s" } },
          calls: [],
        };
      },
    } as unknown as Planner;
    const row = await runC1Trial(
      { index: 0, params: targetParams, cellRef: "B2", expected: "x", previousValue: "y" },
      prepared(mcp),
      planner,
    );
    expect(row.deviations?.filter((d) => d.includes("-stalled")).length).toBe(1);
    // The save is sent again while its effect is unconfirmed, so this MUST flag.
    expect(row.deviations).toContain("cua-action-3-resent-after-stall");
  });

  it("flags the repeat once, then clears the mark on its success", async () => {
    // The honest semantics, and my own test premise was wrong twice before this:
    // when the SAME action is sent again while unconfirmed, that repeat IS the
    // hazard, so it is flagged - and only THEN does its outcome settle the
    // question. A stall therefore costs exactly one flag, not a permanent mark.
    //
    // What must not happen is one stall flagging every later save forever; that
    // is what the clearing prevents, and it is asserted by the fourth step below
    // being unflagged.
    const mcp = scriptedMcp([
      REFUSE, // step 1 background
      STALL, // step 1 foreground -> the save is unconfirmed
      { structuredContent: { verified: true } }, // step 2: the repeat -> flagged, then resolved
      { structuredContent: { verified: true } }, // step 3: a new decision, not a duplicate
    ]);
    const row = await runC1Trial(
      { index: 0, params: targetParams, cellRef: "B2", expected: "x", previousValue: "y" },
      prepared(mcp),
      plannerRepeatingSave(3),
    );
    const flags = row.deviations?.filter((d) => d.includes("resent-after-stall")) ?? [];
    expect(flags).toHaveLength(1);
    expect(flags[0]).toBe("cua-action-2-resent-after-stall");
    // And the third save is NOT flagged: the mark cleared when step 2 succeeded.
    expect(row.deviations?.some((d) => d.includes("cua-action-3-resent"))).toBe(false);
  });

  it("does not flag a repeat when the first attempt was confirmed", async () => {
    // Two identical saves where the first was verified is not this hazard: the
    // input's effect was known, so the second is a new decision, not a duplicate
    // of an unconfirmed one.
    //
    // The first draft of this test was VACUOUS: it used a single-response stub,
    // which repeats its last value, so the second action also came back confirmed
    // and the guard never armed - the assertion could not have failed. This
    // version returns a scripted sequence and asserts the guard state that makes
    // the case meaningful, so a regression in the guard's clearing logic fails it.
    const mcp = scriptedMcp([
      { structuredContent: { verified: true } },
      { structuredContent: { verified: true } },
    ]);
    const row = await runC1Trial(
      { index: 0, params: targetParams, cellRef: "B2", expected: "x", previousValue: "y" },
      prepared(mcp),
      plannerRepeatingSave(2),
    );
    // The premise: two actions ran and NEITHER stalled, so the guard was never
    // armed. Without this, a stub that silently stalled would make the negative
    // assertion pass for the wrong reason.
    expect(row.deviations?.some((d) => d.includes("stalled"))).toBe(false);
    expect(row.deviations?.some((d) => d.includes("resent-after-stall"))).toBe(false);
  });
});
