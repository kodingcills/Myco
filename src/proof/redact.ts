/**
 * Track Q (replayable proof): redaction for proof bundles and reports.
 *
 * A proof bundle is meant to be shared, so it must never carry a secret, an absolute host
 * path, a username or a vault key. Two layers, both fail closed:
 *  1. `redactText` rewrites every string the exporter puts in a bundle: registered literal
 *     values first (secrets, vault keys, host paths, usernames), then generic shapes
 *     (absolute POSIX, Windows and UNC paths, `~user` homes, `file:` URLs, key-shaped
 *     tokens). A token that still leaks once decoded (JSON escapes, percent-encoding, HTML
 *     entities) is replaced whole.
 *  2. The scanners refuse anything left:
 *     - `findLeaksDeep` scans every parsed string value AND every object key of a value
 *       (the verifier runs it over the parsed bundle);
 *     - `findLeaks` scans a text (the verifier runs it over the raw bundle text, and the
 *       report renderer over the final HTML before it returns it).
 *     Each scanned string is also scanned in every decoded form (`decodedVariants`), so a
 *     path behind `\/`, `\t`, `\u002f`, `%2F` or `&#47;` is still found.
 *     Anything left is a refusal: the exporter throws, the verifier refuses, the report is
 *     not rendered. A redaction bug therefore stops the share; it does not leak.
 *
 * TO FILE: the episode writer (#542, `src/episode/clean.ts` / `validate.ts`) has its own
 * cleanliness scan. Once #542 merges, consolidate both onto one canonical scanner (with a
 * parity test over the bypass corpus in `test/proof/redaction.test.ts`).
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

/**
 * Generic secret shapes. A vendor prefix may follow anything but a letter (`\b` would let
 * `_sk-ant-...` or `1ghp_...` through); a `key=value` credential needs no boundary at all.
 * Placeholders below never match these.
 */
const SECRET_SHAPES: readonly RegExp[] = [
  // (`sk-ant-...` keys are covered by the `sk[-_]` shape below.)
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /(?<![A-Za-z])sk[-_][A-Za-z0-9_-]{8,}/g,
  /(?<![A-Za-z])sapi_[A-Za-z0-9_-]{4,}/g,
  /(?<![A-Za-z])gh[pousr]_[A-Za-z0-9]{8,}/g,
  /(?<![A-Za-z])github_pat_[A-Za-z0-9_]{8,}/g,
  /(?<![A-Za-z])AKIA[0-9A-Z]{12,}/g,
  /(?<![A-Za-z])xox[abpr]-[A-Za-z0-9-]{8,}/g,
  /(?:api[-_]?key|access[-_]?token|auth[-_]?token|secret|password|passwd)["']?\s*[:=]\s*["']?[^\s"',}]{4,}/gi,
];

/**
 * Absolute POSIX host paths: `/seg/` and more. There is NO allow-list of characters that may
 * precede the path (a fixed list is bypassed by any character left off it, e.g. a tab or
 * `*`). Instead the path is skipped only when it continues a word or a relative path: it
 * must not follow a letter, digit, one of `._~@+-`, another `/` or a `\`. So relative paths
 * (`evidence/run/x.json`), media types (`text/csv`), `myco.gate/v1` and a URL's `//host/`
 * never match, and a path after a tab, a `*` or a `:` does.
 */
const POSIX_ABS = /(?<![A-Za-z0-9._~@+\-/\\])\/(?:[A-Za-z0-9._@~+-]+\/)+[A-Za-z0-9._@~+-]*/g;
/**
 * Windows drive paths, with no leading word boundary (`xC:\dir` is still a path). The first
 * segment may not start with a separator, so a URL's `https://` never matches.
 */
