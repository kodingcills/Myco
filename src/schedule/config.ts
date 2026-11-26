/**
 * Track S: the schedule file (`myco.schedule/v1`), parsed strictly.
 *
 * Fail closed: any unknown key, wrong type or out-of-range number refuses the WHOLE file, so
 * a typo cannot silently drop a budget or a policy. Error messages name the JSON path and
 * the rule, never the offending value: a schedule file that carries a pasted secret must not
 * echo it into a log when it is refused.
 *
 * No secrets in schedule files (acceptance bar 4). The file names secrets files by PATH and
 * the variable inside them by NAME (`secretsFile` + `secretName`, `keyFile` + `keyName`),
 * read at the point of use by `readSecretFromFile` (src/baseline/secret-file.ts). On top of
 * the strict schema, every string value is screened for key-shaped text (`looksLikeSecret`)
 * and the file is refused if one is found.
 */

import { type CronSpec, parseCron } from "./cron.ts";

export const SCHEDULE_FILE_VERSION = "myco.schedule/v1";

export type TriggerSource = "cron" | "inbox" | "webhook" | "manual";
export type MissedRunPolicy = "skip" | "run-latest";

export interface ScheduleBudget {
  /** Admitted triggers per UTC day (runs started or denied by policy after admission). */
  readonly runsPerDay: number;
  /** Wall-time limit of one run, seconds. A run over it is aborted and recorded `timeout`. */
  readonly wallTimeS: number;
  /** Runs of this schedule in flight at once. */
  readonly concurrency: number;
}

export interface ScheduleSpec {
  readonly id: string;
  readonly taskId: string;
  readonly cron?: CronSpec;
  readonly events: {
    readonly inbox?: { readonly dir: string };
    readonly webhook: boolean;
    readonly manual: boolean;
  };
  readonly budget: ScheduleBudget;
  readonly missed: MissedRunPolicy;
}

export interface SecretRef {
  /** Path of a `NAME=value` secrets file. A path is safe to log; its contents are not. */
  readonly file: string;
  readonly name: string;
}

export interface ScheduleFile {
  readonly version: typeof SCHEDULE_FILE_VERSION;
  readonly stateDir: string;
  readonly ledgerKey: SecretRef;
  readonly tickSeconds: number;
  readonly webhook?: { readonly port: number; readonly secret: SecretRef };
  readonly notifier: { readonly kind: "stderr" } | { readonly kind: "file"; readonly path: string };
  readonly schedules: readonly ScheduleSpec[];
}

export class ScheduleFileError extends Error {
  override name = "ScheduleFileError";
}

export const SCHEDULE_ID = /^[a-z0-9][a-z0-9-]{0,47}$/;
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SECRET_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Key-shaped text: known vendor prefixes, PEM blocks, or a long unbroken token with letters
 * and digits (a path separator or a space makes it not a token). Deliberately broad: a false
 * refusal costs the operator a rename; a false pass puts a key on disk in plain text.
 */
export function looksLikeSecret(value: string): boolean {
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(value)) return true;
  if (
    /\b(sk-ant-|sk-|ghp_|gho_|ghs_|github_pat_|xox[abposr]-|AKIA|ASIA|AIza)[A-Za-z0-9_-]{8,}/.test(
      value,
    )
  )
    return true;
  for (const token of value.split(/[\s/\\:,;"'`]+/)) {
    if (UUID.test(token)) continue;
    if (
      token.length >= 32 &&
      /[A-Za-z]/.test(token) &&
      /\d/.test(token) &&
      /^[A-Za-z0-9+_=.-]+$/.test(token)
    )
      return true;
  }
  return false;
}

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function fail(path: string, rule: string): never {
  throw new ScheduleFileError(`schedule file ${path}: ${rule}`);
}

function keys(o: Obj, path: string, allowed: readonly string[], required: readonly string[]) {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) fail(`${path}.${k}`, "unknown key");
  for (const k of required) if (!(k in o)) fail(`${path}.${k}`, "required");
}

function str(v: unknown, path: string, re?: RegExp): string {
  if (typeof v !== "string" || v === "") fail(path, "must be a non-empty string");
  if (re && !re.test(v)) fail(path, "has an invalid form");
  return v;
}

function int(v: unknown, path: string, min: number, max: number): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max)
    fail(path, `must be an integer in [${min}, ${max}]`);
  return v;
}

function absPath(v: unknown, path: string): string {
  const s = str(v, path);
  if (!s.startsWith("/")) fail(path, "must be an absolute path");
  if (s.split("/").includes("..")) fail(path, "must not contain '..'");
  return s;
}

function secretRef(v: unknown, path: string, fileKey: string, nameKey: string): SecretRef {
  if (!isObj(v)) fail(path, "must be an object");
  keys(v, path, [fileKey, nameKey], [fileKey, nameKey]);
  return {
    file: absPath(v[fileKey], `${path}.${fileKey}`),
    name: str(v[nameKey], `${path}.${nameKey}`, SECRET_NAME),
  };
}

function screen(v: unknown, path: string): void {
  if (typeof v === "string") {
    if (looksLikeSecret(v))
      fail(path, "looks like a secret value; reference a secrets file instead");
  } else if (Array.isArray(v)) {
    v.forEach((x, i) => {
      screen(x, `${path}[${i}]`);
    });
  } else if (isObj(v)) {
    for (const [k, x] of Object.entries(v)) {
      if (looksLikeSecret(k)) fail(path, "has a key that looks like a secret value");
      screen(x, `${path}.${k}`);
    }
  }
}

