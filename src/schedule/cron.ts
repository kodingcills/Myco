/**
 * Track S: a small, dependency-free 5-field cron matcher, evaluated in UTC.
 *
 * Fields: minute (0-59), hour (0-23), day of month (1-31), month (1-12), day of week (0-6,
 * 0 = Sunday; 7 is accepted as Sunday). Each field is `*`, a number, a range `a-b`, a step
 * `*\/n` or `a-b/n`, or a comma list of those. Names (`MON`, `JAN`) and the non-standard
 * `L`/`W`/`#`/`?` forms are refused, not guessed at: a schedule the parser does not fully
 * understand must not run at a time the operator did not mean.
 *
 * Day-of-month and day-of-week follow the classic Vixie rule: when both are restricted
 * (neither is `*`), a time matches if EITHER matches.
 */

export interface CronSpec {
  readonly source: string;
  readonly minutes: ReadonlySet<number>;
  readonly hours: ReadonlySet<number>;
  readonly days: ReadonlySet<number>;
  readonly months: ReadonlySet<number>;
  readonly weekdays: ReadonlySet<number>;
  readonly daysRestricted: boolean;
  readonly weekdaysRestricted: boolean;
}

export class CronError extends Error {
  override name = "CronError";
}

const MINUTE_MS = 60_000;

function parseField(text: string, min: number, max: number, label: string): Set<number> {
  const out = new Set<number>();
  if (text === "") throw new CronError(`cron ${label}: empty field`);
  for (const part of text.split(",")) {
    const m = /^(\*|(\d{1,2})(?:-(\d{1,2}))?)(?:\/(\d{1,2}))?$/.exec(part);
    if (!m) throw new CronError(`cron ${label}: unsupported term`);
    const [, whole, a, b, s] = m;
    let lo = min;
    let hi = max;
    if (whole !== "*") {
      lo = Number(a);
      hi = b === undefined ? (s === undefined ? lo : max) : Number(b);
    }
    const step = s === undefined ? 1 : Number(s);
    if (step < 1) throw new CronError(`cron ${label}: step must be at least 1`);
    if (lo < min || hi > max || lo > hi) throw new CronError(`cron ${label}: out of range`);
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

export function parseCron(source: string): CronSpec {
  if (typeof source !== "string") throw new CronError("cron: not a string");
  const fields = source.trim().split(/\s+/);
  if (fields.length !== 5) throw new CronError("cron: expected 5 fields");
  const [mi, ho, dom, mo, dow] = fields as [string, string, string, string, string];
  const weekdays = parseField(dow, 0, 7, "day-of-week");
  if (weekdays.has(7)) {
    weekdays.delete(7);
    weekdays.add(0);
  }
  return {
    source,
    minutes: parseField(mi, 0, 59, "minute"),
    hours: parseField(ho, 0, 23, "hour"),
    days: parseField(dom, 1, 31, "day-of-month"),
    months: parseField(mo, 1, 12, "month"),
    weekdays,
    daysRestricted: dom !== "*",
    weekdaysRestricted: dow !== "*",
  };
}

/** Whether the UTC minute containing `ms` matches. */
export function cronMatches(spec: CronSpec, ms: number): boolean {
  const d = new Date(ms);
  if (!spec.minutes.has(d.getUTCMinutes())) return false;
  if (!spec.hours.has(d.getUTCHours())) return false;
  if (!spec.months.has(d.getUTCMonth() + 1)) return false;
  const dayOk = spec.days.has(d.getUTCDate());
  const wdOk = spec.weekdays.has(d.getUTCDay());
  if (spec.daysRestricted && spec.weekdaysRestricted) return dayOk || wdOk;
  return dayOk && wdOk;
}

/**
 * The matching slot starts (whole UTC minutes, ms) in the half-open window `(afterMs,
 * uptoMs]`, oldest first, plus how many there were in total. At most `limit` slots are
 * returned (the newest ones); `total` still counts every slot, so a week of downtime is
 * reported as one summary rather than ten thousand rows. The scan is bounded by
 * `maxScanMinutes` (default 366 days) so a corrupt cursor cannot spin the service.
 */
export function cronSlotsBetween(
  spec: CronSpec,
  afterMs: number,
  uptoMs: number,
  limit = 64,
  maxScanMinutes = 366 * 24 * 60,
): { slots: number[]; total: number; truncatedScan: boolean } {
  const slots: number[] = [];
  let total = 0;
  let t = Math.floor(afterMs / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
  let scanned = 0;
  const lastSlot = Math.floor(uptoMs / MINUTE_MS) * MINUTE_MS;
  let truncatedScan = false;
  if (lastSlot - t > maxScanMinutes * MINUTE_MS) {
    // Only the most recent window is scanned; older slots are counted as unknown-missed.
    t = lastSlot - maxScanMinutes * MINUTE_MS;
    truncatedScan = true;
  }
  for (; t <= lastSlot && scanned <= maxScanMinutes; t += MINUTE_MS, scanned++) {
    if (!cronMatches(spec, t)) continue;
    total++;
    slots.push(t);
    if (slots.length > limit) slots.shift();
  }
  return { slots, total, truncatedScan };
}
