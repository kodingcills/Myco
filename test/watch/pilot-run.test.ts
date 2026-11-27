/**
 * Track A step 2 (#618): `myco watch --pilot <runDir>` follows an R1 pilot run, or an A/B
 * stage root, as it runs, read-only, from the run's durable outputs (`src/watch/run-dir.ts`).
 *
 *  - recorded run: the real `runPilot` with the SIMULATED fake driver (no model, no VM), with a
 *    planted transcript per trial, a harness fault and the real heartbeat writer;
 *  - live follow: the reader, polled from inside the run, sees each attempt start before it ends;
 *  - fake A/B stage root: arms, #518 ledger agreement, grader status, heartbeat fields;
 *  - redaction: only closed fields reach the page; a planted marker, a fake host path, the home
 *    directory and the username never do; the server's backstop refuses a leaking view;
 *  - passivity: the run directory is byte-unchanged, and the oracle's inputs and the vault are
 *    never opened (FIFOs planted there would block a reader that opened them).
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  GRADES_FILE as AB_GRADES_FILE,
  R1_LEDGER_FILE as AB_LEDGER_FILE,
} from "../../src/pilot/ab.ts";
import { GATE_GRANT } from "../../src/pilot/config.ts";
import { fakeDriver } from "../../src/pilot/dry-run.ts";
import {
  PILOT_HARNESS_CLASSES,
  PROGRESS_FILE as PILOT_PROGRESS_FILE,
} from "../../src/pilot/ledger.ts";
import {
  LiveStatus,
  LIVE_STATUS_FILE as PILOT_LIVE_STATUS_FILE,
} from "../../src/pilot/live-launch.ts";
import { HarnessFault, SIMULATED_FILE } from "../../src/pilot/runner.ts";
import { parseWatchArgs, startFromArgs } from "../../src/watch/cli.ts";
import {
  ATTEMPT_LEDGER_FILE,
  GATE_TOOL_NAME,
  GRADES_FILE,
  LIVE_STATUS_FILE,
  type PilotRunSource,
  type PilotView,
  PROGRESS_FILE,
  pilotRunSource,
  projectTranscript,
  WATCH_HARNESS_CLASSES,
} from "../../src/watch/run-dir.ts";
import { startWatchServer, type WatchServer } from "../../src/watch/server.ts";
import { dryRun } from "../pilot/helpers.ts";
import { FAKE_ABS_PATH, MARKER, raw, tempDir, treeSnapshot } from "./helpers.ts";

const ROOT = resolve(import.meta.dirname, "..", "..");
const HOME = homedir();
const USER = userInfo().username;

const open: WatchServer[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => s.close()));
});
async function serve(opts: Parameters<typeof startWatchServer>[0]): Promise<WatchServer> {
  const server = await startWatchServer({ pollMs: 20, ...opts });
  open.push(server);
  return server;
}

/** Every response body the page can fetch, concatenated. */
async function allBodies(port: number): Promise<string> {
  const out: string[] = [];
  for (const path of ["/", "/watch.js", "/watch.css", "/api/state"])
    out.push((await raw(port, path)).body.toString("utf8"));
  out.push((await raw(port, "/api/events", { maxMs: 150 })).body.toString("utf8"));
  return out.join("\n");
}

function expectNoLeak(text: string, extra: readonly string[] = []) {
  for (const needle of [MARKER, FAKE_ABS_PATH, "/srv/", HOME, `/${USER}`, ...extra])
    expect(text, needle).not.toContain(needle);
}

/** A verbose transcript as Claude Code writes it, with free text planted in every field. */
function plantedTranscript(gateVerdict: string) {
  return JSON.stringify([
    {
      type: "system",
      subtype: "init",
      apiKeySource: "none",
      cwd: FAKE_ABS_PATH,
      session_id: MARKER,
    },
    {
      type: "assistant",
      message: {
        content: [
          { type: "text", text: `thinking ${MARKER} ${FAKE_ABS_PATH}` },
          { type: "tool_use", id: "tu1", name: GATE_GRANT, input: { claim: MARKER } },
        ],
      },
    },
    {
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu1",
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  verdict: gateVerdict,
                  accepted: false,
                  reasonCodes: ["STATE_MISSING", MARKER, "STATE_MISSING"],
                  reasons: [`${FAKE_ABS_PATH} ${MARKER}`],
                  request: { claim: MARKER, runId: MARKER },
                  corrections: [{ kind: MARKER, expected: MARKER }],
                }),
              },
            ],
          },
        ],
      },
    },
    {
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "tu2",
            name: `Bash_${MARKER}`,
            input: { command: FAKE_ABS_PATH },
          },
        ],
      },
    },
    {
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "tu3", name: GATE_GRANT, input: {} }] },
    },
    {
      type: "result",
      subtype: "success",
      is_error: false,
      num_turns: 4,
      result: `${MARKER} ${FAKE_ABS_PATH}\nDONE`,
      permission_denials: [{ tool_name: `Bash_${MARKER}`, tool_input: { command: FAKE_ABS_PATH } }],
    },
  ]);
}

