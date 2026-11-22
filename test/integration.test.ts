/**
 * M1-013 integration tests: the Windows seams (adapter, fixture converter,
 * trial program) exercised against the fake agent over the real wire shape.
 * CI never touches Windows; the guest-only behavior is pinned here by
 * proving which ops the seams issue and how results are normalized.
 */

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  FIXTURE_CONVERT_DEADLINE_MS,
  runTrial,
  windowsProgramFor,
} from "../src/integration/trial.ts";
import { WindowsFixtureConverter } from "../src/integration/windows-fixture.ts";
import { generateFixture } from "../src/tasks/fixture.ts";
import { type CalcRecordEditParams, groundTruth } from "../src/tasks/intent.ts";
import { AgentClient } from "../src/win/agent-client.ts";
import { unoModified, unoString } from "../src/win/calc-adapter.ts";
import { FakeAgent } from "./fake/agent.ts";

const PARAMS: CalcRecordEditParams = {
  fixtureSeed: "seed-alpha",
  rowKey: "EMP-0003",
  column: "name",
  newValue: "myco-x",
};

function clientWith(script: ConstructorParameters<typeof FakeAgent>[0]): {
  client: AgentClient;
  agent: FakeAgent;
} {
  const agent = new FakeAgent(script);
  return { client: new AgentClient(agent, { token: "test-token" }), agent };
}

describe("uno_eval result normalization (deployed-agent shape)", () => {
  it("reads get_string from both the host shape and the agent {value} shape", () => {
    expect(unoString({ get_string: "abc" })).toBe("abc");
    expect(unoString({ value: "abc" })).toBe("abc");
    expect(unoString({})).toBe("");
  });

  it("reads is_modified from both shapes", () => {
    expect(unoModified({ is_modified: true })).toBe(true);
    expect(unoModified({ value: true })).toBe(true);
    expect(unoModified({ value: false })).toBe(false);
    expect(unoModified({})).toBe(false);
  });

  it("adapter observe() turns uno_eval cell readbacks into state nodes", async () => {
    const gt = groundTruth(PARAMS);
    const { client } = clientWith({
      unoBehavior: (params) => (params.call === "is_modified" ? false : gt.previousValue),
    });
    const { WindowsCalcAdapter } = await import("../src/win/calc-adapter.ts");
    const adapter = new WindowsCalcAdapter({
      client,
      xlsxPath: "C:\\myco\\runs\\fixture.xlsx",
      unoSocket: "2002",
      observedCells: [gt.cellRef],
    });
    const state = await adapter.observe();
    const node = state.nodes.find((n) => n.id === gt.cellRef);
    expect(node?.value).toBe(gt.previousValue);
    expect(state.facts.dirty).toBe(false);
    expect(state.facts.documentPath).toBe("C:\\myco\\runs\\fixture.xlsx");
  });

  it("adapter observe() propagates UNO failure as an error, never an empty state", async () => {
    const { client } = clientWith({ unoBehavior: () => "error" });
    const { WindowsCalcAdapter } = await import("../src/win/calc-adapter.ts");
    const adapter = new WindowsCalcAdapter({
      client,
      xlsxPath: "C:\\x\\f.xlsx",
      unoSocket: "2002",
      observedCells: ["B4"],
    });
    await expect(adapter.observe()).rejects.toMatchObject({ name: "AgentOpError" });
  });

  it("adapter act(keyPress ctrl+s) issues launch + polls the helper result", async () => {
    // read_file returns the helper result JSON; the adapter must parse it.
    const { client, agent } = clientWith({
      unoBehavior: () => "",
      csvBytes: Buffer.from(JSON.stringify({ ok: true })),
    });
    const { WindowsCalcAdapter } = await import("../src/win/calc-adapter.ts");
    const adapter = new WindowsCalcAdapter({
      client,
      xlsxPath: "C:\\x\\f.xlsx",
      unoSocket: "2002",
      observedCells: ["B4"],
    });
    const result = await adapter.act({ kind: "keyPress", keys: "ctrl+s" });
    expect(result.outcome).toBe("delivered_unverified");
    const launches = agent.requests.filter((r) => r.op === "launch");
    expect(launches.length).toBeGreaterThan(0);
  });
});

