/**
 * Track S, $0 end to end: a schedule FILE on disk -> the local service (fake clock, its own
 * tick loop) -> cron, inbox, webhook and manual triggers -> the REAL gated path
 * (`runGatedTrial`: launch audit, sealed vault, calc-record-edit oracle) with a scripted agent
 * on fc-v1 tasks -> the MAC-chained ledger and a file notifier.
 *
 * Checked: every triggered run has a row with a verdict; the ledger chain verifies; each
 * verdict agrees with the independent grader (src/benchmark/grade) on the same document; only
 * grader-passing runs are accepted; failures notify; rows are simulated and never evidence;
 * planted secrets (webhook secret, ledger key) appear in no file the service wrote.
 * No model, no VM, no network beyond 127.0.0.1.
 */
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { grade } from "../../src/benchmark/grade/grade.ts";
import { scriptedDocument } from "../../src/benchmark/r1-dryrun.ts";
import type { BenchmarkTask } from "../../src/benchmark/taskset.ts";
import { checkChainedLedger } from "../../src/integrity/ledger.ts";
import { parseScheduleFile } from "../../src/schedule/config.ts";
import { readFcV1Tasks, scriptedFcV1Executor } from "../../src/schedule/executor.ts";
import { writeManualRequest } from "../../src/schedule/manual.ts";
import { FakeClock, taskAllowListPolicy } from "../../src/schedule/runtime.ts";
import type { RunRecord } from "../../src/schedule/scheduler.ts";
import { startScheduleService } from "../../src/schedule/service.ts";
import { webhookSignature } from "../../src/schedule/webhook.ts";
import { T0, tmp } from "./helpers.ts";

const BUNDLE = resolve(import.meta.dirname, "..", "..", "benchmark", "false-completion", "fc-v1");
const TASKS = readFcV1Tasks(join(BUNDLE, "tasks.jsonl"));
const WEBHOOK_SECRET = "PLANTEDhookSecret0123456789abcdefABCDEF";
const LEDGER_KEY_HEX = "ab".repeat(16) + "cd".repeat(16); // never appears in output

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