describe("watch --pilot: the reader's closed constants match src/pilot", () => {
  it("file names, the gate grant and the harness classes are the pilot's own", () => {
    expect(PROGRESS_FILE).toBe(PILOT_PROGRESS_FILE);
    expect(LIVE_STATUS_FILE).toBe(PILOT_LIVE_STATUS_FILE);
    expect(ATTEMPT_LEDGER_FILE).toBe(AB_LEDGER_FILE);
    expect(GRADES_FILE).toBe(AB_GRADES_FILE);
    expect(GATE_TOOL_NAME).toBe(GATE_GRANT);
    expect([...WATCH_HARNESS_CLASSES]).toEqual([...PILOT_HARNESS_CLASSES]);
  });
});

describe("watch --pilot: a recorded SIMULATED pilot run (real runPilot, fake driver)", () => {
  it("follows the run as it happens, then shows every attempt, the actions, gate calls and verdicts, and leaks nothing", {
    timeout: 180_000,
  }, async () => {
    const dir = tempDir("myco-watch-pilot-");
    const source = pilotRunSource(dir);
    const status = new LiveStatus(dir, "r1-pilot", Date.now, 60_000);
    status.log(`trial ${MARKER} at ${FAKE_ABS_PATH} in ${HOME}`);
    const seen: { running: number; decided: number; faulted: number }[] = [];
    let n = 0;
    const driver = fakeDriver({
      beforeAgent: (ctx) => {
        n += 1;
        // Polled from inside the run, after the attempt's start line and before its end.
        const v = source.poll();
        seen.push({ ...v.counts });
        writeFileSync(join(ctx.trialDir, "transcript.json"), plantedTranscript("uncertain"));
        // Oracle-side files the reader must never surface.
        writeFileSync(
          join(ctx.trialDir, "gate-evidence", "planted.json"),
          `${MARKER} ${FAKE_ABS_PATH}`,
        );
        if (n === 3)
          throw new HarnessFault("transport-error", `dropped ${MARKER} ${FAKE_ABS_PATH} ${HOME}`);
      },
    });
    const { result } = await dryRun(dir, { driver });
    expect(result).toMatchObject({ status: "complete", ran: 30, faulted: 1 });
    status.finish({
      exitCode: 0,
      result: { status: "complete", stopCode: null, reason: `${MARKER} ${FAKE_ABS_PATH}` },
      error: `${MARKER} ${FAKE_ABS_PATH}`,
    });

    // Live: every poll from inside the run saw exactly the current attempt running, and the
    // decided count grew one trial at a time (the faulted attempt was re-run in place).
    expect(seen).toHaveLength(31);
    expect(seen.every((c) => c.running === 1)).toBe(true);
    expect(seen[0]).toEqual({ running: 1, decided: 0, faulted: 0, accepted: 0 } as never);
    expect(seen.map((c) => c.decided + c.faulted)).toEqual([...Array(31).keys()]);

    const v = source.poll();
    expect(v.layout).toBe("single");
    expect(v.simulated).toBe(true);
    expect(v.counts).toMatchObject({ running: 0, decided: 30, faulted: 1 });
    expect(v.trials).toHaveLength(31);
    const fault = v.trials.find((t) => t.state === "harness-fault");
    expect(fault).toMatchObject({
      harnessClass: "transport-error",
      attempt: 1,
      gate: { called: false },
    });
    const rerun = v.trials.find((t) => t.supersedes === fault?.trialKey);
    expect(rerun).toMatchObject({ attempt: 2, state: "decided" });
    const decided = v.trials.filter((t) => t.state === "decided");
    // The gate's post-stop verdict and acceptance from each arm row; the claim enum.
    for (const t of decided) {
      expect(t.says).toBe("done");
      // A task the gate registry rejects is decided `unregistrable`, with no verdict.
      if (t.gate?.unregistrable) expect(t.gate.verdict).toBeNull();
      else expect(["verified", "refuted", "uncertain"]).toContain(t.gate?.verdict);
      expect(t.accepted).toBe(t.gate?.verdict === "verified");
      expect(t.taskId).toMatch(/^[a-z0-9-]+$/);
    }
    expect(decided.filter((t) => t.gate?.verdict != null).length).toBeGreaterThan(0);
    expect(v.counts.accepted).toBe(decided.filter((t) => t.accepted).length);
    // The agent's actions, from its transcript: counts and closed names only.
    expect(decided[0]?.actions).toEqual({
      turns: 4,
      toolCalls: { gate: 2, other: 1 },
      denied: { gate: 0, other: 1 },
      gateCalls: [
        { verdict: "uncertain", reasonCodes: ["STATE_MISSING"] },
        { verdict: null, reasonCodes: [] },
      ],
    });
    expect(v.live).toMatchObject({
      runner: "r1-pilot",
      state: "finished",
      stale: false,
      exitCode: 0,
      status: "complete",
      stopCode: null,
    });
    expect(v.trials.every((t) => t.ledger === null)).toBe(true);

    // Served: the page carries the view, and no response carries the planted text.
    const before = treeSnapshot(dir);
    const s = await serve({ runs: [], pilot: source });
    await new Promise((r) => setTimeout(r, 80));
    const state = s.state();
    expect(state.pilotRefused).toBe(false);
    expect(state.pilot?.counts.decided).toBe(30);
    const bodies = await allBodies(s.port);
    expect(bodies).toContain('"simulated":true');
    expectNoLeak(bodies, [dir, "Bash", "faultMessage", "lastLog", '"pid"']);
    for (const method of ["POST", "PUT", "DELETE"]) await raw(s.port, "/api/state", { method });
    await new Promise((r) => setTimeout(r, 80));
    expect(treeSnapshot(dir)).toEqual(before);
    expect(SIMULATED_FILE).toBe("SIMULATED");
  });
});

