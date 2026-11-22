import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkPreflightGates,
  runDirectionALiveTask,
} from "../../src/foundry/grader/direction-a-live-runner.ts";
import { loadTaskPackage } from "../../src/foundry/grader/direction-a-runner.ts";

describe("Direction A Live Runner and Pre-Flight Gates", () => {
  const taskPkgPath = resolve(process.cwd(), "tasks/todo-save.yaml");
  const taskPkg = loadTaskPackage(taskPkgPath);
  const fakeServerCmd = `python3 ${resolve(process.cwd(), "test/fake_mcp.py")}`;
  const nonExistentLock = "/tmp/test-direction-a-free.lock";

  it("checks preflight gates and refuses live execution without Coordinator GO", () => {
    const preflight = checkPreflightGates({});
    expect(preflight.ok).toBe(false);
    expect(preflight.refusedGate).toBe("G4");
    expect(preflight.refusalReason).toContain("Dedicated host VM execution slot not granted");
    expect(preflight.refusalReason).toContain("Coordinator GO (--go) required");

    const g1 = preflight.gates.find((g) => g.gate === "G1");
    const g2 = preflight.gates.find((g) => g.gate === "G2");
    const g3 = preflight.gates.find((g) => g.gate === "G3");
    const g4 = preflight.gates.find((g) => g.gate === "G4");

    expect(g1?.passed).toBe(true);
    expect(g1?.detail).toContain("RT-020 live proof verified");
    expect(g2?.passed).toBe(true);
    expect(g3?.passed).toBe(true);
    expect(g4?.passed).toBe(false);
  });

  it("passes preflight gates when --go is provided with a free lock", () => {
    rmSync(nonExistentLock, { force: true });
    const preflight = checkPreflightGates({ go: true, lockPath: nonExistentLock });
    expect(preflight.ok).toBe(true);
    expect(preflight.refusedGate).toBeUndefined();
    expect(preflight.gates.every((g) => g.passed)).toBe(true);
  });

  it("detects VM lock contention when lock is held by another process", () => {
    const heldLock = "/tmp/test-direction-a-held.lock";
    writeFileSync(heldLock, "99999 other-workstream.sh\n", "utf8");
    try {
      const preflight = checkPreflightGates({ go: true, lockPath: heldLock });
      expect(preflight.ok).toBe(false);
      expect(preflight.refusedGate).toBe("G4");
      expect(preflight.refusalReason).toContain("LOCK CONTENDED");
    } finally {
      rmSync(heldLock, { force: true });
    }
  });

  it("passes preflight gates when --server-cmd stub is provided for testing", () => {
    const preflight = checkPreflightGates({ serverCmd: fakeServerCmd });
    expect(preflight.ok).toBe(true);
    expect(preflight.refusedGate).toBeUndefined();
    expect(preflight.gates.every((g) => g.passed)).toBe(true);
  });

  it("refuses live task run safely when Coordinator GO is absent", async () => {
    const result = await runDirectionALiveTask(taskPkg, "runs", {});
    expect(result.exitCode).toBe(2);
    expect(result.verdict).toBe("uncertain");
    expect(result.falseSuccess).toBe(false);
    expect(result.preflight.ok).toBe(false);
    expect(result.agentClaim).toContain("Coordinator GO required");
    expect(result.checks.some((c) => c.name === "gate-g4-coordinator-go" && !c.passed)).toBe(true);
  });

  it("executes task package against stub MCP server when serverCmd is passed", async () => {
    const resultDir = resolve(process.cwd(), "runs/direction-a-todo-save-live");
    const archivePath = resolve(process.cwd(), "runs/direction-a-todo-save-live.mycotrace");

    // Clean any prior artifacts
    rmSync(resultDir, { recursive: true, force: true });
    rmSync(archivePath, { force: true });

    const result = await runDirectionALiveTask(taskPkg, "runs", {
      serverCmd: fakeServerCmd,
    });

    expect(result.preflight.ok).toBe(true);
    expect(result.exitCode).toBe(1); // REFUTED (false success caught)
    expect(result.verdict).toBe("refuted");
    expect(result.falseSuccess).toBe(true);
    expect(result.live).toBe(true);
    expect(result.itemsAttempted).toHaveLength(4);
    expect(result.itemsPersisted).toHaveLength(2);
    expect(result.itemsMissing).toHaveLength(2);

    // Verify files on disk
    expect(existsSync(resolve(resultDir, "trace.jsonl"))).toBe(true);
    expect(existsSync(resolve(resultDir, "trace.extended.jsonl"))).toBe(true);
    expect(existsSync(resolve(resultDir, "result.json"))).toBe(true);
    expect(existsSync(resolve(resultDir, "ledger.jsonl"))).toBe(true);
    expect(existsSync(resolve(resultDir, "manifest.json"))).toBe(true);
    expect(existsSync(archivePath)).toBe(true);

    // Verify manifest and result record carry simulated: false and dryRun: false
    const manifest = JSON.parse(readFileSync(resolve(resultDir, "manifest.json"), "utf8"));
    expect(manifest.format).toBe("mycotrace/1");
    expect(manifest.simulated).toBe(false);
    expect(manifest.dryRun).toBe(false);

    const resultRecord = JSON.parse(readFileSync(resolve(resultDir, "result.json"), "utf8"));
    expect(resultRecord.simulated).toBe(false);
    expect(resultRecord.dryRun).toBe(false);
    expect(resultRecord.verdict.status).toBe("refuted");
    expect(resultRecord.verdict.reasons[1]).toContain("FALSE SUCCESS");
  });
});