describe("WindowsFixtureConverter", () => {
  it("writes the CSV guest-side and converts via headless soffice with an isolated profile", async () => {
    const { client, agent } = clientWith({ unoEval: [], csvBytes: Buffer.from("zz") });
    // read_file answers the xlsx poll with dummy bytes — proves the poll path.
    const converter = new WindowsFixtureConverter({
      client,
      guestDir: "C:\\myco\\runs",
    });
    const fixture = generateFixture(PARAMS.fixtureSeed);
    await converter.convert(Buffer.from(fixture.csv, "utf8"));
    const writes = agent.requests.filter((r) => r.op === "write_file");

    const writePath = String(
      ((writes[0] ?? { params: {} }).params as { path?: string }).path ?? "",
    );
    expect(writePath).toContain("fixture.csv");
    expect(writePath).toContain("myco-"); // nonce dir: no cross-run reuse

    const launches = agent.requests.filter((r) => r.op === "launch");
    const convArgv = launches[0]?.params.argv as string[];
    expect(convArgv[0]).toBe("soffice.com");
    expect(convArgv.join(" ")).toContain("--convert-to xlsx");
    expect(convArgv.join(" ")).toContain("-env:UserInstallation=file:///"); // isolated profile

    expect(converter.format).toBe("xlsx");
    expect(converter.lastXlsxPath).toContain("fixture.xlsx");
    expect(converter.lastXlsxPath).toContain(String(writePath.split("\\")[0] ?? ""));
  });

  it("fails loudly when the convert never produces the xlsx", async () => {
    const { client } = clientWith({
      unoEval: [],
      readFileError: true, // the xlsx poll always fails
    });
    const converter = new WindowsFixtureConverter({
      client,
      guestDir: "C:\\myco\\runs",
      timeoutMs: 1_000,
    });
    await expect(converter.convert(Buffer.from("a,b\n1,2\n", "utf8"))).rejects.toThrow(
      /did not produce .* within 1000ms/,
    );
    const timing = converter.lastTiming;
    expect(timing?.outcome).toBe("deadline");
    expect(timing?.deadlineMs).toBe(1_000);
    expect(timing?.durationMs ?? 0).toBeGreaterThanOrEqual(1_000);
  });

  it("records an arrived timing when the workbook appears", async () => {
    const { client } = clientWith({ unoEval: [], csvBytes: Buffer.from("zz") });
    const converter = new WindowsFixtureConverter({ client, guestDir: "C:\\myco\\runs" });
    expect(converter.lastTiming).toBeNull();
    await converter.convert(Buffer.from("a,b\n1,2\n", "utf8"));
    expect(converter.lastTiming).toMatchObject({ outcome: "arrived", deadlineMs: 60_000 });
  });

  it("live trials wait 240 s for the workbook (approved M1-013 deadline)", () => {
    expect(FIXTURE_CONVERT_DEADLINE_MS).toBe(240_000);
  });
});