/** One arm of a fake A/B stage, written by hand in the pilot's formats. */
function fakeArm(armDir: string, arm: "on" | "off") {
  mkdirSync(join(armDir, "trials"), { recursive: true });
  const at = "2026-11-27T10:00:00.000Z";
  const row = (verdict: string, accepted: boolean) => ({
    schema: "myco.benchmark.arm-row/1",
    claim: "done",
    gate: { called: true, verdict, corrections: arm },
    accepted,
    cause: { kind: "agent", detail: `${MARKER} ${FAKE_ABS_PATH}` },
    cost: { modelUsd: 0.5, wallClockS: 61.27, vmS: null },
    fixtureSha256: MARKER,
    faultClass: MARKER,
  });
  const k = (t: string) => `ab-s0-${arm}-${t}-a1`;
  const lines = [
    {
      schema: "myco.pilot.header/1",
      configSha256: MARKER,
      simulated: false,
      plannerModelId: MARKER,
    },
    {
      schema: "myco.pilot.attempt/1",
      event: "start",
      taskId: "fc-001",
      attempt: 1,
      trialKey: k("fc-001"),
      runId: k("fc-001"),
      supersedes: null,
      at,
    },
    {
      schema: "myco.pilot.attempt/1",
      event: "end",
      trialKey: k("fc-001"),
      outcome: "decided",
      harnessClass: null,
      recovered: false,
      armRow: row("verified", true),
      cost: null,
      at,
    },
    {
      schema: "myco.pilot.attempt/1",
      event: "start",
      taskId: "fc-002",
      attempt: 1,
      trialKey: k("fc-002"),
      runId: k("fc-002"),
      supersedes: null,
      at,
    },
    {
      schema: "myco.pilot.attempt/1",
      event: "end",
      trialKey: k("fc-002"),
      outcome: "harness-fault",
      harnessClass: "timeout",
      recovered: false,
      armRow: row("uncertain", false),
      cost: null,
      faultMessage: `${MARKER} ${FAKE_ABS_PATH}`,
      at,
    },
    {
      schema: "myco.pilot.attempt/1",
      event: "start",
      taskId: "fc-003",
      attempt: 1,
      trialKey: k("fc-003"),
      runId: k("fc-003"),
      supersedes: null,
      at,
    },
    // Refused lines: an unsafe id, a path-shaped id, a host-needle id, an unknown schema.
    {
      schema: "myco.pilot.attempt/1",
      event: "start",
      taskId: "x",
      attempt: 1,
      trialKey: FAKE_ABS_PATH,
      supersedes: null,
      at,
    },
    {
      schema: "myco.pilot.attempt/1",
      event: "start",
      taskId: "x",
      attempt: 1,
      trialKey: `../${MARKER}`,
      supersedes: null,
      at,
    },
    { schema: MARKER, event: "start" },
  ];
  writeFileSync(
    join(armDir, PROGRESS_FILE),
    `${lines.map((l) => JSON.stringify(l)).join("\n")}\n{"torn`,
  );
  const ev = (seq: number, kind: string, t: string, extra: Record<string, unknown> = {}) => ({
    schema: "myco.m2.attempt-event/1",
    seq,
    prevSha256: "0".repeat(64),
    kind,
    trialKey: k(t),
    taskId: t,
    arm: "corrections",
    ...extra,
  });
  const ledger = [
    ev(0, "start", "fc-001"),
    ev(1, "end", "fc-001", { outcome: "completed" }),
    ev(2, "start", "fc-002"),
    // Disagrees: the progress file says timeout.
    ev(3, "end", "fc-002", { outcome: "harness-fault", harnessClass: "crash" }),
    // fc-003 has no start here: the ledger is behind.
  ];
  writeFileSync(
    join(armDir, ATTEMPT_LEDGER_FILE),
    `${ledger.map((l) => JSON.stringify(l)).join("\n")}\n`,
  );
  writeFileSync(
    join(armDir, GRADES_FILE),
    `${JSON.stringify({ schema: "myco.benchmark.grade-row/1", trialKey: k("fc-001"), taskId: "fc-001", status: "pass", reasons: [MARKER], target: FAKE_ABS_PATH, fixtureSha256: MARKER })}\n`,
  );
  // The oracle's input and the vault, with planted text.
  mkdirSync(join(armDir, "trials", k("fc-001"), "gate-evidence"), { recursive: true });
  writeFileSync(join(armDir, "trials", k("fc-001"), "doc.csv"), `${MARKER},${FAKE_ABS_PATH}\n`);
  writeFileSync(join(armDir, "trials", k("fc-001"), "gate-tasks.json"), `{"m":"${MARKER}"}`);
  mkdirSync(join(armDir, "vault", k("fc-001"), "captured", "persisted"), { recursive: true });
  writeFileSync(join(armDir, "vault", k("fc-001"), "captured", "persisted", "doc.csv"), MARKER);
  return k;
}

