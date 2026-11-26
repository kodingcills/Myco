/**
 * TIF-274 append-only attempt ledger (lead ruling 2026-11-26 14:35Z): the runner logs every
 * attempt at start and end, hash-chained; the evidence check refuses an undisclosed attempt, a
 * gap, a reordering, a truncated tail, and a self-declared harness fault the ledger never
 * recorded.
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type AttemptEvent,
  AttemptLedgerWriter,
  crossCheckAttempts,
  type DisclosedAttempt,
  eventSha256,
  verifyAttemptLedger,
} from "../../src/m2/attempt-ledger.ts";
import {
  checkPack,
  type PackResult,
  readPack,
  type SupersededAttempt,
} from "../../src/m2/evidence.ts";
import {
  fcRow,
  fcTasks,
  harnessFault,
  input,
  ledgerFor,
  manifest,
  r1Trials,
  type Trial,
  writePack,
} from "./pack-fixture.ts";

const has = (r: PackResult, pattern: RegExp) => r.errors.some((e) => pattern.test(e));
const jsonl = (rows: unknown[]) => `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`;

/** Re-chain events after a forgery, as a careful forger would (seq and prevSha256 fixed up). */
function rechain(events: AttemptEvent[]): { events: AttemptEvent[]; headSha256: string } {
  let prev = "0".repeat(64);
  const out = events.map((e, i) => {
    const next = { ...e, seq: i, prevSha256: prev };
    prev = eventSha256(next);
    return next;
  });
  return { events: out, headSha256: prev };
}

/** Check an R1 pack with an explicit ledger and pin. */
function checkWith(
  trials: Trial[],
  events: unknown[],
  pin: { events: number; headSha256: string },
) {
  const base = input(trials, manifest());
  return checkPack({
    ...base,
    manifest: { ...(base.manifest as object), attempts: pin },
    attempts: events,
  });
}

describe("the writer", () => {
  it("appends a hash-chained start and end per attempt, and resumes only a sound file", () => {
    const path = join(mkdtempSync(join(tmpdir(), "myco-ledger-")), "attempts.jsonl");
    const w = new AttemptLedgerWriter(path);
    w.start({ trialKey: "t1", taskId: "fc-v1-001", arm: "myco-gate" });
    w.end("t1", { outcome: "harness-fault", harnessClass: "timeout" });
    w.start({ trialKey: "t2", taskId: "fc-v1-001", arm: "myco-gate" });
    // A second writer resumes the same file (append-only), then finishes t2.
    const w2 = new AttemptLedgerWriter(path);
    w2.end("t2", { outcome: "completed" });
    const lines = readFileSync(path, "utf8")
      .trimEnd()
      .split("\n")
      .map((l) => JSON.parse(l));
    const v = verifyAttemptLedger(lines);
    expect(v.errors).toEqual([]);
    expect(v.head).toEqual(w2.head());
    expect(lines.map((e) => [e.kind, e.trialKey, e.outcome ?? null])).toEqual([
      ["start", "t1", null],
      ["end", "t1", "harness-fault"],
      ["start", "t2", null],
      ["end", "t2", "completed"],
    ]);
    expect(() => w2.end("t9", { outcome: "completed" })).toThrow(/t9 is not running/);
    expect(() => w2.start({ trialKey: "t1", taskId: "fc-v1-001", arm: "myco-gate" })).toThrow(
      /already started/,
    );
    // A tampered file is never appended to.
    lines[1].harnessClass = "sshd";
    writeFileSync(path, jsonl(lines));
    expect(() => new AttemptLedgerWriter(path)).toThrow(
      /refusing to append to a broken attempt ledger/,
    );
  });
});

