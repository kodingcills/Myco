/**
 * Secret redaction for every string that leaves process memory (ledger, raw JSON, errors, logs).
 *
 * Order matters: exact registered secrets first, then known key shapes, then ids are shortened,
 * then any remaining 20+ character token-looking run is replaced. Persisted diagnostics must pass
 * through `scrub`/`scrubDeep`; nothing else may write to disk.
 */

const registered = new Set<string>();

/** Register a live secret so its exact value is removed wherever it appears. */
export function registerSecret(value: string): void {
  if (value.length >= 8) registered.add(value);
}

export function clearRegisteredSecrets(): void {
  registered.clear();
}

const SHAPES: ReadonlyArray<readonly [RegExp, string]> = [
  [/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]"],
  [/authorization["']?\s*[:=]\s*["']?[^\s"',}]+/gi, "authorization: [REDACTED]"],
  [/sapi_[A-Za-z0-9_-]*/g, "[REDACTED:sapi]"],
  [/sk-ant-[A-Za-z0-9_-]*/g, "[REDACTED:sk-ant]"],
  [/\bsk[-_][A-Za-z0-9_-]{8,}/g, "[REDACTED:sk]"],
  [
    /\b(?:api[-_]?key|access[-_]?token|id[-_]?token|secret|password)["']?\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{8,}/gi,
    "[REDACTED:credential]",
  ],
];

/** Vendor ids are kept recognisable but never carry 20+ token characters. */
const ID_PREFIXED =
  /\b(turn|cs|learn|judgement|ap|tc|msg|m|ses|file|f)_([A-Za-z0-9]{4})[A-Za-z0-9]{4,}/g;
const FREE_MACHINE = /\bfree-[A-Za-z0-9]{8,}/g;
const LONG_RUN = /[A-Za-z0-9_-]{20,}/g;

function escapeForRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function scrub(input: string): string {
  let out = input;
  for (const secret of registered) {
    out = out.replace(new RegExp(escapeForRegExp(secret), "g"), "[REDACTED]");
  }
  for (const [pattern, replacement] of SHAPES) out = out.replace(pattern, replacement);
  out = out.replace(ID_PREFIXED, "$1_$2…");
  out = out.replace(FREE_MACHINE, "free-[account]");
  out = out.replace(LONG_RUN, (run) =>
    /[0-9]/.test(run) && /[A-Za-z]/.test(run) ? `[REDACTED:long-token:${run.length}]` : run,
  );
  return out;
}

export function scrubDeep<T>(value: T): T {
  if (typeof value === "string") return scrub(value) as T;
  if (Array.isArray(value)) return value.map((item) => scrubDeep(item)) as T;
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[scrub(key)] = scrubDeep(item);
    return out as T;
  }
  return value;
}

/** Patterns a committed file must never contain; used by the repo-wide guard test and pre-commit grep. */
export const FORBIDDEN_IN_COMMITTED_FILES: ReadonlyArray<readonly [string, RegExp]> = [
  ["sapi_ key", /sapi_[A-Za-z0-9_-]{8,}/],
  ["sk-ant key", /sk-ant-[A-Za-z0-9_-]{8,}/],
  ["sk_ key", /\bsk_[A-Za-z0-9_-]{8,}/],
  ["bearer token", /Bearer\s+[A-Za-z0-9._~+/=-]{16,}/],
];