function schedule(v: unknown, path: string): ScheduleSpec {
  if (!isObj(v)) fail(path, "must be an object");
  keys(v, path, ["id", "taskId", "cron", "events", "budget", "missed"], ["id", "taskId", "budget"]);
  const id = str(v.id, `${path}.id`, SCHEDULE_ID);
  const taskId = str(v.taskId, `${path}.taskId`, TASK_ID);
  let cron: CronSpec | undefined;
  if (v.cron !== undefined) {
    try {
      cron = parseCron(str(v.cron, `${path}.cron`));
    } catch (e) {
      if (e instanceof ScheduleFileError) throw e;
      fail(`${path}.cron`, "is not a supported 5-field cron expression");
    }
  }
  const ev = v.events ?? {};
  if (!isObj(ev)) fail(`${path}.events`, "must be an object");
  keys(ev, `${path}.events`, ["inbox", "webhook", "manual"], []);
  let inbox: { dir: string } | undefined;
  if (ev.inbox !== undefined) {
    if (!isObj(ev.inbox)) fail(`${path}.events.inbox`, "must be an object");
    keys(ev.inbox, `${path}.events.inbox`, ["dir"], ["dir"]);
    inbox = { dir: absPath(ev.inbox.dir, `${path}.events.inbox.dir`) };
  }
  for (const k of ["webhook", "manual"] as const)
    if (ev[k] !== undefined && typeof ev[k] !== "boolean")
      fail(`${path}.events.${k}`, "must be a boolean");
  const b = v.budget;
  if (!isObj(b)) fail(`${path}.budget`, "must be an object");
  keys(
    b,
    `${path}.budget`,
    ["runsPerDay", "wallTimeS", "concurrency"],
    ["runsPerDay", "wallTimeS", "concurrency"],
  );
  const missed = v.missed ?? "skip";
  if (missed !== "skip" && missed !== "run-latest")
    fail(`${path}.missed`, "must be 'skip' or 'run-latest'");
  const events = {
    ...(inbox ? { inbox } : {}),
    webhook: ev.webhook === true,
    manual: ev.manual === true,
  };
  if (!cron && !events.inbox && !events.webhook && !events.manual)
    fail(path, "has no trigger (cron, inbox, webhook or manual)");
  return {
    id,
    taskId,
    ...(cron ? { cron } : {}),
    events,
    budget: {
      runsPerDay: int(b.runsPerDay, `${path}.budget.runsPerDay`, 1, 1440),
      wallTimeS: int(b.wallTimeS, `${path}.budget.wallTimeS`, 1, 24 * 3600),
      concurrency: int(b.concurrency, `${path}.budget.concurrency`, 1, 16),
    },
    missed,
  };
}

/** Parse and validate a schedule file's JSON text. Throws `ScheduleFileError` (path + rule only). */
export function parseScheduleFile(text: string): ScheduleFile {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    fail("$", "is not valid JSON");
  }
  screen(raw, "$");
  if (!isObj(raw)) fail("$", "must be an object");
  keys(
    raw,
    "$",
    ["version", "stateDir", "ledgerKey", "tickSeconds", "webhook", "notifier", "schedules"],
    ["version", "stateDir", "ledgerKey", "schedules"],
  );
  if (raw.version !== SCHEDULE_FILE_VERSION)
    fail("$.version", `must be "${SCHEDULE_FILE_VERSION}"`);
  let webhook: ScheduleFile["webhook"];
  if (raw.webhook !== undefined) {
    const w = raw.webhook;
    if (!isObj(w)) fail("$.webhook", "must be an object");
    keys(
      w,
      "$.webhook",
      ["port", "secretsFile", "secretName"],
      ["port", "secretsFile", "secretName"],
    );
    webhook = {
      port: int(w.port, "$.webhook.port", 1024, 65535),
      secret: secretRef(
        { secretsFile: w.secretsFile, secretName: w.secretName },
        "$.webhook",
        "secretsFile",
        "secretName",
      ),
    };
  }
  let notifier: ScheduleFile["notifier"] = { kind: "stderr" };
  if (raw.notifier !== undefined) {
    const n = raw.notifier;
    if (!isObj(n)) fail("$.notifier", "must be an object");
    if (n.kind === "stderr") {
      keys(n, "$.notifier", ["kind"], ["kind"]);
    } else if (n.kind === "file") {
      keys(n, "$.notifier", ["kind", "path"], ["kind", "path"]);
      notifier = { kind: "file", path: absPath(n.path, "$.notifier.path") };
    } else fail("$.notifier.kind", "must be 'stderr' or 'file'");
  }
  if (!Array.isArray(raw.schedules) || raw.schedules.length === 0)
    fail("$.schedules", "must be a non-empty array");
  const schedules = raw.schedules.map((s, i) => schedule(s, `$.schedules[${i}]`));
  const ids = new Set<string>();
  for (const s of schedules) {
    if (ids.has(s.id)) fail("$.schedules", "has a duplicate id");
    ids.add(s.id);
    if (s.events.webhook && !webhook) fail("$.webhook", "required when a schedule enables webhook");
  }
  return {
    version: SCHEDULE_FILE_VERSION,
    stateDir: absPath(raw.stateDir, "$.stateDir"),
    ledgerKey: secretRef(raw.ledgerKey, "$.ledgerKey", "keyFile", "keyName"),
    tickSeconds:
      raw.tickSeconds === undefined ? 30 : int(raw.tickSeconds, "$.tickSeconds", 1, 3600),
    ...(webhook ? { webhook } : {}),
    notifier,
    schedules,
  };
}
