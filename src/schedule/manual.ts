/**
 * Track S: the manual trigger. `myco-schedule trigger` writes one request file into
 * `<stateDir>/manual/` (atomically: a dotfile, then a rename); the service picks it up on its
 * next tick, submits it, and deletes it. The file is `<scheduleId>.<key>.json`; the key is
 * the idempotency key (per schedule), so re-running the command with the same `--key` for
 * the same schedule cannot run twice, and the same key for two schedules is two requests.
 *
 * A request carries a schedule id and nothing else. A malformed or oversized file is
 * deleted with a diagnostic code and never run.
 */

import { lstatSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SCHEDULE_ID } from "./config.ts";

export const MANUAL_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_REQUEST_BYTES = 4096;

export function writeManualRequest(spoolDir: string, scheduleId: string, key: string): string {
  if (!SCHEDULE_ID.test(scheduleId)) throw new Error("manual trigger: invalid schedule id");
  if (!MANUAL_KEY.test(key)) throw new Error("manual trigger: invalid key");
  // Named `<scheduleId>.<key>.json`: the same key for two schedules is two requests, not
  // one file overwriting the other. A schedule id has no `.`, so the split is unambiguous.
  const final = join(spoolDir, `${scheduleId}.${key}.json`);
  const tmp = join(spoolDir, `.tmp-${scheduleId}.${key}.json`);
  writeFileSync(tmp, JSON.stringify({ scheduleId }), { mode: 0o600 });
  renameSync(tmp, final);
  return final;
}

/**
 * Submit each spooled request. `submit` returns undefined to leave a request queued (its
 * schedule has no free slot); anything else consumes it.
 */
export function drainSpool<T>(
  spoolDir: string,
  submit: (scheduleId: string, key: string) => T | undefined,
  diag: (code: string) => void,
): T[] {
  const out: T[] = [];
  let names: string[];
  try {
    names = readdirSync(spoolDir)
      .filter((n) => !n.startsWith(".") && n.endsWith(".json"))
      .sort();
  } catch {
    diag("MANUAL_SPOOL_UNREADABLE");
    return out;
  }
  for (const name of names) {
    const path = join(spoolDir, name);
    const stem = name.slice(0, -".json".length);
    const dot = stem.indexOf(".");
    const nameSchedule = dot < 0 ? "" : stem.slice(0, dot);
    const key = dot < 0 ? "" : stem.slice(dot + 1);
    let scheduleId: unknown;
    try {
      const st = lstatSync(path);
      if (!st.isFile() || st.size > MAX_REQUEST_BYTES || !MANUAL_KEY.test(key))
        throw new Error("bad");
      const v = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      if (typeof v !== "object" || v === null || Object.keys(v).join() !== "scheduleId")
        throw new Error("bad");
      scheduleId = v.scheduleId;
      if (
        typeof scheduleId !== "string" ||
        !SCHEDULE_ID.test(scheduleId) ||
        scheduleId !== nameSchedule
      )
        throw new Error("bad");
    } catch {
      diag("MANUAL_REQUEST_INVALID");
      rmSync(path, { force: true });
      continue;
    }
    const sub = submit(scheduleId as string, key);
    if (sub === undefined) continue;
    out.push(sub);
    rmSync(path, { force: true });
  }
  return out;
}