const WINDOWS_ABS = /[A-Za-z]:[\\/][^\s"'`<>|\\/]+(?:[\\/][^\s"'`<>|\\/]*)*/g;
/** UNC (`\\host\share`) and rootless backslash paths (`\Users\name\`). */
const BACKSLASH_ABS = /(?<![A-Za-z0-9._-])\\{1,2}(?:[^\s"'`<>|\\/:*?]+\\)+[^\s"'`<>|\\/:*?]*/g;
/** A named user's home, `~name` or `~name/...`. A bare `~/x` names no user and stays. */
const TILDE_USER = /(?<![A-Za-z0-9._~-])~[A-Za-z_][A-Za-z0-9._-]*/g;
/** `file:` URLs name host paths too. */
const FILE_URL = /\bfile:\/\/[^\s"'`<>]*/gi;

const PATH_SHAPES: readonly RegExp[] = [
  FILE_URL,
  WINDOWS_ABS,
  BACKSLASH_ABS,
  POSIX_ABS,
  TILDE_USER,
];

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

// ---------------------------------------------------------------------------------------
// Decoding: every form a value can hide behind in a bundle or a report

/** JSON string escapes (`\/`, `\t`, `\n`, `\uXXXX`, ...) as they would appear in raw text. */
function jsonUnescape(s: string): string {
  return s.replace(/\\(?:u([0-9A-Fa-f]{4})|(["\\/bfnrt]))/g, (_m, hex?: string, ch?: string) => {
    if (hex !== undefined) return String.fromCharCode(Number.parseInt(hex, 16));
    return (
      ({ b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" } as Record<string, string>)[ch as string] ??
      (ch as string)
    );
  });
}

/** Percent-encoding (`%2F`), decoded byte-wise so a malformed sequence cannot stop the scan. */
function percentDecode(s: string): string {
  return s.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => {
    try {
      return decodeURIComponent(run);
    } catch {
      return run.replace(/%([0-9A-Fa-f]{2})/g, (_m, h: string) =>
        String.fromCharCode(Number.parseInt(h, 16)),
      );
    }
  });
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  sol: "/",
  bsol: "\\",
  colon: ":",
  tilde: "~",
  Tab: "\t",
  NewLine: "\n",
  nbsp: " ",
};

/** HTML character references (`&#47;`, `&#x2F;`, `&sol;`). */
function htmlDecode(s: string): string {
  return s.replace(/&(?:#(\d{1,7})|#[xX]([0-9A-Fa-f]{1,6})|([A-Za-z]{2,8}));?/g, (m, d, h, n) => {
    const code = d !== undefined ? Number(d) : h !== undefined ? Number.parseInt(h, 16) : NaN;
    if (!Number.isNaN(code)) return code <= 0x10ffff ? String.fromCodePoint(code) : m;
    return NAMED_ENTITIES[n as string] ?? m;
  });
}

const DECODERS: ReadonlyArray<(s: string) => string> = [jsonUnescape, percentDecode, htmlDecode];

/** How many decoders may be stacked (e.g. a percent-encoded value inside an HTML attribute). */
export const DECODE_DEPTH = 3;

/** The string and every distinct form reachable by stacking up to `DECODE_DEPTH` decoders. */
export function decodedVariants(s: string): string[] {
  const seen = new Set<string>([s]);
  let frontier = [s];
  for (let depth = 0; depth < DECODE_DEPTH && frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const v of frontier)
      for (const decode of DECODERS) {
        const d = decode(v);
        if (!seen.has(d)) {
          seen.add(d);
          next.push(d);
        }
      }
    frontier = next;
  }
  return [...seen];
}

// ---------------------------------------------------------------------------------------
// Scanning

export interface Leak {
  readonly kind: "secret" | "vault-key" | "host-path" | "username";
  /** Never the leaked value itself: only where (an offset, or a string's ordinal) and what kind. */
  readonly at: number;
}

/** Leak kinds found in one string, in its plain form only. */
function plainLeaks(
  text: string,
  ctx: RedactionContext,
): Array<{ kind: Leak["kind"]; at: number }> {
  const out: Array<{ kind: Leak["kind"]; at: number }> = [];
  const scan = (re: RegExp, kind: Leak["kind"]) => {
    const r = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
    for (const m of text.matchAll(r)) out.push({ kind, at: m.index ?? 0 });
  };
  for (const v of ctx.secrets) if (v.length >= MIN_LITERAL) scan(new RegExp(escapeRe(v)), "secret");
  for (const v of ctx.vaultKeys)
    if (v.length >= MIN_LITERAL) scan(new RegExp(escapeRe(v)), "vault-key");
  for (const v of ctx.hostPaths)
    if (v.length >= MIN_LITERAL) scan(new RegExp(escapeRe(v)), "host-path");
  for (const re of usernameRes(ctx)) scan(re, "username");
  for (const re of SECRET_SHAPES) scan(re, "secret");
  for (const re of PATH_SHAPES) scan(re, "host-path");
  return out;
}

/**
 * Scan a text for anything redaction should have removed, in the text itself and in every
 * decoded form. Returns kinds and offsets only, never the matched text, so a leak report
 * cannot itself leak.
 */
export function findLeaks(text: string, ctx: RedactionContext = EMPTY_REDACTION): Leak[] {
  const leaks: Leak[] = [];
  const seen = new Set<string>();
  for (const variant of decodedVariants(text))
    for (const l of plainLeaks(variant, ctx)) {
      const key = `${l.kind}@${l.at}`;
      if (!seen.has(key)) {
        seen.add(key);
        leaks.push(l);
      }
    }
  return leaks;
}

/**
 * Scan every string value and every object key of a parsed JSON value. `at` is the ordinal
 * of the offending string in traversal order (never a key or a value).
 */
export function findLeaksDeep(value: unknown, ctx: RedactionContext = EMPTY_REDACTION): Leak[] {
  const leaks: Leak[] = [];
  let ordinal = 0;
  const visitString = (s: string) => {
    const at = ordinal++;
    const kinds = new Set(findLeaks(s, ctx).map((l) => l.kind));
    for (const kind of kinds) leaks.push({ kind, at });
  };
  const visit = (v: unknown) => {
    if (typeof v === "string") visitString(v);
    else if (Array.isArray(v)) for (const item of v) visit(item);
    else if (v !== null && typeof v === "object")
      for (const [k, item] of Object.entries(v)) {
        visitString(k);
        visit(item);
      }
  };
  visit(value);
  return leaks;
}

// ---------------------------------------------------------------------------------------
// Rewriting

function redactPlain(input: string, ctx: RedactionContext): string {
  let out = input;
  for (const [value, placeholder] of literals(ctx)) out = out.split(value).join(placeholder);
  for (const re of SECRET_SHAPES) out = out.replace(re, PLACEHOLDER.secret);
  for (const re of PATH_SHAPES) out = out.replace(re, PLACEHOLDER.hostPath);
  for (const re of usernameRes(ctx)) out = out.replace(re, PLACEHOLDER.username);
  return out;
}

const KIND_PLACEHOLDER: Record<Leak["kind"], string> = {
  secret: PLACEHOLDER.secret,
  "vault-key": PLACEHOLDER.vaultKey,
  "host-path": PLACEHOLDER.hostPath,
  username: PLACEHOLDER.username,
};

/**
 * Rewrite one string so it carries no registered value and no generic secret or host path,
 * in any decoded form. A whitespace-separated token that still leaks once decoded is
 * replaced whole; if a leak still remains (it spans tokens), the whole string is replaced.
 */
export function redactText(input: string, ctx: RedactionContext): string {
  let out = redactPlain(input, ctx);
  if (findLeaks(out, ctx).length === 0) return out;
  out = out.replace(/\S+/g, (token) => {
    const leaks = findLeaks(token, ctx);
    return leaks.length === 0 ? token : KIND_PLACEHOLDER[(leaks[0] as Leak).kind];
  });
  if (findLeaks(out, ctx).length === 0) return out;
  return PLACEHOLDER.secret;
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
