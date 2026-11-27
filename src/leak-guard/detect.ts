/**
 * The shared leak detector (TIF-98, "shift leak prevention left"). One detector for every
 * outward-bound byte this repo produces or commits: dataset/episode/bundle outputs, logs,
 * fixtures and tracked files. `pnpm leak-guard` and `test/leak-guard/` both run it.
 *
 * Classes (a finding carries exactly one):
 *   - `username`   the current host's account name, or a planted one (tests), as a word.
 *   - `home-path`  an absolute home path with an account segment, in any spelling: POSIX
 *                  `/Users/<n>` and `/home/<n>`, Windows `C:\Users\<n>`, `Documents and
 *                  Settings`, 8.3 short names (`DOCUME~1`, `<n>~1`), UNC
 *                  (`\\host\c$\Users\<n>`) and `\\?\` forms, mixed separators, and spaced
 *                  folders (`/Users/<First Last>`); also this machine's own home and repo paths.
 *   - `hostname`   the current machine's host name, or a planted one, as a word; and the
 *                  generic Mac host shapes (a name, then `-MacBook-Pro`, `-iMac`, ...).
 *   - `key-shaped` provider key prefixes, private-key headers and JWTs.
 *
 * Every text is scanned as written AND in every decoded form `decodedForms` yields (JSON,
 * URL/percent, HTML-entity, shell/C escapes and Unicode look-alikes; src/dataset/hygiene.ts,
 * the decoder track U's verifier rounds hardened), so an escaped leak is caught too.
 *
 * NEVER returns or prints a matched value: a finding is a location (line, column) and a
 * class. The account segment is compared against the allowlist inside this module and
 * dropped. Fail closed: a text this module cannot decode or scan is a finding, not a pass.
 */
import { homedir, hostname, userInfo } from "node:os";
import { decodedForms } from "../dataset/hygiene.ts";

export const LEAK_CLASSES = ["username", "home-path", "hostname", "key-shaped"] as const;
export type LeakClass = (typeof LEAK_CLASSES)[number];

export interface LeakFinding {
  /** 1-based line of the text as written (the decoded form's match is mapped back). */
  readonly line: number;
  readonly class: LeakClass;
}

/** The identity to look for. Host facts come from `os`; nothing is read from the environment. */
export interface Identity {
  /** Account names (the host's, plus planted test ones). Generic names are dropped. */
  readonly users: readonly string[];
  /** Host names (first DNS label is used). */
  readonly hosts: readonly string[];
  /** Absolute paths that must never appear (this machine's home and repo root). */
  readonly paths: readonly string[];
}

export interface DetectOptions {
  readonly identity: Identity;
  /** Account segments of a home path that are documented placeholders (the allowlist). */
  readonly allowedAccounts?: ReadonlySet<string>;
  /** Classes to skip entirely for this text (file-scoped allowlist entries). */
  readonly skipClasses?: ReadonlySet<LeakClass>;
  /** Told which allowlisted account excused a home path (stale-entry tracking). */
  readonly onAllowed?: (account: string) => void;
}

/**
 * Account names too generic to look for as a bare word (`root` would match every doc). Their
 * home paths are still caught by `home-path`, which does not depend on this list.
 */
const GENERIC_ACCOUNTS = new Set([
  "root",
  "user",
  "runner",
  "admin",
  "ubuntu",
  "node",
  "nobody",
  "vscode",
  "codespace",
]);

const safe = (get: () => string): string => {
  try {
    return get();
  } catch {
    return "";
  }
};

/** This machine's identity, from `os` only (never the environment). */
export function hostIdentity(repoRoot: string): Identity {
  const home = safe(homedir);
  return {
    users: [safe(() => userInfo().username)].filter(Boolean),
    hosts: [safe(hostname)].filter(Boolean),
    // `/` alone (or a one-segment home) would match everything: keep two-plus segments.
    paths: [home, repoRoot].filter((p) => /^(?:[A-Za-z]:)?[\\/][^\\/]+[\\/][^\\/]+/.test(p)),
  };
}

