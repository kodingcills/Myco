/**
 * Track Q (replayable proof): redaction for proof bundles and reports.
 *
 * A proof bundle is meant to be shared, so it must not carry a secret, an absolute host path,
 * a username or a vault key, as far as the shapes and literals below recognise them. Two
 * layers, both fail closed:
 *  1. `redactText` rewrites every string the exporter puts in a bundle: registered literal
 *     values first (secrets, vault keys, host paths), then generic shapes
 *     (home roots `Users`/`home`/`root`/`Documents and Settings`/`DOCUME~N` after any
 *     non-alphanumeric character, with spaces allowed in the user segment; UNC paths in every
 *     separator and prefix form and network file URLs, with spaces allowed in every segment;
 *     Windows drive paths, also with spaced segments; absolute POSIX paths, `~user` homes,
 *     `var/folders`, `file:` URLs, key-shaped tokens; then the account-name shapes
 *     `DOMAIN\user` and `user@host`, and registered account names in any letter case). A
 *     token that still leaks once decoded (JSON escapes, percent-encoding, HTML entities) is
 *     replaced whole. What is NOT caught is listed under "Limits" in
 *     docs/architecture/replayable-proof.md.
 *  2. The scanners refuse anything left:
 *     - `findLeaksDeep` scans every parsed string value AND every object key of a value
 *       (the verifier runs it over the parsed bundle);
 *     - `findLeaks` scans a text (the verifier runs it over the raw text only when it is not
 *       valid JSON, since parsed JSON gets `findLeaksDeep`; the report renderer runs it over
 *       the final HTML before it returns it).
 *     Each scanned string is also scanned in every decoded form (`decodedVariants`), so a
 *     path behind `\/`, `\t`, `\u002f`, `%2F` or `&#47;` is still found.
 *     Anything left that a scanner recognises is a refusal: the exporter throws, the
 *     verifier refuses, the report is not rendered. A scanner cannot flag a fragment that no
 *     longer looks like a path, so the whitespace-tolerant home-root and UNC shapes run first
 *     and an encoded path with whitespace replaces the whole string (R3-D1).
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
  /** Account names: removed as whole words, in any letter case. */
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
/**
 * A user-folder segment after a home root. Spaces ARE allowed (R3-D1): a Windows account
 * named "First Last" has the profile `C:\Users\First Last`, and a class that stops at the
 * first space left the surname in the bundle. The segment runs to the next separator and stops
 * only at characters no Windows or POSIX account name may contain (`" / \ [ ] : ; | = , + * ?
 * < >`) or a line break / tab. It must start with a non-space so prose such as "home/ dir" is
 * not a path. Over-matching (the rest of a sentence) is redacted, never leaked.
 */
const USER_SEG = String.raw`[^\s"<>|\\/:*?;=,+\[\]][^\r\n\t"<>|\\/:*?;=,+\[\]]*`;
/** A later path segment: no whitespace. */
const PATH_SEG = String.raw`[^\s"'\`<>|\\/]+`;
/**
 * Home roots, with NO lookbehind deny-list (R2-D1). The POSIX shape above skips a path that
 * follows a letter, digit, `.`, `-` or `/`, and each of those was a bypass (`Saving.../home/a`,
 * `../../Users/a`, `v2/Users/a`, `build-/home/runner`). So any home root followed by a
 * separator and a segment, after any non-alphanumeric character or at the start, is a host
 * path, whatever precedes it and whatever the separators (`/Users\a`, drive-relative
 * `C:Users\a`). The roots are `Users`, `home`, `root`, Windows XP's `Documents and Settings`
 * and its 8.3 short name `DOCUME~N` (R3-D1); an 8.3 user folder (`ALICEZ~1`) is an ordinary
 * segment. Case-insensitive, since Windows paths are.
 *
 * ORDER MATTERS: these run BEFORE the drive, backslash and POSIX shapes, which stop at
 * whitespace. Run after them, `C:\Users\Alice Zqplant` became `[redacted] Zqplant` and the
 * root that would have caught the rest was already gone.
 */
const HOME_ROOT = new RegExp(
  String.raw`(?<![A-Za-z0-9])(?:users|home|root|documents and settings|docume~\d+)[\\/]+${USER_SEG}(?:[\\/]+${PATH_SEG})*`,
  "gi",
);
/**
 * UNC paths, with every segment after the host allowed to carry spaces: a share or folder is
 * often named after its user (`\\nas\homes\First Last`). R2-D1 closes the whole class:
 *  - either separator, mixed or repeated, after a `\\` or `//` host (`\\nas/homes/a`,
 *    `//nas/a`, a double-escaped `\\\\nas\\a`);
 *  - the Win32 long-path and device prefixes `\\?\` and `\\.\` (the lone `?` or `.` is the
 *    "host", then `UNC`, the server and the share are ordinary segments; `\\?\C:\Users\a` is
 *    caught by the home-root shape, which runs first, and the drive shape);
 *  - a URL scheme's `://` never matches (`:` may not precede), so `https://host/x` stays; the
 *    network file schemes are caught by `NET_URL` below.
 */
