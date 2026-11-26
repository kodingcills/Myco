/**
 * TIF-274 append-only attempt ledger (lead ruling 2026-11-26 14:35Z): the runner logs every
 * attempt at start and end, hash-chained; the evidence check refuses an undisclosed attempt, a
 * gap, a reordering, a truncated tail, and a self-declared harness fault the ledger never
 * recorded.
 */
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type AttemptEvent,
  AttemptLedgerWriter,
  anchorPathFor,
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
  anchorFor,
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

describe("#518 round 1: double ends, non-R1 triggers, end-vs-start, torn lines, the stated limit", () => {
  const pinOf = (c: { events: AttemptEvent[]; headSha256: string }) => ({
    events: c.events.length,
    headSha256: c.headSha256,
  });

  it("D1: a second end with a different outcome is refused, and cannot overwrite the first", () => {
    const trials = r1Trials();
    const evs = ledgerFor(trials).events;
    // g0 completed; a forged second end claims a harness fault.
    const second = { ...evs[1]!, outcome: "harness-fault" as const, harnessClass: "timeout" };
    const forged = rechain([...evs.slice(0, 2), second, ...evs.slice(2)]);
    const r = checkWith(trials, forged.events, pinOf(forged));
    expect(has(r, /attempt g0: ended twice/)).toBe(true);
    // The first (completed) end stands: no harness-fault mismatch is reported for g0.
    expect(has(r, /g0: the ledger recorded a harness fault/)).toBe(false);
    expect(r.r1?.pass).toBe(false);
  });

  it("D2: a non-R1 pack that carries a broken ledger, or pins one without the file, is refused", () => {
    const trials = r1Trials();
    const r3 = manifest({ rows: ["R3"], expectTrials: { "myco-gate": 100 } });
    const { events, head } = ledgerFor(trials);
    const broken = events.map((e, i) => (i === 3 ? { ...e, taskId: "fc-v1-099" } : e));
    const carried = checkPack({
      ...input(trials, r3),
      manifest: { ...r3, attempts: head },
      attempts: broken,
    });
    expect(has(carried, /^attempt event 4: the hash chain breaks/)).toBe(true);
    const pinnedOnly = checkPack({ ...input(trials, r3), manifest: { ...r3, attempts: head } });
    expect(has(pinnedOnly, /attempts\.jsonl: missing/)).toBe(true);
    // A non-R1 pack with neither is not required to have one.
    expect(has(checkPack(input(trials, r3)), /attempt/)).toBe(false);
  });

  it("nit 2: an end that names another task or arm than its start is refused", () => {
    const trials = r1Trials();
    const forged = rechain(
      ledgerFor(trials).events.map((e, i) => (i === 1 ? { ...e, arm: "hcu+shell" as const } : e)),
    );
    const r = checkWith(trials, forged.events, pinOf(forged));
    expect(has(r, /attempt g0: its end names another task or arm than its start/)).toBe(true);
  });

  it("nit 3: the writer refuses a torn last line with a clear message", () => {
    const path = join(mkdtempSync(join(tmpdir(), "myco-ledger-")), "attempts.jsonl");
    const w = new AttemptLedgerWriter(path);
    w.start({ trialKey: "t1", taskId: "fc-v1-001", arm: "myco-gate" });
    writeFileSync(path, `${readFileSync(path, "utf8")}{"schema":"myco.m2.att`);
    expect(() => new AttemptLedgerWriter(path)).toThrow(/line 2 is not JSON \(a torn write\?\)/);
  });
});