function fakeStage(): { root: string; on: (t: string) => string } {
  const root = tempDir("myco-watch-ab-");
  const on = fakeArm(join(root, "on"), "on");
  fakeArm(join(root, "off"), "off");
  writeFileSync(
    join(root, LIVE_STATUS_FILE),
    JSON.stringify({
      schema: "myco.pilot.live-status/1",
      runner: "corrections-ab",
      pid: 424242,
      startedAt: "2026-11-27T09:00:00.000Z",
      updatedAt: "2026-11-27T10:00:00.000Z",
      lastLog: `${MARKER} ${FAKE_ABS_PATH}`,
      costBasis: MARKER,
      state: "running",
    }),
  );
  return { root, on };
}

describe("watch --pilot: a fake A/B stage root", () => {
  it("shows both arms, the #518 ledger agreement, the grader's status and the heartbeat", () => {
    const { root, on } = fakeStage();
    const t0 = Date.parse("2026-11-27T10:00:00.000Z");
    let clock = t0 + 60_000;
    const v = pilotRunSource(root, { now: () => clock }).poll();
    expect(v.layout).toBe("ab");
    expect(v.simulated).toBe(false);
    expect(v.trials).toHaveLength(6);
    expect(v.trials.map((t) => t.arm)).toEqual(["on", "on", "on", "off", "off", "off"]);
    const [a, b, c] = v.trials;
    expect(a).toMatchObject({
      trialKey: on("fc-001"),
      state: "decided",
      gate: { called: true, verdict: "verified", corrections: "on", unregistrable: false },
      accepted: true,
      causeKind: "agent",
      wallClockS: 61.3,
      grade: "pass",
      ledger: "agrees",
    });
    expect(b).toMatchObject({
      state: "harness-fault",
      harnessClass: "timeout",
      ledger: "disagrees",
      grade: null,
    });
    expect(c).toMatchObject({ state: "running", ledger: "behind", actions: null });
    // 3 refused lines per arm, plus the torn tail is pending (not yet a line).
    expect(v.skipped).toBe(6);
    expect(v.live).toMatchObject({
      runner: "corrections-ab",
      state: "running",
      stale: false,
      exitCode: null,
    });
    clock = t0 + 181_000;
    expect(pilotRunSource(root, { now: () => clock }).poll().live?.stale).toBe(true);
    const text = JSON.stringify(v);
    expectNoLeak(text, ["424242", "costBasis", "faultClass", "fixtureSha256", "reasons", "target"]);
  });

  it("an id carrying a host needle is dropped, and an unknown harness class shows as other", () => {
    const dir = tempDir("myco-watch-needle-");
    const at = "2026-11-27T10:00:00.000Z";
    writeFileSync(
      join(dir, PROGRESS_FILE),
      [
        {
          schema: "myco.pilot.attempt/1",
          event: "start",
          taskId: "t1",
          attempt: 1,
          trialKey: `r1p-${USER}-a1`,
          supersedes: null,
          at,
        },
        {
          schema: "myco.pilot.attempt/1",
          event: "start",
          taskId: `planted-${MARKER}`,
          attempt: 1,
          trialKey: "r1p-t2-a1",
          supersedes: null,
          at,
        },
        {
          schema: "myco.pilot.attempt/1",
          event: "end",
          trialKey: "r1p-t2-a1",
          outcome: "harness-fault",
          harnessClass: `${MARKER}`,
          recovered: true,
          armRow: null,
          cost: null,
          at,
        },
      ]
        .map((l) => JSON.stringify(l))
        .join("\n")
        .concat("\n"),
    );
    const v = pilotRunSource(dir, { needles: [`${USER}`, MARKER] }).poll();
    expect(v.trials).toHaveLength(1);
    expect(v.skipped).toBe(1);
    expect(v.trials[0]).toMatchObject({
      trialKey: "r1p-t2-a1",
      taskId: null,
      harnessClass: "other",
      recovered: true,
    });
    expect(JSON.stringify(v)).not.toContain(MARKER);
  });

  it("a directory with its own progress file is one run, even beside on/ and off/ arms", () => {
    const { root } = fakeStage();
    const at = "2026-11-27T10:00:00.000Z";
    writeFileSync(
      join(root, PROGRESS_FILE),
      `${JSON.stringify({ schema: "myco.pilot.attempt/1", event: "start", taskId: "t", attempt: 1, trialKey: "r1p-t-a1", supersedes: null, at })}\n`,
    );
    const v = pilotRunSource(root).poll();
    expect(v.layout).toBe("single");
    expect(v.trials.map((t) => t.trialKey)).toEqual(["r1p-t-a1"]);
  });

  it("a row that says accepted without a verified verdict is shown as not accepted", () => {
    const dir = tempDir("myco-watch-acc-");
    const at = "2026-11-27T10:00:00.000Z";
    const lines = [
      {
        schema: "myco.pilot.attempt/1",
        event: "start",
        taskId: "t",
        attempt: 1,
        trialKey: "r1p-t-a1",
        supersedes: null,
        at,
      },
      {
        schema: "myco.pilot.attempt/1",
        event: "end",
        trialKey: "r1p-t-a1",
        outcome: "decided",
        harnessClass: null,
        recovered: false,
        armRow: { claim: "done", gate: { called: true, verdict: "refuted" }, accepted: true },
        cost: null,
        at,
      },
    ];
    writeFileSync(join(dir, PROGRESS_FILE), `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
    const v = pilotRunSource(dir).poll();
    expect(v.trials[0]).toMatchObject({ accepted: false, gate: { verdict: "refuted" } });
    expect(v.counts.accepted).toBe(0);
  });

  it("a symlinked transcript, or a symlinked trial directory, is never read", () => {
    const dir = tempDir("myco-watch-link-");
    const elsewhere = tempDir("myco-watch-elsewhere-");
    writeFileSync(join(elsewhere, "t.json"), plantedTranscript("verified"));
    mkdirSync(join(dir, "trials", "r1p-a-a1"), { recursive: true });
    symlinkSync(join(elsewhere, "t.json"), join(dir, "trials", "r1p-a-a1", "transcript.json"));
    mkdirSync(join(elsewhere, "d"));
    writeFileSync(join(elsewhere, "d", "transcript.json"), plantedTranscript("verified"));
    symlinkSync(join(elsewhere, "d"), join(dir, "trials", "r1p-b-a1"));
    const at = "2026-11-27T10:00:00.000Z";
    const start = (k: string) =>
      JSON.stringify({
        schema: "myco.pilot.attempt/1",
        event: "start",
        taskId: "t",
        attempt: 1,
        trialKey: k,
        supersedes: null,
        at,
      });
    writeFileSync(join(dir, PROGRESS_FILE), `${start("r1p-a-a1")}\n${start("r1p-b-a1")}\n`);
    const v = pilotRunSource(dir).poll();
    expect(v.trials.map((t) => t.actions)).toEqual([null, null]);
  });
});

/** A single-run progress file from JSON lines. */
function writeProgress(dir: string, lines: readonly Record<string, unknown>[]) {
  writeFileSync(join(dir, PROGRESS_FILE), `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
}
const AT = "2026-11-27T10:00:00.000Z";
function startLine(trialKey: string, extra: Record<string, unknown> = {}) {
  return {
    schema: "myco.pilot.attempt/1",
    event: "start",
    taskId: "t",
    attempt: 1,
    trialKey,
    supersedes: null,
    at: AT,
    ...extra,
  };
}
function endLine(trialKey: string, extra: Record<string, unknown> = {}) {
  return {
    schema: "myco.pilot.attempt/1",
    event: "end",
    trialKey,
    outcome: "decided",
    harnessClass: null,
    recovered: false,
    armRow: null,
    cost: null,
    at: AT,
    ...extra,
  };
}

describe("watch --pilot: closed-vocabulary and strict-pattern fields (round 1 B1)", () => {
  it("free text planted in every closed or pattern-checked field is shown as null and never served", async () => {
    const dir = tempDir("myco-watch-closed-");
    // Timestamps that are not strict ISO: free text, and an ISO prefix with free text after it.
    writeProgress(dir, [
      { schema: "myco.pilot.header/1", simulated: false },
      startLine("r1p-t1-a1", { at: MARKER }),
      endLine("r1p-t1-a1", {
        at: `${AT} ${MARKER}`,
        armRow: {
          claim: MARKER,
          gate: { called: true, verdict: MARKER, corrections: MARKER },
          accepted: true,
          cause: { kind: MARKER, detail: MARKER },
        },
      }),
    ]);
    writeFileSync(join(dir, ATTEMPT_LEDGER_FILE), "");
    writeFileSync(
      join(dir, GRADES_FILE),
      `${JSON.stringify({ schema: "myco.benchmark.grade-row/1", trialKey: "r1p-t1-a1", status: MARKER })}\n`,
    );
    writeFileSync(
      join(dir, LIVE_STATUS_FILE),
      JSON.stringify({
        schema: "myco.pilot.live-status/1",
        runner: MARKER,
        state: MARKER,
        startedAt: MARKER,
        updatedAt: `${AT}${MARKER}`,
        exitCode: MARKER,
        result: { status: MARKER, stopCode: MARKER },
      }),
    );
    const source = pilotRunSource(dir);
    const v = source.poll();
    expect(v.trials).toHaveLength(1);
    expect(v.trials[0]).toMatchObject({
      trialKey: "r1p-t1-a1",
      state: "decided",
      startedAt: null,
      endedAt: null,
      says: null,
      gate: { called: true, verdict: null, corrections: null },
      accepted: false,
      causeKind: null,
      grade: null,
    });
    expect(v.live).toEqual({
      runner: null,
      state: null,
      startedAt: null,
      updatedAt: null,
      stale: false,
      exitCode: null,
      status: null,
      stopCode: null,
    });
    expect(JSON.stringify(v)).not.toContain(MARKER);
    // The server's backstop does not look for this marker: the projection alone keeps it out.
    const s = await serve({ runs: [], pilot: source });
    await new Promise((r) => setTimeout(r, 80));
    expect(s.state().pilotRefused).toBe(false);
    expect(s.state().pilot?.trials).toHaveLength(1);
    expectNoLeak(await allBodies(s.port), [dir]);
  });

  it("valid values of the same fields are carried (so the nulls above are the filter, not a dropped field)", () => {
    const dir = tempDir("myco-watch-closed-ok-");
    writeProgress(dir, [
      startLine("r1p-t1-a1"),
      endLine("r1p-t1-a1", {
        at: "2026-11-27T10:01:00Z",
        armRow: {
          claim: "not-done",
          gate: { called: true, verdict: "refuted", corrections: "off" },
          accepted: false,
          cause: { kind: "oracle" },
        },
      }),
    ]);
    writeFileSync(
      join(dir, GRADES_FILE),
      `${JSON.stringify({ schema: "myco.benchmark.grade-row/1", trialKey: "r1p-t1-a1", status: "ungradable" })}\n`,
    );
    writeFileSync(
      join(dir, LIVE_STATUS_FILE),
      JSON.stringify({
        schema: "myco.pilot.live-status/1",
        runner: "r1-pilot",
        state: "finished",
        startedAt: AT,
        updatedAt: AT,
        exitCode: 3,
        result: { status: "halted", stopCode: "repeat-failure" },
      }),
    );
    const v = pilotRunSource(dir).poll();
    expect(v.trials[0]).toMatchObject({
      startedAt: AT,
      endedAt: "2026-11-27T10:01:00Z",
      says: "not-done",
      gate: { verdict: "refuted", corrections: "off" },
      causeKind: "oracle",
      grade: "ungradable",
    });
    expect(v.live).toMatchObject({
      runner: "r1-pilot",
      state: "finished",
      startedAt: AT,
      updatedAt: AT,
      exitCode: 3,
      status: "halted",
      stopCode: "repeat-failure",
    });
  });

  for (const [on, off] of [
    [true, false],
    [false, true],
  ] as const)
    it(`an A/B stage with on simulated=${on} and off simulated=${off} is SIMULATED as a whole`, async () => {
      const { root } = fakeStage();
      for (const [arm, simulated] of [
        ["on", on],
        ["off", off],
      ] as const) {
        const path = join(root, arm, PROGRESS_FILE);
        const lines = readFileSync(path, "utf8").split("\n");
        const header = JSON.parse(lines[0] ?? "") as Record<string, unknown>;
        lines[0] = JSON.stringify({ ...header, simulated });
        writeFileSync(path, lines.join("\n"));
      }
      const source = pilotRunSource(root);
      expect(source.poll()).toMatchObject({ layout: "ab", simulated: true });
      const s = await serve({ runs: [], pilot: source });
      await new Promise((r) => setTimeout(r, 80));
      expect((await raw(s.port, "/api/state")).body.toString("utf8")).toContain('"simulated":true');
    });
});

describe("watch --pilot: ledger, heartbeat and progress edge cases (round 1 N1-N3)", () => {
  it("a #518 ledger end while the progress file still says running disagrees", () => {
    const dir = tempDir("myco-watch-ledger-");
    writeProgress(dir, [startLine("r1p-t1-a1"), startLine("r1p-t2-a1")]);
    const ev = (kind: string, trialKey: string, extra: Record<string, unknown> = {}) =>
      JSON.stringify({ schema: "myco.m2.attempt-event/1", kind, trialKey, ...extra });
    writeFileSync(
      join(dir, ATTEMPT_LEDGER_FILE),
      `${[ev("start", "r1p-t1-a1"), ev("end", "r1p-t1-a1", { outcome: "completed" }), ev("start", "r1p-t2-a1")].join("\n")}\n`,
    );
    const v = pilotRunSource(dir).poll();
    expect(v.trials.map((t) => [t.state, t.ledger])).toEqual([
      ["running", "disagrees"],
      ["running", "agrees"],
    ]);
  });

  it("a finished run's old heartbeat is not stale; a running one's is", () => {
    const dir = tempDir("myco-watch-stale-");
    const status = (state: string) =>
      writeFileSync(
        join(dir, LIVE_STATUS_FILE),
        JSON.stringify({ schema: "myco.pilot.live-status/1", state, updatedAt: AT }),
      );
    const late = () => Date.parse(AT) + 10 * 180_000;
    status("finished");
    expect(pilotRunSource(dir, { now: late }).poll().live).toMatchObject({
      state: "finished",
      stale: false,
    });
    status("running");
    expect(pilotRunSource(dir, { now: late }).poll().live).toMatchObject({
      state: "running",
      stale: true,
    });
  });

  it("a heartbeat with another schema is not read", () => {
    const dir = tempDir("myco-watch-schema-");
    writeFileSync(
      join(dir, LIVE_STATUS_FILE),
      JSON.stringify({ schema: MARKER, runner: "r1-pilot", state: "running", updatedAt: AT }),
    );
    expect(pilotRunSource(dir).poll().live).toBeNull();
    writeFileSync(
      join(dir, LIVE_STATUS_FILE),
      JSON.stringify({ runner: "r1-pilot", state: "running", updatedAt: AT }),
    );
    expect(pilotRunSource(dir).poll().live).toBeNull();
  });

  it("the first start of a trial wins; a duplicate start is skipped, not overwritten", () => {
    const dir = tempDir("myco-watch-dup-");
    writeProgress(dir, [
      startLine("r1p-t1-a1", { taskId: "first", attempt: 1 }),
      startLine("r1p-t1-a1", { taskId: "second", attempt: 2 }),
    ]);
    const v = pilotRunSource(dir).poll();
    expect(v.trials).toHaveLength(1);
    expect(v.trials[0]).toMatchObject({ taskId: "first", attempt: 1 });
    expect(v.skipped).toBe(1);
  });
});

describe("watch --pilot: transcript projection", () => {
  it("keeps closed counts and REASON_CODES only; a single --output-format json result gives turns", () => {
    const view = projectTranscript(Buffer.from(plantedTranscript("refuted")));
    expect(view?.gateCalls[0]).toEqual({ verdict: "refuted", reasonCodes: ["STATE_MISSING"] });
    expectNoLeak(JSON.stringify(view), ["Bash"]);
    const single = projectTranscript(
      Buffer.from(
        JSON.stringify({
          type: "result",
          num_turns: 7,
          result: MARKER,
          usage: { input_tokens: 1 },
        }),
      ),
    );
    expect(single).toEqual({
      turns: 7,
      toolCalls: { gate: 0, other: 0 },
      denied: { gate: 0, other: 0 },
      gateCalls: [],
    });
    expect(projectTranscript(Buffer.from("not json"))).toBeNull();
    expect(projectTranscript(Buffer.from("[]"))).toBeNull();
    const bad = projectTranscript(
      Buffer.from(
        JSON.stringify([
          {
            type: "assistant",
            message: { content: [{ type: "tool_use", id: "g", name: GATE_GRANT }] },
          },
          {
            type: "user",
            message: {
              content: [
                {
                  type: "tool_result",
                  tool_use_id: "g",
                  content: `{"verdict":"${MARKER}","reasonCodes":"ORACLE_PASS"}`,
                },
              ],
            },
          },
          { type: "result", num_turns: -1 },
        ]),
      ),
    );
    expect(bad).toEqual({
      turns: null,
      toolCalls: { gate: 1, other: 0 },
      denied: { gate: 0, other: 0 },
      gateCalls: [{ verdict: null, reasonCodes: [] }],
    });
  });
});

describe("watch --pilot: never opens the oracle's inputs or the vault", () => {
  it("FIFOs planted at doc.csv, gate-tasks.json, gate-evidence/ and vault/ are never opened", () => {
    const { root, on } = fakeStage();
    const trial = join(root, "on", "trials", on("fc-001"));
    const fifos = [
      join(trial, "doc.csv"),
      join(trial, "gate-tasks.json"),
      join(trial, "mcp.json"),
      join(trial, "gate-evidence"),
      join(root, "on", "vault"),
    ];
    for (const path of fifos) {
      rmSync(path, { recursive: true, force: true });
      expect(spawnSync("mkfifo", [path]).status).toBe(0);
    }
    // Give the trial a transcript so the reader does open files in that directory.
    writeFileSync(join(trial, "transcript.json"), plantedTranscript("refuted"));
    const r = spawnSync("npx", ["tsx", join(ROOT, "test", "watch", "poll-run-dir.ts"), root], {
      cwd: ROOT,
      encoding: "utf8",
      // The child takes well under a second; a reader that opened a FIFO blocks until killed.
      timeout: 15_000,
    });
    expect(r.signal, r.stderr).toBeNull();
    expect(r.status, r.stderr).toBe(0);
    const v = JSON.parse(r.stdout) as PilotView;
    expect(v.trials[0]?.actions?.gateCalls[0]?.verdict).toBe("refuted");
  }, 30_000);
});

describe("watch --pilot: server backstop and CLI", () => {
  it("a view that still carries a host needle or path is refused whole", async () => {
    const leaky: PilotRunSource = {
      poll: () =>
        ({
          layout: "single",
          simulated: true,
          progressPresent: true,
          live: null,
          trials: [{ trialKey: `r1p${HOME}` }],
          counts: { running: 0, decided: 0, faulted: 0, accepted: 0 },
          omitted: 0,
          skipped: 0,
        }) as unknown as PilotView,
    };
    const s = await serve({ runs: [], pilot: leaky });
    expect(s.state()).toMatchObject({ pilot: null, pilotRefused: true });
    expectNoLeak(await allBodies(s.port));
  });

  it("a poll that throws keeps the last good view", async () => {
    let calls = 0;
    const good = pilotRunSource(fakeStage().root);
    const flaky: PilotRunSource = {
      poll: () => {
        calls += 1;
        if (calls > 1) throw new Error(FAKE_ABS_PATH);
        return good.poll();
      },
    };
    const s = await serve({ runs: [], pilot: flaky });
    await new Promise((r) => setTimeout(r, 80));
    expect(calls).toBeGreaterThan(1);
    expect(s.state().pilot?.trials).toHaveLength(6);
  });

  it("--pilot needs no --run, does not go with --demo, and the run directory is never echoed", async () => {
    expect(parseWatchArgs(["--pilot", "/x/run"])).toMatchObject({ pilot: "/x/run", runs: [] });
    expect(() => parseWatchArgs(["--demo", "todo-items", "--pilot", "/x"])).toThrow(
      /--pilot does not go with --demo/,
    );
    expect(() => parseWatchArgs([])).toThrow();
    const { root } = fakeStage();
    const out: string[] = [];
    const stdout = { write: (s: string) => out.push(s) } as never;
    const started = await startFromArgs(parseWatchArgs(["--pilot", root, "--port", "0"]), stdout);
    open.push(started.server);
    expect(out.join("")).toMatch(
      /^myco watch \(read-only, pilot run\): http:\/\/127\.0\.0\.1:\d+\/\n$/,
    );
    expect(out.join("")).not.toContain(root);
    expect(started.server.state().pilot?.layout).toBe("ab");
    expectNoLeak(await allBodies(started.server.port), [root]);
  });
});