describe("scheduled and triggered runs, end to end ($0, scripted agent, real gate)", () => {
  it("cron + inbox + webhook + manual -> gated verdicts that agree with the independent grader", {
    timeout: 60_000,
  }, async () => {
    const dir = tmp("myco-sched-e2e-");
    const inbox = join(dir, "inbox");
    mkdirSync(inbox);
    const secrets = join(dir, "secrets");
    mkdirSync(secrets, { mode: 0o700 });
    writeFileSync(
      join(secrets, "schedule.env"),
      `MYCO_SCHEDULE_LEDGER_KEY=${LEDGER_KEY_HEX}\nMYCO_WEBHOOK_SECRET=${WEBHOOK_SECRET}\n`,
      { mode: 0o600 },
    );
    const notifications = join(dir, "notifications.jsonl");
    const scheduleFile = join(dir, "schedule.json");
    writeFileSync(
      scheduleFile,
      JSON.stringify({
        version: "myco.schedule/v1",
        stateDir: join(dir, "state"),
        ledgerKey: { keyFile: join(secrets, "schedule.env"), keyName: "MYCO_SCHEDULE_LEDGER_KEY" },
        tickSeconds: 30,
        webhook: {
          port: 18787,
          secretsFile: join(secrets, "schedule.env"),
          secretName: "MYCO_WEBHOOK_SECRET",
        },
        notifier: { kind: "file", path: notifications },
        schedules: [
          {
            id: "hourly-honest",
            taskId: "fc-v1-001",
            cron: "0 * * * *",
            budget: { runsPerDay: 24, wallTimeS: 600, concurrency: 1 },
          },
          {
            id: "inbox-focus",
            taskId: "fc-v1-081",
            events: { inbox: { dir: inbox } },
            budget: { runsPerDay: 10, wallTimeS: 600, concurrency: 1 },
          },
          {
            id: "hook-unsaved",
            taskId: "fc-v1-002",
            events: { webhook: true },
            budget: { runsPerDay: 10, wallTimeS: 600, concurrency: 1 },
          },
          {
            id: "manual-killapp",
            taskId: "fc-v1-061",
            events: { manual: true },
            budget: { runsPerDay: 10, wallTimeS: 600, concurrency: 1 },
          },
          {
            id: "manual-blocked",
            taskId: "fc-v1-003",
            events: { manual: true },
            budget: { runsPerDay: 10, wallTimeS: 600, concurrency: 1 },
          },
        ],
      }),
    );
    const config = parseScheduleFile(readFileSync(scheduleFile, "utf8"));
    const docs = new Map<string, string | null>();
    const clock = new FakeClock(T0 + 30_000); // 10:00:30Z
    const diagnostics: string[] = [];
    const service = await startScheduleService({
      config,
      clock,
      webhookPort: 0,
      onDiagnostic: (c) => diagnostics.push(c),
      policies: [taskAllowListPolicy(["fc-v1-001", "fc-v1-081", "fc-v1-002", "fc-v1-061"])],
      executor: scriptedFcV1Executor({
        tasks: TASKS,
        workDir: join(dir, "work"),
        agent: async (task, req) => {
          // "hook-unsaved": the agent claims done but never saves.
          const doc = req.scheduleId === "hook-unsaved" ? null : scriptedDocument(task);
          docs.set(req.runId, doc);
          return doc;
        },
      }),
    });

    // Cron: the loop ticks every 30 s on the fake clock; 11:00Z fires once.
    clock.advance(60 * 60_000);
    await service.drain();
    // Inbox: a file arrives.
    writeFileSync(join(inbox, "export-2026-11-26.csv"), "id,name\n");
    clock.advance(30_000);
    await service.drain();
    // Webhook: a signed delivery, then its replay.
    const send = (delivery: string) =>
      fetch(`http://127.0.0.1:${service.webhook?.port}/v1/trigger/hook-unsaved`, {
        method: "POST",
        body: "{}",
        headers: {
          "x-myco-delivery": delivery,
          "x-myco-signature": webhookSignature(WEBHOOK_SECRET, "hook-unsaved", delivery, "{}"),
        },
      });
    expect((await send("gh-1")).status).toBe(202);
    expect((await send("gh-1")).status).toBe(409);
    await service.drain();
    // Manual: one allowed, one the policy blocks.
    writeManualRequest(service.state.manualDir, "manual-killapp", "op-1");
    writeManualRequest(service.state.manualDir, "manual-blocked", "op-2");
    clock.advance(30_000);
    await service.drain();
    await service.stop();

    const ran = service.records.filter((r) => r.runId !== null && r.status !== "skipped");
    const by = (id: string) => ran.filter((r) => r.scheduleId === id);
    expect(by("hourly-honest").map((r) => [r.status, r.accepted])).toEqual([["verified", true]]);
    expect(by("inbox-focus").map((r) => [r.status, r.reasonCodes])).toEqual([
      ["refuted", ["ORACLE_FAIL", "TARGET_MISMATCH", "DOCUMENT_COLLATERAL"]],
    ]);
    expect(by("hook-unsaved").map((r) => [r.status, r.reasonCodes])).toEqual([
      ["uncertain", ["STATE_MISSING"]],
    ]);
    expect(by("manual-killapp").map((r) => r.status)).toEqual(["refuted"]);
    expect(by("manual-blocked").map((r) => [r.status, r.codes])).toEqual([
      ["denied", ["POLICY_DENIED", "TASK_NOT_ALLOWED"]],
    ]);

    // Every decided verdict agrees with the independent grader on the same document.
    for (const r of ran.filter((x) => x.verdict !== null)) {
      const task = TASKS.get(r.taskId as string) as BenchmarkTask;
      const doc = docs.get(r.runId as string) ?? null;
      const g = grade({
        fixtureCsv: readFileSync(join(BUNDLE, task.fixtureFile)),
        fixtureSha256: task.fixtureSha256,
        persisted: doc === null ? null : { format: "csv", bytes: new TextEncoder().encode(doc) },
        intent: task.intent,
        columnTypes: task.columnTypes,
      });
      expect(r.accepted, r.scheduleId).toBe(g.status === "pass");
      if (g.status === "fail") expect(r.verdict).toBe("refuted");
      if (g.status === "ungradable") expect(r.verdict).toBe("uncertain");
    }

    // Ledger: the chain verifies, one row per record, all simulated, none evidence.
    const chain = checkChainedLedger(
      service.ledgerPath,
      Buffer.from(LEDGER_KEY_HEX, "hex"),
      service.ledgerId,
    );
    expect(chain.ok).toBe(true);
    expect(chain.rows).toHaveLength(service.records.length);
    for (const row of chain.rows as unknown as RunRecord[]) {
      expect(row.evidence).toBe(false);
      expect(row.simulated).toBe(true);
    }
    // The webhook replay ran nothing: its row is a quiet DUPLICATE skip.
    const hookRows = chain.rows
      .filter((r) => r.source === "webhook")
      .map((r) => `${r.status}:${r.codes}`);
    expect(hookRows.sort()).toEqual(["skipped:DUPLICATE", "uncertain:"]);

    // Failures notified (refuted, uncertain, refuted, denied); the verified run did not.
    const sent = readFileSync(notifications, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(sent.map((n) => `${n.scheduleId}:${n.status}`).sort()).toEqual([
      "hook-unsaved:uncertain",
      "inbox-focus:refuted",
      "manual-blocked:denied",
      "manual-killapp:refuted",
    ]);

    // Planted markers: no file the service wrote contains either secret.
    const written = [...walk(join(dir, "state")), notifications];
    for (const f of written) {
      const text = readFileSync(f, "latin1");
      expect(text, f).not.toContain("PLANTED");
      expect(text, f).not.toContain(LEDGER_KEY_HEX);
    }
    expect(JSON.stringify([diagnostics, service.records])).not.toContain("PLANTED");
  });
});
