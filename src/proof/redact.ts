/**
 * Track Q (replayable proof): redaction for proof bundles and reports.
 *
 * A proof bundle is meant to be shared, so it must never carry a secret, an absolute host
 * path, a username or a vault key. Two layers, both fail closed:
 *  1. `redactText` rewrites every string the exporter puts in a bundle: registered literal
 *     values first (secrets, vault keys, host paths, usernames), then generic shapes
 *     (absolute paths, key-shaped tokens).
 *  2. `findLeaks` scans the final serialized bundle (and the HTML report) with the same
 *     matchers. Anything left is a refusal: the exporter throws, the verifier refuses, the
 *     report is not written. A redaction bug therefore stops the share; it does not leak.
 *
 * Screenshots and frames are never inlined: the watch view has no merged redaction rules
 * for pixels, so a frame can only appear as a digest (see `bundle.ts`).
 */

export interface RedactionContext {
  /** Literal secret values (API keys, tokens): removed wherever they appear. */
  readonly secrets: readonly string[];
  /** Vault key names or key material (`src/integrity/vault.ts`): removed wherever they appear. */
  readonly vaultKeys: readonly string[];
  /** Absolute host directories (home, temp, checkout): removed wherever they appear. */
  readonly hostPaths: readonly string[];
  /** Account names: removed as whole words. */
  readonly usernames: readonly string[];
}

export const EMPTY_REDACTION: RedactionContext = {
  secrets: [],
  vaultKeys: [],
  hostPaths: [],
  usernames: [],
};

/** Values shorter than this are not registered as literals (they would mangle ordinary text). */
export const MIN_LITERAL = 3;

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Generic secret shapes. Placeholders below never match these. */
const SECRET_SHAPES: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\bsk-ant-[A-Za-z0-9_-]{4,}/g,
  /\bsk[-_][A-Za-z0-9_-]{8,}/g,
  /\bsapi_[A-Za-z0-9_-]{4,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{8,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{8,}/g,
  /\bAKIA[0-9A-Z]{12,}/g,
  /\bxox[abpr]-[A-Za-z0-9-]{8,}/g,
  /\b(?:api[-_]?key|access[-_]?token|auth[-_]?token|secret|password|passwd)["']?\s*[:=]\s*["']?[^\s"',}]{4,}/gi,
];

/**
 * Absolute host paths: a POSIX path of two or more segments that starts at a boundary, or a
 * Windows drive path. A URL's `//host/...` never matches (the first segment would be empty),
 * and relative paths (`evidence/run/x.json`) and media types (`text/csv`) never start with `/`.
 */
const POSIX_ABS = /(^|[\s"'`=(,:;[{<>|])(\/(?:[A-Za-z0-9._@~+-]+\/)+[A-Za-z0-9._@~+-]*)/g;
const WINDOWS_ABS = /\b[A-Za-z]:[\\/](?:[^\s"'`<>|\\/]+[\\/]?)+/g;
/** `file:` URLs name host paths too. */
const FILE_URL = /\bfile:\/\/[^\s"'`<>]*/gi;

export const PLACEHOLDER = {
  secret: "[redacted:secret]",
  vaultKey: "[redacted:vault-key]",
  hostPath: "[redacted:host-path]",
  username: "[redacted:user]",
} as const;

function literals(ctx: RedactionContext): Array<readonly [string, string]> {
  const out: Array<readonly [string, string]> = [];
  const add = (values: readonly string[], placeholder: string) => {
    for (const v of values) if (v.length >= MIN_LITERAL) out.push([v, placeholder]);
  };
  add(ctx.secrets, PLACEHOLDER.secret);
  add(ctx.vaultKeys, PLACEHOLDER.vaultKey);
  add(ctx.hostPaths, PLACEHOLDER.hostPath);
  // Longest first, so a path that contains another is removed whole.
  return out.sort((a, b) => b[0].length - a[0].length);
}

function usernameRes(ctx: RedactionContext): RegExp[] {
  return ctx.usernames
    .filter((u) => u.length >= MIN_LITERAL)
    .map((u) => new RegExp(`(?<![A-Za-z0-9_])${escapeRe(u)}(?![A-Za-z0-9_])`, "g"));
}

/** Rewrite one string so it carries no registered value and no generic secret or host path. */
export function redactText(input: string, ctx: RedactionContext): string {
  let out = input;
  for (const [value, placeholder] of literals(ctx)) out = out.split(value).join(placeholder);
  for (const re of SECRET_SHAPES) out = out.replace(re, PLACEHOLDER.secret);
  out = out.replace(FILE_URL, PLACEHOLDER.hostPath);
  out = out.replace(WINDOWS_ABS, PLACEHOLDER.hostPath);
  out = out.replace(POSIX_ABS, (_m, pre: string) => `${pre}${PLACEHOLDER.hostPath}`);
  for (const re of usernameRes(ctx)) out = out.replace(re, PLACEHOLDER.username);
  return out;
}

/** Deep-redact every string (keys included) of a JSON-like value. */
export function redactDeep<T>(value: T, ctx: RedactionContext): T {
  if (typeof value === "string") return redactText(value, ctx) as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, ctx)) as T;
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[redactText(k, ctx)] = redactDeep(v, ctx);
    return out as T;
  }
  return value;
}

export interface Leak {
  readonly kind: "secret" | "vault-key" | "host-path" | "username";
  /** Never the leaked value itself: only where and what kind. */
  readonly at: number;
}

/**
 * Scan serialized text for anything redaction should have removed. Returns positions and
 * kinds only, never the matched text, so a leak report cannot itself leak.
 */
export function findLeaks(text: string, ctx: RedactionContext = EMPTY_REDACTION): Leak[] {
  const leaks: Leak[] = [];
  const scan = (re: RegExp, kind: Leak["kind"]) => {
    const r = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
    for (const m of text.matchAll(r)) leaks.push({ kind, at: m.index ?? 0 });
  };
  for (const v of ctx.secrets) if (v.length >= MIN_LITERAL) scan(new RegExp(escapeRe(v)), "secret");
  for (const v of ctx.vaultKeys)
    if (v.length >= MIN_LITERAL) scan(new RegExp(escapeRe(v)), "vault-key");
  for (const v of ctx.hostPaths)
    if (v.length >= MIN_LITERAL) scan(new RegExp(escapeRe(v)), "host-path");
  for (const re of usernameRes(ctx)) scan(re, "username");
  for (const re of SECRET_SHAPES) scan(re, "secret");
  scan(FILE_URL, "host-path");
  scan(WINDOWS_ABS, "host-path");
  // JSON escapes `/` as-is but a serialized string is quoted: scan the raw text and the
  // JSON-unescaped form (a `\"` before a path would otherwise hide the boundary).
  scan(POSIX_ABS, "host-path");
  const unescaped = text.replace(/\\(["\\/])/g, "$1").replace(/\\n/g, "\n");
  if (unescaped !== text) {
    for (const m of unescaped.matchAll(POSIX_ABS))
      leaks.push({ kind: "host-path", at: m.index ?? 0 });
  }
  return leaks;
}