describe("windowsProgramFor guards", () => {
  it("keeps the invalid-target GuardFailure abort (family contract)", () => {
    const program = windowsProgramFor({
      ...PARAMS,
      rowKey: "EMP-9999",
    });
    expect(program.steps.length).toBe(1);
    const pre = program.steps[0]?.preconditions ?? [];
    expect(pre.length).toBe(1);
    // A state can never satisfy the invalid-target precondition.
    const anyState = {
      stateVersion: 1,
      capturedAt: "",
      facts: { documentPath: "x", dirty: false, focusedNodeId: null },
      nodes: [],
    };
    expect(pre[0]?.check(anyState)).toBe(false);
  });

  it("set step postcondition requires the new value in observed state", () => {
    const gt = groundTruth(PARAMS);
    const program = windowsProgramFor(PARAMS);
    const setStep = program.steps.find((s) => s.action.kind === "setValue");
    expect(setStep).toBeDefined();
    const state = {
      stateVersion: 1,
      capturedAt: "",
      facts: { documentPath: "x", dirty: false, focusedNodeId: null },
      nodes: [
        {
          id: gt.cellRef,
          role: "cell" as const,
          name: gt.cellRef,
          value: gt.expectedValue,
          bounds: { x: 0, y: 0, width: 0, height: 0 },
          enabled: true,
          visible: true,
        },
      ],
    };
    const post = setStep?.postconditions ?? [];
    expect(post.every((p) => p.check(state))).toBe(true);
  });

  it("save step is marked isSave and its postcondition checks not-dirty", () => {
    const program = windowsProgramFor(PARAMS);
    const saveStep = program.steps.find((s) => s.isSave);
    expect(saveStep?.action.kind).toBe("keyPress");
    expect(saveStep?.action).toMatchObject({ keys: "ctrl+s" });
    const dirtyState = {
      stateVersion: 1,
      capturedAt: "",
      facts: { documentPath: "x", dirty: true, focusedNodeId: null },
      nodes: [],
    };
    const cleanState = {
      stateVersion: 1,
      capturedAt: "",
      facts: { documentPath: "x", dirty: false, focusedNodeId: null },
      nodes: [],
    };
    const post = saveStep?.postconditions ?? [];
    expect(post.length).toBe(1);
    expect(post[0]?.check(dirtyState)).toBe(false);
    expect(post[0]?.check(cleanState)).toBe(true);
  });
});

describe("trial evidence artifacts", () => {
  it("a normal trial writes schema-valid trace.jsonl and result.json", async () => {
    const { runTrial } = await import("../src/integration/trial.ts");
    const gt = groundTruth(PARAMS);
    const fixture = generateFixture(PARAMS.fixtureSeed);
    const fixtureRow = fixture.rows[gt.location.dataRowIndex];
    const keyCell = `A${gt.location.dataRowIndex + 2}`;
    const { client } = clientWith({
      desktopOverlay: true,
      unoBehavior: (params) => {
        // Pristine readback for anything the fake desktop has not written;
        // the helper's nametype mutation overrides the target cell after the
        // set step, exactly like real UNO reads the edited document.
        if (params.cell === keyCell) return String(fixtureRow?.[0] ?? "");
        return gt.previousValue;
      },
      csvBytes: csvWithTarget(PARAMS, gt),
    });
    const runsDir = mkdtempSync(join(tmpdir(), "myco-trial-"));
    const report = await runTrial({
      client,
      params: PARAMS,
      unoSocket: "2002",
      runsDir,
    });
    expect(report.verdict.status).toBe("verified");
    expect(report.completed).toBe(true);
    expect(report.xlsxPath).toContain("fixture.xlsx");

    const trace = readFileSync(join(runsDir, report.runId, "trace.jsonl"), "utf8");
    const lines = trace.split("\n").filter((l) => l !== "");
    expect(lines.length).toBeGreaterThan(0);
    const first = JSON.parse(lines[0] ?? "{}");
    expect(first.type).toBe("run-start");
    const result = JSON.parse(readFileSync(join(runsDir, report.runId, "result.json"), "utf8"));
    expect(result.verdict.status).toBe("verified");
    expect(result.taskId).toBe("calc-record-edit");
    // open, locate, set, save — no close step on Windows (PR body).
    expect(result.steps.length).toBe(4);
  });

  it("a convert-failed trial ends uncertain with evidence, never verified", async () => {
    const { runTrial } = await import("../src/integration/trial.ts");
    const { client } = clientWith({
      unoBehavior: () => "error",
      failOps: ["write_file"],
    });
    const runsDir = mkdtempSync(join(tmpdir(), "myco-trial-dead-"));
    const report = await runTrial({
      client,
      params: PARAMS,
      unoSocket: "2002",
      runsDir,
      skipGuestHealth: true, // this test faults write_file; probe uses that op too
    });
    expect(report.verdict.status).toBe("uncertain");
    expect(report.completed).toBe(false);
    // Evidence is written even when the fixture convert failed.
    const result = JSON.parse(readFileSync(join(runsDir, report.runId, "result.json"), "utf8"));
    expect(result.verdict.status).toBe("uncertain");
    expect(result.guardFailure.predicateName).toBe("fixture-convert");
  });
});

