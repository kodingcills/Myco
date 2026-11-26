/**
 * Track Q (replayable proof): the $0 scripted end to end. No model, no VM, no network.
 *
 * A scripted fake agent drives the mock desktop through df-s02 (the app silently drops BUG
 * items while saying "saved"); the harness materializes the store; the REAL gate runs as a
 * separate MCP stdio process bound to the trial; the harness logs the attempt to an
 * attempt ledger in #518's format. The run is then exported with the CLI, verified,
 * rendered, and tampered with. Every row is simulated: nothing here is evidence.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { MockDesktop } from "../../src/discovery/mock-desktop.ts";
import { runTask } from "../../src/discovery/run-tasks.ts";
import { openBoundGate } from "../../src/gate/demo.ts";
import type { ProofBundle, ProofStep } from "../../src/proof/bundle.ts";
import { main } from "../../src/proof/cli.ts";
import { buildLedger } from "./fixture.ts";

function cli(args: string[]): { code: number; out: string } {
  let out = "";
  const code = main(args, {
    out: (t) => {
      out += t;
    },
    err: (t) => {
      out += t;
    },
  });
  return { code, out };
}

describe("$0 scripted end to end: mock desktop -> real gate -> proof bundle", () => {
  it("exports, verifies, renders, and refuses tampering", async () => {
    const work = mkdtempSync(join(tmpdir(), "proof-e2e-"));
    const evidenceRoot = join(work, "evidence");
    const taskId = "df-s02";
    const runId = "proof-e2e-df-s02";
    const task = runTask(taskId);
    const steps: ProofStep[] = [];

    // 1. The scripted agent drives the mock desktop; the harness records each action.
    const desktop = new MockDesktop();
    const session = await desktop.create();
    const act = async (
      tool: string,
      action: Parameters<MockDesktop["act"]>[1],
      summary: string,
    ) => {
      steps.push({
        kind: "policy",
        policyId: "local-allowlist",
        subject: tool,
        decision: "allow",
        reasonCode: "POLICY_ALLOW",
      });
      await desktop.act(session, action);
      steps.push({ kind: "action", actor: "agent", tool, summary });
    };
    // The launch line names guest paths and the work dir is an absolute host path: both
    // must be redacted from the bundle.
    await act(
      "launch",
      { kind: "launch", command: task.launch.command, args: task.launch.args },
      `launch ${task.launch.args.join(" ")} (work ${work})`,
    );
    for (const item of task.items) {
      await act("typeTextGlobal", { kind: "typeTextGlobal", text: item }, `type "${item}"`);
      await act("keyPress", { kind: "keyPress", keys: "Return" }, "Return");
    }
    await act("clickAt", { kind: "clickAt", x: 210, y: 284 }, "click Save");
    const status = (await desktop.observe()).statusText;
    steps.push({
      kind: "action",
      actor: "agent",
      tool: "observe",
      summary: `status line: ${status}`,
    });
    steps.push({
      kind: "handoff",
      from: "agent",
      to: "gate",
      summary: `claim: ${task.agentClaim}`,
    });
    const storeFile = join(evidenceRoot, runId, task.storePath);
    mkdirSync(dirname(storeFile), { recursive: true });
    writeFileSync(storeFile, await desktop.readFile(session, task.storePath));
    await desktop.destroy();

    // 2. The real gate, bound to this one trial, decides on the persisted bytes.
    const gate = await openBoundGate(evidenceRoot, join(work, "gate-decisions.jsonl"), {
      taskId,
      runId,
    });
    const result = await gate
      .call({ taskId, runId, claim: task.agentClaim })
      .finally(() => gate.close());
    expect(result.verdict).toBe("refuted");
    expect(result.accepted).toBe(false);

    // Evidence: the persisted state the gate read, by digest (the file stays in the run dir).
    const evidenceIds: string[] = [];
    for (const [i, ref] of result.evidenceRefs.entries()) {
      const id = `ev-${i}`;
      evidenceIds.push(id);
      steps.push({
        kind: "evidence",
        evidenceId: id,
        evidenceKind: ref.kind,
        mediaType: "application/json",
        path: `${ref.runId}/${ref.path}`,
        content: readFileSync(join(evidenceRoot, ref.runId, ref.path)),
      });
    }
    steps.push({
      kind: "verdict",
      taskId,
      runId,
      verdict: result.verdict,
      accepted: result.accepted,
      reasonCodes: result.reasonCodes,
      evidence: evidenceIds,
      ...(result.oracle === undefined ? {} : { oracle: result.oracle }),
    });

    // 3. The harness's attempt ledger (#518 format), another trial first.
    const ledger = buildLedger([
      { kind: "start", trialKey: "warmup", taskId: "df-s01", arm: "myco-gate" },
      { kind: "end", trialKey: "warmup", taskId: "df-s01", arm: "myco-gate", outcome: "completed" },
      { kind: "start", trialKey: runId, taskId, arm: "myco-gate" },
      { kind: "end", trialKey: runId, taskId, arm: "myco-gate", outcome: "completed" },
    ]);
    writeFileSync(
      join(work, "attempts.jsonl"),
      `${ledger.lines.map((l) => JSON.stringify(l)).join("\n")}\n`,
    );

    const runJson = join(work, "run.json");
    const serial = steps.map((s) =>
      s.kind === "evidence" ? { ...s, content: undefined, contentFile: `evidence/${s.path}` } : s,
    );
    writeFileSync(
      runJson,
      JSON.stringify({
        runId,
        taskId,
        arm: "myco-gate",
        simulated: true,
        steps: serial,
        ledger: { attemptsFile: "attempts.jsonl", head: ledger.head, trialKey: runId },
      }),
    );

    // 4. Export with the CLI.
    const bundlePath = join(work, "bundle.json");
    const exp = cli(["export", runJson, "--out", bundlePath]);
    expect(exp.out).toContain('"ok":true');
    expect(exp.code).toBe(0);
    const text = readFileSync(bundlePath, "utf8");
    expect(text).not.toContain(work);
    expect(text).not.toContain("/home/myco");
    expect(text).not.toContain(tmpdir());
    const bundle = JSON.parse(text) as ProofBundle;
    expect(bundle.run.simulated).toBe(true);
    expect(bundle.records.filter((r) => r.kind === "verdict")).toHaveLength(1);

    // 5. Verify, with evidence recomputed from the run dir and the heads checked out of band.
    const ver = cli([
      "verify",
      bundlePath,
      "--evidence-dir",
      evidenceRoot,
      "--expect-head",
      bundle.head.headSha256,
      "--expect-ledger-head",
      ledger.head.headSha256,
    ]);
    expect(ver.code).toBe(0);
    expect(JSON.parse(ver.out)).toMatchObject({
      ok: true,
      simulated: true,
      evidenceDigestOnly: [],
    });

    // 6. Report.
    const reportPath = join(work, "report.html");
    expect(cli(["report", bundlePath, "--out", reportPath]).code).toBe(0);
    const html = readFileSync(reportPath, "utf8");
    expect(html).toContain("REFUTED");
    expect(html).toContain("SIMULATED RUN");
    expect(html).not.toContain(work);

    // 7. Tamper: flip the verdict in place; verify and report both refuse (exit 1).
    const tampered = join(work, "tampered.json");
    writeFileSync(tampered, text.replace('"verdict": "refuted"', '"verdict": "verified"'));
    expect(cli(["verify", tampered]).code).toBe(1);
    const tamperedReport = join(work, "tampered.html");
    expect(cli(["report", tampered, "--out", tamperedReport]).code).toBe(1);
    // Truncate: drop the last record.
    const cut = JSON.parse(text) as { records: unknown[] };
    cut.records.pop();
    writeFileSync(tampered, JSON.stringify(cut));
    expect(JSON.parse(cli(["verify", tampered]).out).errors[0].code).toBe("PROOF_TRUNCATED");
    // Swap the persisted bytes after the fact: the evidence-dir recompute refuses.
    writeFileSync(storeFile, '{"items":[]}');
    expect(cli(["verify", bundlePath, "--evidence-dir", evidenceRoot]).code).toBe(1);
  }, 60_000);

  it("usage errors exit 2", () => {
    expect(cli([]).code).toBe(2);
    expect(cli(["verify"]).code).toBe(2);
    expect(cli(["verify", "x.json", "--bogus", "1"]).code).toBe(2);
    expect(cli(["export", "nope.json", "--out", "y"]).code).toBe(2);
  });
});
