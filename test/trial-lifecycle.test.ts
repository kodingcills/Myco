/**
 * M1-019 lifecycle tests: guest-health precondition and unconditional cleanup
 * exercised through the fake agent transport (no VM). The fake models the
 * guest cmd.exe batches the host generates, so the real probe/cleanup code
 * runs — not a stub of its interfaces.
 */

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { guestContaminated, probeGuestHealth } from "../src/integration/guest-health.js";
import { guestBasename } from "../src/integration/guest-shell.js";
import { runTrial } from "../src/integration/trial.ts";
import { generateFixture } from "../src/tasks/fixture.ts";
import { type CalcRecordEditParams, type GroundTruth, groundTruth } from "../src/tasks/intent.ts";
import { AgentClient } from "../src/win/agent-client.ts";
import { FakeAgent } from "./fake/agent.ts";

const PARAMS: CalcRecordEditParams = {
  fixtureSeed: "seed-alpha",
  rowKey: "EMP-0003",
  column: "name",
  newValue: "myco-x",
};

function clientWith(script: ConstructorParameters<typeof FakeAgent>[0]) {
  const writtenFiles = script.writtenFiles ?? new Map<string, Buffer>();
  const agent = new FakeAgent({ ...script, writtenFiles });
  return { client: new AgentClient(agent, { token: "test-token" }), agent, writtenFiles };
}

function csvWithTarget(params: CalcRecordEditParams, gt: GroundTruth): Buffer {
  const fixture = generateFixture(params.fixtureSeed);
  const rows = [fixture.header.join(",")];
  fixture.rows.forEach((row, i) => {
    const cells = [...row];
    if (i === gt.location.dataRowIndex) cells[gt.location.colIndex] = gt.expectedValue;
    rows.push(cells.join(","));
  });
  return Buffer.from(`${rows.join("\n")}\n`);
}

/** The existing happy-path script: pristine reads, helper mutation, persisted CSV. */
function cleanScript(): ConstructorParameters<typeof FakeAgent>[0] {
  const gt = groundTruth(PARAMS);
  const fixture = generateFixture(PARAMS.fixtureSeed);
  const keyCell = `A${gt.location.dataRowIndex + 2}`;
  const row = fixture.rows[gt.location.dataRowIndex];
  return {
    desktopOverlay: true,
    unoBehavior: (params) => (params.cell === keyCell ? String(row?.[0] ?? "") : gt.previousValue),
    csvBytes: csvWithTarget(PARAMS, gt),
  };
}

function trialOpts(client: AgentClient, runsDir: string) {
  return {
    client,
    params: PARAMS,
    unoSocket: "2002",
    runsDir,
    guestHygieneTimeoutMs: 2_000,
  };
}

function newRunsDir(): string {
  return mkdtempSync(join(tmpdir(), "myco-m1-019-"));
}

function cleanupBatchText(agent: FakeAgent, writtenFiles: Map<string, Buffer>): string {
  const launches = agent.requests.filter((request) => request.op === "launch");
  const scriptPath =
    launches
      .map((request) => (request.params.argv as string[])[2] ?? "")
      .find((path) => path.endsWith("cleanup.cmd")) ?? "";
  return writtenFiles.get(scriptPath)?.toString("utf8") ?? "";
}

