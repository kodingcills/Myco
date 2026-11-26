/**
 * Track S: the local scheduler service — a schedule file wired to a scheduler, a tick loop,
 * the loopback webhook (when configured) and a notifier.
 *
 * Secrets: the ledger's MAC key and the webhook secret are named in the schedule file by
 * secrets-file PATH and variable NAME only. The ledger key is read here, once, into memory
 * (`readSecretFromFile`); the webhook secret is read per request by the webhook itself.
 * Neither is ever written to a log, a row, a notification or an error message.
 */

import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { readSecretFromFile } from "../baseline/secret-file.ts";
import type { ScheduleFile } from "./config.ts";
import {
  type Clock,
  type Notifier,
  type RunNotification,
  type RunPolicy,
  systemClock,
} from "./runtime.ts";
import { type RunExecutor, type RunRecord, Scheduler, type Submission } from "./scheduler.ts";
import { ScheduleState } from "./state.ts";
import { startWebhookServer, type WebhookServer } from "./webhook.ts";

export function fileNotifier(path: string): Notifier {
  return {
    notify(n: RunNotification) {
      appendFileSync(path, `${JSON.stringify(n)}\n`, { mode: 0o600 });
    },
  };
}

export const stderrNotifier: Notifier = {
  notify(n: RunNotification) {
    process.stderr.write(`myco-schedule: ${JSON.stringify(n)}\n`);
  },
};

/** The ledger MAC key: 64 hex characters in the operator's secrets file. */
export function loadLedgerKey(ref: ScheduleFile["ledgerKey"]): Uint8Array {
  const value = readSecretFromFile(ref.file, ref.name);
  if (!/^[0-9a-fA-F]{64}$/.test(value))
    throw new Error(`${ref.name} in ${ref.file} must be 64 hex characters (32 bytes)`);
  return Buffer.from(value, "hex");
}

export const LEDGER_FILE = "ledger.jsonl";

export interface ServiceOptions {
  readonly config: ScheduleFile;
  readonly executor: RunExecutor;
  readonly policies: readonly RunPolicy[];
  readonly clock?: Clock;
  readonly notifier?: Notifier;
  readonly onDiagnostic?: (code: string) => void;
  /** Override the configured webhook port (tests pass 0 for an ephemeral port). */
  readonly webhookPort?: number;
  /** Start the periodic tick loop (default true). Tests drive `tickNow` instead. */
  readonly loop?: boolean;
}

export interface ScheduleService {
  readonly scheduler: Scheduler;
  readonly state: ScheduleState;
  readonly ledgerPath: string;
  readonly ledgerId: string;
  readonly webhook?: WebhookServer;
  tickNow(): Submission[];
  /** Rows written since start, in completion order. */
  readonly records: RunRecord[];
  /** Wait for every submitted run to finish and its row to be written. */
  drain(): Promise<void>;
  stop(): Promise<void>;
}

export async function startScheduleService(o: ServiceOptions): Promise<ScheduleService> {
  const { config } = o;
  const clock = o.clock ?? systemClock;
  const key = loadLedgerKey(config.ledgerKey);
  const state = new ScheduleState(config.stateDir);
  // One service per state dir: claims are checked in memory, so a second service could run
  // a trigger key the first already claimed.
  state.acquireLock();
  try {
    return await startLocked(o, clock, key, state);
  } catch (e) {
    state.releaseLock();
    throw e;
  }
}

async function startLocked(
  o: ServiceOptions,
  clock: Clock,
  key: Uint8Array,
  state: ScheduleState,
): Promise<ScheduleService> {
  const { config } = o;
  const ledgerPath = join(config.stateDir, LEDGER_FILE);
  const ledgerId = "myco.schedule.ledger/v1";
  const notifier =
    o.notifier ??
    (config.notifier.kind === "file" ? fileNotifier(config.notifier.path) : stderrNotifier);
  const scheduler = new Scheduler({
    schedules: config.schedules,
    state,
    clock,
    executor: o.executor,
    policies: o.policies,
    notifier,
    ledger: { path: ledgerPath, key, ledgerId },
    ...(o.onDiagnostic ? { onDiagnostic: o.onDiagnostic } : {}),
    graceMs: Math.max(120_000, config.tickSeconds * 2000),
  });
  const pending = new Set<Promise<unknown>>();
  const records: RunRecord[] = [];
  const track = (s: Submission) => {
    const p = s.done.then((r) => {
      records.push(r);
    });
    pending.add(p);
    void p.finally(() => pending.delete(p));
  };
  const tickNow = () => {
    const subs = scheduler.tick();
    for (const s of subs) track(s);
    return subs;
  };
  let webhook: WebhookServer | undefined;
  if (config.webhook) {
    webhook = await startWebhookServer({
      scheduler,
      secret: config.webhook.secret,
      port: o.webhookPort ?? config.webhook.port,
      onSubmission: track,
      ...(o.onDiagnostic ? { onDiagnostic: o.onDiagnostic } : {}),
    });
  }
  let cancel: () => void = () => {};
  let stopped = false;
  const loop = () => {
    if (stopped) return;
    try {
      // `myco-schedule kill` writes KILLED into the pause file: abort what is in flight.
      if (state.pauseReason() === "KILLED") scheduler.kill();
      tickNow();
    } catch {
      o.onDiagnostic?.("TICK_FAILED");
    }
    cancel = clock.setTimer(config.tickSeconds * 1000, loop);
  };
  if (o.loop !== false) loop();
  const drain = async () => {
    while (pending.size > 0) await Promise.all([...pending]);
  };
  return {
    scheduler,
    state,
    ledgerPath,
    ledgerId,
    ...(webhook ? { webhook } : {}),
    tickNow,
    records,
    drain,
    async stop() {
      stopped = true;
      cancel();
      await webhook?.close();
      await drain();
      // Rows are written, but a timed-out or killed run's executor may still be running: keep
      // the lock (and so the concurrency budget) until every executor has settled.
      await scheduler.idle();
      state.releaseLock();
    },
  };
}