describe("the chain", () => {
  const { events } = ledgerFor(r1Trials());
  it("an honest ledger verifies, with its head", () => {
    const v = verifyAttemptLedger(events);
    expect(v.errors).toEqual([]);
    expect(v.head.events).toBe(200);
  });
  it("an edited event breaks the chain", () => {
    const edited = events.map((e, i) => (i === 3 ? { ...e, taskId: "fc-v1-099" } : e));
    expect(verifyAttemptLedger(edited).errors.join()).toMatch(/event 4: the hash chain breaks/);
  });
  it("a removed event (a gap) and a reordering are refused", () => {
    const gap = events.filter((_, i) => i !== 10);
    expect(verifyAttemptLedger(gap).errors.join()).toMatch(/event 10: seq 11, expected 10/);
    const swapped = [...events];
    [swapped[4], swapped[5]] = [swapped[5]!, swapped[4]!];
    expect(verifyAttemptLedger(swapped).errors.join()).toMatch(/event 4: seq 5, expected 4/);
  });
  it("an end event's shape: an outcome, and a class exactly on a harness fault", () => {
    const { events: e2 } = rechain([
      { ...events[0]! },
      { ...events[1]!, outcome: "harness-fault" } as AttemptEvent,
    ]);
    expect(verifyAttemptLedger(e2).errors.join()).toMatch(
      /harness class exactly when its outcome is harness-fault/,
    );
  });
});