describe("live corruption modes over the fake agent", () => {
  it.each([
    ["invalid-target", false, "stale ref"],
    ["dropped-save", true, "not dirty after save"],
    ["focus-change", false, "holds"],
  ] as const)("%s lands and leaves the persisted intent refuted", async (fault, typed, guard) => {
    const gt = groundTruth(PARAMS);
    const fixture = generateFixture(PARAMS.fixtureSeed);
    const { client, agent } = clientWith({
      desktopOverlay: true,
      unoBehavior: () => gt.previousValue,
      csvBytes: Buffer.from(fixture.csv),
    });
    const runsDir = mkdtempSync(join(tmpdir(), "myco-corrupt-trial-"));
    vi.useFakeTimers();
    try {
      const pending = runTrial({ client, params: PARAMS, unoSocket: "2002", runsDir, fault });
      await vi.runAllTimersAsync();
      const report = await pending;
      expect(report).toMatchObject({
        completed: false,
        verdict: { status: "refuted" },
        corruption: { mode: fault, applied: true, persistedValue: gt.previousValue },
      });
      expect(`${report.guardFailure?.predicateName} ${report.guardFailure?.observed}`).toContain(
        guard,
      );
      expect(agent.desktopCells.get(gt.cellRef)).toBe(typed ? gt.expectedValue : undefined);
      const launches = agent.requests.filter((request) => request.op === "launch");
      expect(
        launches.some((request) => JSON.stringify(request.params.argv).includes("steal_focus")),
      ).toBe(fault === "focus-change");
      expect(
        launches.some((request) =>
          (request.params.argv as string[]).some((arg) => arg.includes('"op":"save"')),
        ),
      ).toBe(false);
      const trace = readFileSync(join(runsDir, report.runId, "trace.jsonl"), "utf8");
      expect(trace).toContain(`"fault":"${fault}"`);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ["invalid-target", "retry:1-completed"],
    ["kill", "relaunch:completed"],
  ] as const)("recovers from %s and independently verifies the saved edit", async (mode, event) => {
    const gt = groundTruth(PARAMS);
    const fixture = generateFixture(PARAMS.fixtureSeed);
    const { client } = clientWith({
      desktopOverlay: true,
      killCalcDesktop: mode === "kill",
      unoBehavior: () => gt.previousValue,
      csvBytes: Buffer.from(fixture.csv),
      csvBytesAfterSave: csvWithTarget(PARAMS, gt),
    });
    const runsDir = mkdtempSync(join(tmpdir(), "myco-recovery-trial-"));
    vi.useFakeTimers();
    try {
      const pending = runTrial({
        client,
        params: PARAMS,
        unoSocket: "2002",
        runsDir,
        recovery: true,
        ...(mode === "kill" ? { killAfterStep: 3, auditKill: true } : { fault: mode }),
      });
      await vi.runAllTimersAsync();
      const report = await pending;
      expect(report).toMatchObject({
        completed: true,
        verdict: { status: "verified" },
        corruption: {
          mode,
          applied: true,
          recovery: true,
          recoveryEvents: expect.arrayContaining([event]),
          persistedValue: gt.expectedValue,
        },
      });
      const trace = readFileSync(join(runsDir, report.runId, "trace.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(trace[1]).toMatchObject({ type: "fault-injection", fault: mode });
      if (mode === "invalid-target") expect(trace[1]?.detail).toContain("stale ref");
      expect(trace).toContainEqual(expect.objectContaining({ type: "recovery", event }));
    } finally {
      vi.useRealTimers();
    }
  });
});

function csvWithTarget(params: CalcRecordEditParams, gt: ReturnType<typeof groundTruth>): Buffer {
  const fixture = generateFixture(params.fixtureSeed);
  const rows = [fixture.header.join(",")];
  fixture.rows.forEach((row, i) => {
    const cells = [...row];
    if (i === gt.location.dataRowIndex) cells[gt.location.colIndex] = gt.expectedValue;
    rows.push(cells.join(","));
  });
  return Buffer.from(`${rows.join("\n")}\n`);
}