describe("M1-019 unconditional trial cleanup", () => {
  it("kills soffice and removes the trial dirs even when the trial throws", async () => {
    const { client, agent, writtenFiles } = clientWith(cleanScript());
    // A circular param makes evidence serialization throw AFTER the program
    // ran and the verdict was computed — the harness-error path.
    const circular: Record<string, unknown> = { ...PARAMS };
    circular.self = circular;

    await expect(
      runTrial({
        ...trialOpts(client, newRunsDir()),
        params: circular as unknown as CalcRecordEditParams,
      }),
    ).rejects.toThrow();

    const kills = agent.requests.filter((r) => r.op === "kill");
    expect(kills.map((r) => r.params.image_name)).toEqual(
      expect.arrayContaining(["soffice.bin", "soffice.exe"]),
    );
    expect(cleanupBatchText(agent, writtenFiles)).toContain("rd /s /q");
  });

  it("cleans up after a guard failure", async () => {
    const gt = groundTruth(PARAMS);
    const { client, agent, writtenFiles } = clientWith({
      csvBytes: csvWithTarget(PARAMS, gt),
      // is_modified fails only AFTER launch: launchCalc's readiness poll
      // uses get_string, so the first program observation is the guard death.
      unoBehavior: (params) => (params.call === "is_modified" ? "error" : gt.previousValue),
    });
    const report = await runTrial(trialOpts(client, newRunsDir()));
    expect(report.guardFailure?.predicateName).toBe("adapter-available");
    expect(report.completed).toBe(false);
    expect(agent.requests.some((r) => r.op === "kill")).toBe(true);
    expect(report.cleanup.removed.length).toBeGreaterThan(0);
    expect(report.cleanup.residue).toEqual([]);
    expect(cleanupBatchText(agent, writtenFiles)).toContain("rd /s /q");
  });

  it("a contaminated fake guest aborts guest-contaminated and uncertain", async () => {
    const { client, agent } = clientWith({
      ...cleanScript(),
      strayProcesses: { "soffice.bin": [4242] },
    });
    const runsDir = newRunsDir();
    const report = await runTrial(trialOpts(client, runsDir));

    expect(report.verdict.status).toBe("uncertain");
    expect(report.guardFailure).toMatchObject({
      predicateName: "guest-contaminated",
      phase: "precondition",
    });
    expect(report.guardFailure?.observed).toContain("4242");
    // No fixture was written: the trial never ran a program.
    const wroteFixture = agent.requests
      .filter((r) => r.op === "write_file")
      .some((r) => String((r.params as { path?: string }).path ?? "").includes("fixture.csv"));
    expect(wroteFixture).toBe(false);

    const result = JSON.parse(readFileSync(join(runsDir, report.runId, "result.json"), "utf8"));
    expect(result.verdict.status).toBe("uncertain");
    expect(result.guardFailure.predicateName).toBe("guest-contaminated");
  });

  it("a leftover run dir alone contaminates the guest", async () => {
    const { client } = clientWith({
      ...cleanScript(),
      batch: () => "myco-leftover-run\r\n",
    });
    const report = await runTrial(trialOpts(client, newRunsDir()));

    expect(report.verdict.status).toBe("uncertain");
    expect(report.guardFailure?.predicateName).toBe("guest-contaminated");
    expect(report.guardFailure?.observed).toContain("myco-leftover-run");
  });

  it("excludes this trial's own run dir from the leftovers", async () => {
    const { client } = clientWith({
      batch: () => "myco-own-dir\r\n",
    });
    const finding = await probeGuestHealth({
      client,
      runRoot: "C:\\myco\\runs",
      ownRunDirName: "myco-own-dir",
      timeoutMs: 2_000,
    });

    expect(guestContaminated(finding)).toBe(false);
    expect(finding.strayRunDirs).toEqual([]);
  });

  it("a clean guest proceeds normally and is verified", async () => {
    const { client } = clientWith(cleanScript());
    const report = await runTrial(trialOpts(client, newRunsDir()));

    expect(report.verdict.status).toBe("verified");
    expect(report.completed).toBe(true);
    expect(report.guardFailure).toBeUndefined();
    expect(report.cleanup.residue).toEqual([]);
  });

  it("cleanup failure does not mask the verdict and is recorded in the trace", async () => {
    const { client } = clientWith({
      ...cleanScript(),
      // Every rd target survives: simulate files locked past the retries.
      batch: (script) =>
        [...script.matchAll(/rd \/s \/q "([^"]+)"/g)]
          .map((match) => `${guestBasename(match[1] ?? "")}\r\n`)
          .join(""),
    });
    const runsDir = newRunsDir();
    const report = await runTrial(trialOpts(client, runsDir));

    expect(report.verdict.status).toBe("verified");
    expect(report.cleanup.residue.length).toBeGreaterThan(0);
    expect(report.cleanup.removed).toEqual([]);

    const trace = readFileSync(join(runsDir, report.runId, "trace.jsonl"), "utf8");
    expect(trace).toContain('"fault":"cleanup-failed"');
  });
});