describe("the evidence check cross-checks the ledger against the pack", () => {
  it("an honest R1 pack passes, and its ledger is required and pinned", () => {
    const r = checkPack(input(r1Trials()));
    expect(r.errors).toEqual([]);
    expect(r.r1?.pass).toBe(true);
    const base = input(r1Trials());
    const { attempts: _a, ...noLedger } = base;
    expect(has(checkPack(noLedger), /attempts\.jsonl: missing/)).toBe(true);
    // Neither a ledger nor a pin: an R1 pack still needs the ledger.
    const { attempts: _pin, ...bareManifest } = base.manifest as Record<string, unknown>;
    const bare = checkPack({ ...noLedger, manifest: bareManifest });
    expect(has(bare, /attempts\.jsonl: missing/)).toBe(true);
    expect(bare.r1?.pass).toBe(false);
    const { attempts: _p, ...unpinned } = base.manifest as Record<string, unknown>;
    expect(has(checkPack({ ...base, manifest: unpinned }), /pins no attempt-ledger head/)).toBe(
      true,
    );
  });

  it("MUTATION drop an attempt: an undisclosed attempt (a row deleted from the pack) is refused", () => {
    const trials = r1Trials();
    const { events, head } = ledgerFor(trials);
    // The pack drops trial 61's row; the ledger still holds its attempt.
    const r = checkWith(
      trials.filter((_, i) => i !== 61),
      events,
      head,
    );
    expect(has(r, /attempt g61: in the ledger but not disclosed/)).toBe(true);
    expect(r.r1?.pass).toBe(false);
  });

  it("MUTATION drop an attempt: a disclosed trial the ledger never recorded is refused", () => {
    const trials = r1Trials();
    const forged = rechain(ledgerFor(trials).events.filter((e) => e.trialKey !== "g61"));
    const r = checkWith(trials, forged.events, {
      events: forged.events.length,
      headSha256: forged.headSha256,
    });
    expect(has(r, /g61: disclosed, but the attempt ledger has no complete attempt for it/)).toBe(
      true,
    );
  });

  it("MUTATION truncate the chain: a cut tail no longer matches the pinned head", () => {
    const trials = r1Trials();
    const { events, head } = ledgerFor(trials);
    const r = checkWith(trials, events.slice(0, -2), head);
    expect(has(r, /is not the pinned one .*truncated or rewritten/)).toBe(true);
    expect(r.r1?.pass).toBe(false);
  });

  it("MUTATION edit a fault class: a rewritten, re-chained ledger no longer matches the pin", () => {
    const trials = r1Trials();
    trials[61] = harnessFault(61, fcRow(fcTasks("kill-app")[1]!));
    const { events, head } = ledgerFor(trials);
    const edited = rechain(
      events.map((e) =>
        e.trialKey === "g61" && e.kind === "end" ? { ...e, harnessClass: "sshd" } : e,
      ),
    );
    const r = checkWith(trials, edited.events, head);
    expect(has(r, /is not the pinned one/)).toBe(true);
    // And against its own (re-pinned) head, the pack's class no longer matches the record.
    const repinned = checkWith(trials, edited.events, {
      events: edited.events.length,
      headSha256: edited.headSha256,
    });
    expect(
      has(repinned, /g61: the pack claims harness class timeout, the ledger recorded sshd/),
    ).toBe(true);
  });

  it("a self-declared harness fault the ledger never recorded is refused; a recorded one hidden is too", () => {
    const honest = r1Trials();
    honest[61] = harnessFault(61, fcRow(fcTasks("kill-app")[1]!));
    // The ledger recorded trial 61 as completed, but the pack claims a harness fault.
    const completedLedger = ledgerFor(r1Trials());
    const claimed = checkWith(honest, completedLedger.events, completedLedger.head);
    expect(
      has(claimed, /g61: the pack claims a harness fault \(timeout\) the ledger never recorded/),
    ).toBe(true);
    // The ledger recorded a harness fault, but the pack shows trial 61 as an ordinary refusal.
    const faultLedger = ledgerFor(honest);
    const hidden = checkWith(r1Trials(), faultLedger.events, faultLedger.head);
    expect(
      has(
        hidden,
        /g61: the ledger recorded a harness fault \(timeout\), the pack does not disclose one/,
      ),
    ).toBe(true);
  });

  it("a pack whose ledger was edited in place (chain broken) is refused", () => {
    const trials = r1Trials();
    const { events, head } = ledgerFor(trials);
    const edited = events.map((e, i) => (i === 3 ? { ...e, taskId: "fc-v1-099" } : e));
    const r = checkWith(trials, edited, head);
    expect(has(r, /^attempt event 4: the hash chain breaks/)).toBe(true);
    expect(r.r1?.pass).toBe(false);
  });

  it("refuses a task or arm the ledger did not record", () => {
    const trials = r1Trials();
    const forged = rechain(
      ledgerFor(trials).events.map((e) =>
        e.trialKey === "g0" ? { ...e, taskId: "fc-v1-099" } : e,
      ),
    );
    const r = checkWith(trials, forged.events, {
      events: forged.events.length,
      headSha256: forged.headSha256,
    });
    expect(has(r, /g0: the ledger recorded task fc-v1-099 on myco-gate, the pack says/)).toBe(true);
  });

  it("refuses an attempt started twice, ended before it started, or never ended", () => {
    const trials = r1Trials();
    const evs = ledgerFor(trials).events;
    const twice = rechain([...evs, { ...evs[0]! }]);
    expect(
      has(
        checkWith(trials, twice.events, {
          events: twice.events.length,
          headSha256: twice.headSha256,
        }),
        /attempt g0: started twice/,
      ),
    ).toBe(true);
    const early = rechain([evs[1]!, evs[0]!, ...evs.slice(2)]);
    expect(
      has(
        checkWith(trials, early.events, {
          events: early.events.length,
          headSha256: early.headSha256,
        }),
        /attempt g0: ended before it started/,
      ),
    ).toBe(true);
    const open = rechain(evs.filter((_, i) => i !== 1));
    expect(
      has(
        checkWith(trials, open.events, { events: open.events.length, headSha256: open.headSha256 }),
        /attempt g0: started and never ended/,
      ),
    ).toBe(true);
  });

  it("a superseded attempt must end before its replacement starts (cross-check API)", () => {
    const a: DisclosedAttempt = {
      trialKey: "a1",
      taskId: "t",
      arm: "myco-gate",
      harnessClass: "timeout",
      replacedBy: "a2",
    };
    const b: DisclosedAttempt = {
      trialKey: "a2",
      taskId: "t",
      arm: "myco-gate",
      harnessClass: null,
    };
    const ok = rechain([
      {
        schema: "myco.m2.attempt-event/1",
        seq: 0,
        prevSha256: "",
        kind: "start",
        trialKey: "a1",
        taskId: "t",
        arm: "myco-gate",
      },
      {
        schema: "myco.m2.attempt-event/1",
        seq: 0,
        prevSha256: "",
        kind: "end",
        trialKey: "a1",
        taskId: "t",
        arm: "myco-gate",
        outcome: "harness-fault",
        harnessClass: "timeout",
      },
      {
        schema: "myco.m2.attempt-event/1",
        seq: 0,
        prevSha256: "",
        kind: "start",
        trialKey: "a2",
        taskId: "t",
        arm: "myco-gate",
      },
      {
        schema: "myco.m2.attempt-event/1",
        seq: 0,
        prevSha256: "",
        kind: "end",
        trialKey: "a2",
        taskId: "t",
        arm: "myco-gate",
        outcome: "completed",
      },
    ]);
    const head = { events: 4, headSha256: ok.headSha256 };
    expect(crossCheckAttempts(ok.events, [a, b], head, head)).toEqual([]);
    const overlapped = rechain([ok.events[0]!, ok.events[2]!, ok.events[1]!, ok.events[3]!]);
    const h2 = { events: 4, headSha256: overlapped.headSha256 };
    expect(crossCheckAttempts(overlapped.events, [a, b], h2, h2)).toContain(
      "a1: its replacement a2 started before it ended",
    );
  });

  it("readPack reads attempts.jsonl, and the written pack checks clean", () => {
    const dir = writePack("m2-ledger", r1Trials(), manifest());
    const read = readPack(dir, () => ({ ok: true, detail: "not called" }));
    expect(read.attempts).toHaveLength(200);
    expect(checkPack(read).errors).toEqual([]);
  });
});