describe("the external anchor (lead ruling on #518 D3)", () => {
  /** A fully rewritten history: g60's attempt removed and g60 dropped from the pack, re-chained. */
  const rewrite = () => {
    const trials = r1Trials();
    const honest = ledgerFor(trials);
    const kept = trials.filter((t) => t.arm.trialKey !== "g60");
    const forged = ledgerFor(kept);
    return { trials, honest, kept, forged };
  };

  it("a full rewrite + re-pin inside the pack is refused when the external anchor exists", () => {
    const { honest, forged } = rewrite();
    // The forger rewrites attempts.jsonl and re-pins pack.json; the host-side anchor keeps the
    // honest heads. (The rows stay as the forger left them: here the honest 100.)
    const base = input(r1Trials(), manifest());
    const r = checkPack({
      ...base,
      manifest: { ...(base.manifest as object), attempts: forged.head },
      attempts: forged.events,
      anchor: anchorFor(honest.events),
    });
    expect(
      has(
        r,
        /^attempt anchor: anchor line \d+: the ledger's head at \d+ events is not the anchored one/,
      ),
    ).toBe(true);
    expect(has(r, /^attempt anchor: the pack's pinned head is not the last anchored head/)).toBe(
      true,
    );
    expect(r.r1?.pass).toBe(false);
  });

  it("STATED LIMIT (threat model): a malicious pack author who regenerates ledger, pin AND anchor is not detected", () => {
    // The harness that writes packs is trusted (lead ruling on #518 D3). Tamper-evidence is
    // against the checked agent, guest-side processes and accidental harness edits, not against
    // an author who rewrites everything consistently. Pinned so that boundary stays visible.
    const { kept, forged } = rewrite();
    const base = input(kept, manifest({ expectTrials: { "myco-gate": 99 } }));
    const r = checkPack({
      ...base,
      manifest: { ...(base.manifest as object), attempts: forged.head },
      attempts: forged.events,
      anchor: anchorFor(forged.events),
    });
    expect(r.errors.filter((e) => e.startsWith("attempt"))).toEqual([]);
  });

  it("an honest pack's anchor agrees; an R1 pack without an anchor is refused", () => {
    const base = input(r1Trials(), manifest());
    expect(checkPack(base).errors).toEqual([]);
    const { anchor: _a, ...noAnchor } = base;
    const r = checkPack(noAnchor);
    expect(has(r, /^attempt anchor: missing/)).toBe(true);
    expect(r.r1?.pass).toBe(false);
  });

  it("refuses a truncated, reordered or schema-invalid anchor, and a pin ahead of the anchor", () => {
    const base = input(r1Trials(), manifest());
    const anchor = base.anchor as { events: number; headSha256: string }[];
    const run = (a: unknown[]) => checkPack({ ...base, anchor: a });
    expect(has(run(anchor.slice(0, -1)), /last anchored head is not the ledger's head/)).toBe(true);
    expect(has(run([anchor[1], anchor[0], ...anchor.slice(2)]), /does not follow/)).toBe(true);
    expect(has(run([{ ...anchor[0], extra: 1 }]), /^attempt anchor: anchor line 0: /)).toBe(true);
    expect(has(run([]), /the external attempt anchor is empty/)).toBe(true);
    const wrongHead = anchor.map((a, i) =>
      i === anchor.length - 1 ? { ...a, headSha256: "f".repeat(64) } : a,
    );
    expect(has(run(wrongHead), /is not the anchored one/)).toBe(true);
  });

  it("readPack finds the anchor outside the pack, at its conventional path", () => {
    const dir = writePack("m2-anchored", r1Trials(), manifest());
    const path = anchorPathFor(dir);
    expect(path.startsWith(dir)).toBe(false);
    const read = readPack(dir, () => ({ ok: true, detail: "not called" }));
    expect(read.anchor?.length).toBe(100);
    expect(checkPack(read).errors).toEqual([]);
  });
});

describe("the writer refuses the ledger or the anchor inside a forbidden root", () => {
  it("the writer refuses a ledger or an anchor inside a forbidden root (the agent's workspace, the guest share)", () => {
    const base = mkdtempSync(join(tmpdir(), "myco-reach-"));
    const agent = join(base, "agent");
    const pack = join(base, "pack");
    expect(
      () =>
        new AttemptLedgerWriter(join(agent, "attempts.jsonl"), {
          anchorPath: join(base, "anchors", "p.jsonl"),
          forbiddenRoots: [agent],
        }),
    ).toThrow(/refusing to write attempts\.jsonl inside .*agent/);
    expect(
      () =>
        new AttemptLedgerWriter(join(pack, "attempts.jsonl"), {
          anchorPath: join(agent, "sub", "anchor.jsonl"),
          forbiddenRoots: [agent],
        }),
    ).toThrow(/refusing to write anchor\.jsonl inside .*agent/);
    // Outside every forbidden root: accepted, and the anchor gets a head per attempt end.
    const anchorPath = join(base, "anchors", "p.jsonl");
    const w = new AttemptLedgerWriter(join(base, "attempts.jsonl"), {
      anchorPath,
      forbiddenRoots: [agent],
    });
    w.start({ trialKey: "t1", taskId: "fc-v1-001", arm: "myco-gate" });
    w.end("t1", { outcome: "completed" });
    const lines = readFileSync(anchorPath, "utf8")
      .trimEnd()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines).toEqual([{ schema: "myco.m2.attempt-anchor/1", ...w.head() }]);
  });
});

describe("#518 round 2: symlinks, non-R1 anchors, duplicate heads, end-aligned heads, genesis", () => {
  it("D4: a path through a symlink into a forbidden root is refused, even below not-yet-existing directories", () => {
    const base = mkdtempSync(join(tmpdir(), "myco-link-"));
    const agent = join(base, "agent");
    mkdirSync(agent);
    // "outside" looks like a sibling of the agent root, but is a link into it.
    symlinkSync(agent, join(base, "outside"));
    expect(
      () =>
        new AttemptLedgerWriter(join(base, "outside", "new", "deeper", "attempts.jsonl"), {
          forbiddenRoots: [agent],
        }),
    ).toThrow(/refusing to write attempts\.jsonl inside .*agent/);
    expect(
      () =>
        new AttemptLedgerWriter(join(base, "attempts.jsonl"), {
          anchorPath: join(base, "outside", "anchors", "p.jsonl"),
          forbiddenRoots: [agent],
        }),
    ).toThrow(/refusing to write p\.jsonl inside .*agent/);
  });

  it("D5: a non-R1 pack with a ledger, a pin and a tampered anchor is refused", () => {
    const trials = r1Trials();
    const r3 = manifest({ rows: ["R3"], expectTrials: { "myco-gate": 100 } });
    const { events, head } = ledgerFor(trials);
    const anchor = anchorFor(events);
    const tampered = anchor.map((a, i) => (i === 5 ? { ...a, headSha256: "e".repeat(64) } : a));
    const r = checkPack({
      ...input(trials, r3),
      manifest: { ...r3, attempts: head },
      attempts: events,
      anchor: tampered,
    });
    expect(
      has(
        r,
        /^attempt anchor: anchor line 5: the ledger's head at \d+ events is not the anchored one/,
      ),
    ).toBe(true);
    // And the same pack with the honest anchor is clean.
    const ok = checkPack({
      ...input(trials, r3),
      manifest: { ...r3, attempts: head },
      attempts: events,
      anchor,
    });
    expect(ok.errors.filter((e) => e.startsWith("attempt"))).toEqual([]);
  });

  it("D6: a duplicated anchor line is refused (counts strictly increase)", () => {
    const base = input(r1Trials(), manifest());
    const anchor = base.anchor as unknown[];
    const r = checkPack({ ...base, anchor: [anchor[0], anchor[0], ...anchor.slice(1)] });
    expect(has(r, /^attempt anchor: anchor line 1: 2 events does not follow 2/)).toBe(true);
  });

  it("nit 3: each anchored head falls on an attempt end, one per end", () => {
    const base = input(r1Trials(), manifest());
    const events = base.attempts as AttemptEvent[];
    const anchor = base.anchor as { events: number; headSha256: string }[];
    // A head anchored after a start event (not an end): its hash is right, its position is not.
    const atStart = {
      schema: "myco.m2.attempt-anchor/1",
      events: 1,
      headSha256: eventSha256(events[0]!),
    };
    const r = checkPack({ ...base, anchor: [atStart, ...anchor] });
    expect(has(r, /anchor line 0: 1 events does not end on an attempt end/)).toBe(true);
    expect(has(r, /the anchor has 101 heads, the ledger has 100 attempt ends/)).toBe(true);
    // A skipped head (one fewer line than ends) is refused too.
    const skipped = checkPack({ ...base, anchor: [...anchor.slice(0, 10), ...anchor.slice(11)] });
    expect(has(skipped, /the anchor has 99 heads, the ledger has 100 attempt ends/)).toBe(true);
  });

  it("M8: the first event must name the genesis hash", () => {
    const { events } = ledgerFor(r1Trials());
    const first = { ...events[0]!, prevSha256: "1".repeat(64) };
    expect(verifyAttemptLedger([first, ...events.slice(1)]).errors.join()).toMatch(
      /attempt event 0: the hash chain breaks/,
    );
  });
});