const UNC_SPACED = new RegExp(
  String.raw`(?<![A-Za-z0-9._:-])[\\/]{2,}(?:[?.]|[^\s\\/"<>|:*?]+)(?:[\\/]+${USER_SEG})+`,
  "g",
);
/** Network file URLs (`smb://nas/homes/First Last/x`): every segment may carry spaces. */
const NET_URL = new RegExp(
  String.raw`(?<![A-Za-z0-9+.-])(?:smb|cifs|afp|nfs|webdav|davs?|s?ftps?):\/\/[^\s\\/"<>|*?]+(?:[\\/]+${USER_SEG})*`,
  "gi",
);
/**
 * Windows drive paths with spaces in any segment (D3: `D:\Profiles\First Last\x` outside the
 * home roots). The space-free `WINDOWS_ABS` below still catches the rest.
 */
const WINDOWS_SPACED = new RegExp(String.raw`[A-Za-z]:[\\/]${USER_SEG}(?:[\\/]+${USER_SEG})*`, "g");
const VAR_FOLDERS = /(?<![A-Za-z0-9])var[\\/]+folders(?:[\\/]+[^\s"'`<>|\\/]+)*/gi;

/**
 * Account names in the forms a harness prints them (D3): `whoami` and Windows prompts print
 * `DOMAIN\user` (a NetBIOS or DNS domain, then a backslash, then a user segment that may carry
 * spaces), and POSIX prompts, `scp` and e-mail print `user@host`. Both are redacted as
 * usernames and refused by the scanners. Over-matching (a relative `dir\file`, an e-mail
 * address, `git@host`) is redacted, never leaked.
 */
const DOMAIN_USER = new RegExp(
  String.raw`(?<![A-Za-z0-9._:\\/-])[A-Za-z0-9][A-Za-z0-9.-]{0,62}\\(?![\\/])${USER_SEG}`,
  "g",
);
const USER_AT_HOST =
  /(?<![A-Za-z0-9._+-])[A-Za-z0-9_][A-Za-z0-9._+-]*@[A-Za-z][A-Za-z0-9-]*(?:\.[A-Za-z0-9-]+)*/g;
const USERNAME_SHAPES: readonly RegExp[] = [DOMAIN_USER, USER_AT_HOST];

/** The shapes whose match may span whitespace: a token-by-token rewrite cannot remove them. */
const SPACE_SPANNING: readonly RegExp[] = [
  HOME_ROOT,
  UNC_SPACED,
  NET_URL,
  WINDOWS_SPACED,
  DOMAIN_USER,
];

const PATH_SHAPES: readonly RegExp[] = [
  // Whitespace-tolerant shapes first (see HOME_ROOT): they must see the whole path.
  HOME_ROOT,
  UNC_SPACED,
  NET_URL,
  WINDOWS_SPACED,
  FILE_URL,
  WINDOWS_ABS,
  BACKSLASH_ABS,
  POSIX_ABS,
  TILDE_USER,
  VAR_FOLDERS,
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
  return (
    ctx.usernames
      .filter((u) => u.length >= MIN_LITERAL)
      // Case-insensitive (D3): Windows account names are (`qzuser` is `Qzuser` and `QZUSER`).
      .map((u) => new RegExp(`(?<![A-Za-z0-9_])${escapeRe(u)}(?![A-Za-z0-9_])`, "gi"))
  );
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
  for (const re of USERNAME_SHAPES) scan(re, "username");
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
  for (const re of USERNAME_SHAPES) out = out.replace(re, PLACEHOLDER.username);
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
  // A path that only appears once decoded and that contains whitespace (`C:\u005cUsers\u005c
  // First Last`) cannot be rewritten in its plain form: a whitespace-stopping shape removes the
  // part before the space, and the surname survives with no root left to flag it. Checked on
  // the INPUT, before any rewrite: replace the whole string (R3-D1).
  if (encodedSpaceSpanning(input)) return PLACEHOLDER.hostPath;
  let out = redactPlain(input, ctx);
  if (findLeaks(out, ctx).length === 0) return out;
  out = out.replace(/\S+/g, (token) => {
    const leaks = findLeaks(token, ctx);
    return leaks.length === 0 ? token : KIND_PLACEHOLDER[(leaks[0] as Leak).kind];
  });
  if (findLeaks(out, ctx).length === 0) return out;
  return PLACEHOLDER.secret;
}

/**
 * True when a decoded form of `text` (not the plain form, which `redactPlain` rewrites whole)
 * holds a home-root or UNC path that contains whitespace.
 */
function encodedSpaceSpanning(text: string): boolean {
  for (const variant of decodedVariants(text))
    if (variant !== text)
      for (const re of SPACE_SPANNING)
        for (const m of variant.matchAll(new RegExp(re.source, re.flags)))
          if (/\s/.test(m[0])) return true;
  return false;
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