describe("superseded attempts (#511) against the ledger", () => {
  /** A harness-faulted attempt of g61 (kill-app), re-run in place as g61. */
  const attempt = (key = "g61-a1"): SupersededAttempt => {
    const t = harnessFault(0, fcRow(fcTasks("kill-app")[1]!));
    return {
      schema: "myco.m2.superseded/1",
      replacedBy: "g61",
      reason: "agent call timed out; re-run in place",
      arm: { ...t.arm, trialKey: key },
      ops: { ...t.ops, trialKey: key },
    };
  };
  /** An R1 pack with superseded attempts and an explicit ledger. */
  const withLedger = (superseded: SupersededAttempt[], events: AttemptEvent[]) => {
    const trials = r1Trials();
    const base = input(trials, manifest());
    const c = rechain(events);
    return checkPack({
      ...base,
      manifest: {
        ...(base.manifest as object),
        attempts: { events: c.events.length, headSha256: c.headSha256 },
      },
      superseded,
      attempts: c.events,
    });
  };

  it("an honest topped-up pack passes: the attempt is recorded, a harness fault, before its re-run", () => {
    const r = checkPack(input(r1Trials(), manifest(), [attempt()]));
    expect(r.errors).toEqual([]);
    expect(r.r1?.pass).toBe(true);
    expect(r.superseded.count).toBe(1);
  });

  it("refuses a superseded attempt the ledger never recorded", () => {
    const r = withLedger([attempt()], ledgerFor(r1Trials()).events);
    expect(has(r, /g61-a1: disclosed, but the attempt ledger has no complete attempt for it/)).toBe(
      true,
    );
    expect(r.r1?.pass).toBe(false);
  });

  it("refuses a superseded 'harness fault' the ledger recorded as completed", () => {
    const a = attempt();
    const recordedCompleted = { ...a, ops: { ...a.ops, harnessClass: null } };
    const events = ledgerFor(r1Trials(), [recordedCompleted]).events;
    const r = withLedger([a], events);
    expect(
      has(r, /g61-a1: the pack claims a harness fault \(timeout\) the ledger never recorded/),
    ).toBe(true);
  });

  it("refuses a re-run that started before the attempt it replaces ended", () => {
    const events = ledgerFor(r1Trials(), [attempt()]).events;
    // Move g61's start ahead of g61-a1's end.
    const a1End = events.findIndex((e) => e.trialKey === "g61-a1" && e.kind === "end");
    const g61Start = events.findIndex((e) => e.trialKey === "g61" && e.kind === "start");
    const moved = [...events];
    const [start] = moved.splice(g61Start, 1);
    moved.splice(a1End, 0, start!);
    const r = withLedger([attempt()], moved);
    expect(has(r, /g61-a1: its replacement g61 started before it ended/)).toBe(true);
  });

  it("refuses an attempt recorded in the ledger but overwritten and never disclosed", () => {
    // The runner logged a refuted attempt g61-a0; the pack shows only the re-run g61 and does
    // not disclose g61-a0 in superseded.jsonl.
    const hidden = { ...attempt("g61-a0"), ops: { ...attempt("g61-a0").ops, harnessClass: null } };
    const events = ledgerFor(r1Trials(), [hidden]).events;
    const r = withLedger([], events);
    expect(has(r, /attempt g61-a0: in the ledger but not disclosed/)).toBe(true);
    expect(r.r1?.pass).toBe(false);
  });

  it("#511 F1: a superseded attempt's reason must be non-empty", () => {
    const r = checkPack(input(r1Trials(), manifest(), [{ ...attempt(), reason: "" }]));
    expect(has(r, /^superseded row 0: .*reason/)).toBe(true);
  });
});