export function mergeIdentity(a: Identity, b: Partial<Identity>): Identity {
  return {
    users: [...a.users, ...(b.users ?? [])],
    hosts: [...a.hosts, ...(b.hosts ?? [])],
    paths: [...a.paths, ...(b.paths ?? [])],
  };
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** `word` not glued to a letter or digit on either side. Case-sensitive (see below). */
const wordRe = (word: string, flags = "") =>
  new RegExp(`(?<![A-Za-z0-9])${escapeRe(word)}(?![A-Za-z0-9])`, flags);

/**
 * Collapse every separator run (`/`, `\`, `\\`, `//`) to `/`, so a doubled-backslash drive
 * path, a mixed-separator path, a `\\?\` path and a UNC admin-share path all read as
 * `.../Users/<n>`.
 */
const unifySeparators = (s: string) => s.replace(/[\\/]+/g, "/");

/**
 * The home roots. `home` is lowercase only on purpose (POSIX is case-sensitive, and the
 * keyboard's `Home/End` is not a path); the Windows/macOS roots are case-insensitive.
 * 8.3 short names: `DOCUME~1` (Documents and Settings), `USERS~1` is not a real short name
 * but costs nothing. An account segment may itself be a short name (`JANEDO~1`), which the
 * account pattern allows (`~` is an account character).
 */
const HOME_ROOT = String.raw`(?:home|[Uu][Ss][Ee][Rr][Ss]|[Dd][Oo][Cc][Uu][Mm][Ee][Nn][Tt][Ss] [Aa][Nn][Dd] [Ss][Ee][Tt][Tt][Ii][Nn][Gg][Ss]|[Dd][Oo][Cc][Uu][Mm][Ee]~\d|[Uu][Ss][Ee][Rr][Ss]~\d)`;

/**
 * An account segment: any characters (Unicode letters included: `José`, `Zoë`) up to a
 * separator, whitespace, quote, backtick, bracket or URL/JSON punctuation. It must not START with
 * `<`, `$`, `{`, `%`, `.`, `~`, `*`, `-` or `…`, so `<you>`, `$USER`, `${USER}`, `%USERNAME%`,
 * `...`, `…` and `*` are placeholders, not accounts. Single inner spaces join words, so a spaced
 * folder (`First Last`) is one account.
 */
const NAME_CHAR = `[^/\\\\\\s"'\`<>|:*?,;()\\[\\]{}&#=%]`;
const NAME_START = String.raw`(?![<$%{.~*\u2026-])`;
const ACCOUNT = `(${NAME_START}${NAME_CHAR}+(?: ${NAME_START}${NAME_CHAR}+)*)`;

/**
 * `/<root>/<account>` at the end of an ABSOLUTE path: the path starts with `/` (or a drive)
 * that is not glued to a name character, then any number of segments (`/var/home/<n>`,
 * `\\srv\share\Users\<n>`, `\\?\UNC\...`). So `docs/home/x` and `my-home/x` are
 * relative and clean. The account runs greedily to its first stop character, so a
 * following separator is not required: a home path at the end of a string still leaks.
 */
const SEGMENT = `[^/\\s"'\`<>|]+`;
const HOME_PATH = new RegExp(
  String.raw`(?<![\p{L}\p{N}_.~-])(?:[A-Za-z]:)?(?:/${SEGMENT})*?/${HOME_ROOT}/${ACCOUNT}`,
  "gu",
);

/**
 * A web URL's scheme and host (`https://example.com`), replaced by a word before the home
 * scan so `https://example.com/home/x` reads as a relative `URL/home/x`. `file:` URLs are
 * host paths and are kept; a one-letter "scheme" is a drive (`C:`), also kept.
 */
const WEB_URL = /(?<![A-Za-z0-9+.-])(?!file:)[A-Za-z][A-Za-z0-9+.-]+:[\\/]{2}[^\\/\s"'<>]*/gi;

/** Mac host shapes: a name, then `-MacBook`, `-MacBook-Pro`/`-Air`, `-iMac`, `-Mac-mini`/`-Studio`/`-Pro`. */
const MAC_HOST =
  /(?<![A-Za-z0-9])[A-Za-z0-9][A-Za-z0-9-]*-(?:MacBook(?:-(?:Pro|Air))?|iMac(?:-Pro)?|Mac-(?:mini|Studio|Pro))(?![A-Za-z])/;

/**
 * Key-shaped strings. Every pattern is assembled from parts so this file never matches a
 * secret scanner (gitleaks) or itself. Structural prefixes only: a generic `token=...` rule
 * would flag every doc that names a config field, and gitleaks already covers entropy.
 */
const KEY_SHAPED: readonly RegExp[] = [
  ["sk", "-ant-", "[A-Za-z0-9_-]{8,}"],
  ["(?<![A-Za-z0-9])sk", "-", "(?:proj-)?[A-Za-z0-9]{20,}"],
  ["(?<![A-Za-z0-9])sk", "_(?:live|test)_", "[A-Za-z0-9]{8,}"],
  ["(?<![A-Za-z0-9])gh", "[pousr]_", "[A-Za-z0-9]{20,}"],
  ["(?<![A-Za-z0-9])github", "_pat_", "[A-Za-z0-9_]{20,}"],
  ["(?<![A-Za-z0-9])gl", "pat-", "[A-Za-z0-9_-]{16,}"],
  ["(?<![A-Za-z0-9])AK", "IA", "[0-9A-Z]{16}(?![A-Za-z0-9])"],
  ["(?<![A-Za-z0-9])AI", "za", "[0-9A-Za-z_-]{35}"],
  ["(?<![A-Za-z0-9])xo", "x[abprs]-", "[A-Za-z0-9-]{10,}"],
  ["-----BEGIN [A-Z ]*PRI", "VATE KEY", "-----"],
  ["(?<![A-Za-z0-9])ey", "J[A-Za-z0-9_-]{10,}\\.ey", "J[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{8,}"],
].map((parts) => new RegExp(parts.join("")));

interface Compiled {
  readonly users: readonly RegExp[];
  readonly hosts: readonly RegExp[];
  readonly paths: readonly string[];
}

function compile(identity: Identity): Compiled {
  const users = [...new Set(identity.users)]
    .filter((u) => u.length >= 3 && !GENERIC_ACCOUNTS.has(u.toLowerCase()))
    // Case-sensitive: an account name leaks in its exact spelling (paths, prompts, logs);
    // a case-insensitive match would flag a person's first name in prose.
    .map((u) => wordRe(u));
  const hosts = [...new Set(identity.hosts)]
    .map((h) => h.split(".")[0] ?? "")
    .filter((h) => h.length >= 4 && h.toLowerCase() !== "localhost")
    // Host names are case-insensitive (DNS).
    .map((h) => wordRe(h, "i"));
  const paths = [...new Set(identity.paths)].map(unifySeparators);
  return { users, hosts, paths };
}

/** Classes present in one string (any decoded form). Exported for the property tests. */
export function classesIn(text: string, options: DetectOptions): LeakClass[] {
  return classesInCompiled(text, compile(options.identity), options);
}

function homePathHit(
  form: string,
  allowed: ReadonlySet<string>,
  onAllowed?: (account: string) => void,
): boolean {
  const unified = unifySeparators(form.replace(WEB_URL, "URL"));
  for (const m of unified.matchAll(HOME_PATH)) {
    // A spaced account (`First Last`) is captured greedily, so prose after a placeholder
    // (a placeholder account followed by ` is ...`) joins it: the hit is allowed when a
    // leading run of words is an allowlisted account. Trailing dots are punctuation.
    const words = (m[1] ?? "").split(" ");
    const excuse = words
      .map((_w, i) =>
        words
          .slice(0, i + 1)
          .join(" ")
          .replace(/\.+$/, ""),
      )
      .find((a) => allowed.has(a));
    if (excuse === undefined) return true;
    onAllowed?.(excuse);
  }
  return false;
}

function classesInCompiled(text: string, c: Compiled, options: DetectOptions): LeakClass[] {
  const skip = options.skipClasses ?? new Set<LeakClass>();
  const allowed = options.allowedAccounts ?? new Set<string>();
  const forms = decodedForms(text);
  const out: LeakClass[] = [];
  const any = (pred: (f: string) => boolean) => forms.some(pred);
  if (!skip.has("username") && c.users.some((re) => any((f) => re.test(f)))) out.push("username");
  if (
    !skip.has("home-path") &&
    (any((f) => homePathHit(f, allowed, options.onAllowed)) ||
      c.paths.some((p) => any((f) => unifySeparators(f).includes(p))))
  )
    out.push("home-path");
  if (
    !skip.has("hostname") &&
    (c.hosts.some((re) => any((f) => re.test(f))) || any((f) => MAC_HOST.test(f)))
  )
    out.push("hostname");
  if (!skip.has("key-shaped") && KEY_SHAPED.some((re) => any((f) => re.test(f))))
    out.push("key-shaped");
  return out;
}

/**
 * Findings in a whole text, one per (line, class). The whole text is checked first (one
 * pass); only a text with a hit is re-scanned line by line to locate it. A hit that only
 * shows across lines (a key split by a newline is not one; a decoded form joining lines is
 * not possible) is reported at line 0 so it is never lost.
 */
export function scanText(text: string, options: DetectOptions): LeakFinding[] {
  const c = compile(options.identity);
  const whole = classesInCompiled(text, c, options);
  if (whole.length === 0) return [];
  const out: LeakFinding[] = [];
  const located = new Set<LeakClass>();
  const lines = text.split("\n");
  for (const [i, line] of lines.entries()) {
    for (const k of classesInCompiled(line, c, options)) {
      out.push({ line: i + 1, class: k });
      located.add(k);
    }
  }
  for (const k of whole) if (!located.has(k)) out.push({ line: 0, class: k });
  return out;
}
