/**
 * Leak scan for exported datasets (track U). Walks every string (keys and values) of a value
 * and reports where a host path, the host's user or machine name, an operator-named
 * forbidden string, or a secret-shaped string appears.
 *
 * The exporter never redacts: one finding refuses the whole export (fail closed), and the
 * finding names the file and JSON path and the kind, never the matched text, so a refusal
 * cannot itself leak the value. Paths the harness controls are written as `<home>` /
 * `<desktop>` placeholders at the source (`src/desktops/local-process.ts`).
 *
 * Encodings: every string is scanned as written AND after decoding Unicode look-alikes
 * (NFKC fullwidth forms, other slash glyphs, zero-width characters), shell/C escapes
 * (`\x2f`, `\057`, `\u{2f}`), JSON escapes (`\/`, `\\`, `\uXXXX`), percent/URL escapes
 * (`%2F`, also double-encoded) and HTML entities, so an encoded host path or user name is
 * caught too. Any absolute POSIX path of two or more segments is a host path, whatever its
 * root (a root list is never complete). Every pattern is tested
 * against every decoded form (test/dataset/hygiene-transcript.test.ts has one test per
 * bypass the round-1 verifier and the shared root cause named).
 *
 * TO FILE: consolidate onto the canonical episode cleanliness scan (`src/episode/clean.ts`,
 * data-capture PR #542) once it merges, so one scanner guards every export.
 */
import { readFileSync } from "node:fs";
import { hostname, userInfo } from "node:os";

export type LeakKind =
  | "host-path"
  | "username"
  | "hostname"
  | "planted-marker"
  | "forbidden-string"
  | "secret-shaped"
  | "identity";

/** The canary #542's tests plant in env, home, fixtures, the vault and oracle config. */
export const PLANTED_MARKER = ["PLANTED", "FAKE", "MARKER"].join("_");

export interface Leak {
  /** JSON path of the string, e.g. `$.actions.items[2].text`. */
  readonly path: string;
  readonly kind: LeakKind;
}

/** The machine identity to scan for. Default: this machine's (`os.userInfo`, `os.hostname`). */
export interface HostIdentity {
  readonly user: string;
  readonly host: string;
}

export interface HygieneOptions {
  /** Extra strings that must not appear (exact substring, case-sensitive, any encoding). */
  readonly forbiddenStrings?: readonly string[];
  /** Add the machine's user and host names to the scan. Default true. */
  readonly hostIdentity?: boolean;
  /** The identity to scan for instead of this machine's (tests plant one; CI's is generic). */
  readonly identity?: HostIdentity;
  /**
   * A file of configured identity strings (a full name, another account), one per line, `#`
   * comments and blank lines ignored, each at least 3 characters: kind `identity`, matched
   * case-insensitively by word (lead ruling 2026-11-26 21:52Z). Never switched off by
   * `hostIdentity: false`.
   */
  readonly identityFile?: string;
}

/**
 * Top-level host directories. `HOME_ROOTS` hold per-user directories, so they are matched
 * after ANY character (`a.b/home/alice` and `x/Users/bob` are refused: a home path with a
 * user name is never exported, even mid-token). The others are matched after any character
 * that cannot be part of a relative path segment name, so `docs/var/x` stays clean but
 * `>/tmp/x`, `-f/etc/x`, `</var/x` and `2>/dev/null` do not.
 */
const HOME_ROOTS = "home|Users|root";
const SYSTEM_ROOTS = [
  "tmp",
  "var",
  "private",
  "opt",
  "etc",
  "mnt",
  "srv",
  "Volumes",
  "run",
  "proc",
  "sys",
  "dev",
  "boot",
  "media",
  "nix",
  "snap",
  "usr",
  "bin",
  "sbin",
  "lib",
  "lib64",
  "workspace",
  "workspaces",
  "data",
  "scratch",
  "Library",
  "System",
  "Applications",
  "cygdrive",
].join("|");

const HOST_PATH: readonly RegExp[] = [
  // ANY absolute POSIX path of two or more segments, whatever its root (#542's rule): a root
  // list can never be complete (`/github/workspace`, `/__w/repo`, `/runner/work` are real CI
  // paths). Not after a word character, `.`, `~`, `/` or `\`, so relative paths
  // (`docs/var/x`, `./a/b`), URLs (`https://h/p`) and placeholders (`<home>/x`) stay clean.
  /(?<![A-Za-z0-9._~/\\])\/(?:[^\s/\\"'`<>|]+\/)+/,
  // The same, glued to a command-line flag: `-f/ci-cache/x`, `-I/opt-x/include/y`.
  /(?:^|[\s"'=(])--?[A-Za-z][A-Za-z0-9-]*\/(?:[^\s/\\"'`<>|]+\/)+/,
  new RegExp(`\\/(?:${HOME_ROOTS})(?:\\/|\\\\|$)`, "i"),
  new RegExp(`(?:^|[^A-Za-z0-9_])\\/(?:${SYSTEM_ROOTS})(?:\\/|\\\\|$)`, "i"),
  // A command-line flag glued to a system root: `-f/etc/x`, `--out=/tmp/x` is caught above.
  new RegExp(`(?:^|[\\s"'=(])--?[A-Za-z][A-Za-z0-9-]*\\/(?:${SYSTEM_ROOTS})(?:\\/|\\\\|$)`, "i"),
  // Windows drive paths, either separator: `C:\x`, `C:/x`. `http://` is not one (the
  // letter before `:` is preceded by a letter).
  /(?:^|[^A-Za-z0-9])[A-Za-z]:[\\/]/,
  // UNC paths: `\\server\share`, `//server/share` is left alone (protocol-relative URLs).
  /\\\\[A-Za-z0-9._$-]+\\/,
  // Backslash home roots without a drive: `\Users\bob`, `\home\alice`.
  new RegExp(`\\\\(?:${HOME_ROOTS})\\\\`, "i"),
  /\bfile:[\\/]/i,
  // Home-relative: `~/x`, `~\x`, `~alice/x`.
  /(?:^|[^A-Za-z0-9_~])~(?:[A-Za-z_][A-Za-z0-9._-]*)?[\\/]/,
  // Environment-variable spellings of a home.
  /\$HOME\b|\$\{HOME\}|%(?:USERPROFILE|HOMEPATH|HOMEDRIVE|APPDATA|LOCALAPPDATA|TEMP|TMP)%/i,
];

/** Secret-shaped strings. Written so this file never matches the repo's own scanners. */
const SECRET_SHAPED: readonly RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{8,}/,
  /\bsk-[A-Za-z0-9]{20,}/,
  /\bsk_(?:live|test)_[A-Za-z0-9]{8,}/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bglpat-[A-Za-z0-9_-]{16,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bAIza[0-9A-Za-z_-]{35}/,
  /\bxox[abprs]-[A-Za-z0-9-]{8,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/,
  /\b[Bb]earer\s+[A-Za-z0-9._~+/=-]{16,}/,
  /\b(?:api[_-]?key|secret|token|password|passwd)\s*[:=]\s*\S{8,}/i,
];

/** Account names too generic to scan for by name; their home paths are caught as host paths. */
const GENERIC_ACCOUNTS = new Set(["root", "user", "runner", "admin", "ubuntu", "node", "nobody"]);

/** Placeholders the backend writes; they stand for desktop-local paths, never host ones. */
const PLACEHOLDER = /<(?:home|desktop)>/g;

/** Slash look-alikes NFKC does not fold (division, fraction, big solidus; set minus). */
const SLASH_LOOKALIKES = /[\u2044\u2215\u29F8\u2571]/g;
const BACKSLASH_LOOKALIKES = /[\u2216\u29F5\u29F9\u2572\uFE68]/g;
/** Invisible format characters (zero-width space/joiners, word joiner, BOM, soft hyphen). */
const INVISIBLE = /[\u00AD\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g;

function decodeOnce(text: string): string {
  return (
    text
      // Unicode look-alikes: fullwidth `／` (NFKC), other slash glyphs, zero-width splits.
      .normalize("NFKC")
      .replace(SLASH_LOOKALIKES, "/")
      .replace(BACKSLASH_LOOKALIKES, "\\")
      .replace(INVISIBLE, "")
      // Shell / C escapes: `$'\x2fhome'`, `\057`, `\u{2f}`.
      .replace(/\\x([0-9A-Fa-f]{2})/g, (_m, hex: string) =>
        String.fromCharCode(Number.parseInt(hex, 16)),
      )
      .replace(/\\u\{([0-9A-Fa-f]{1,6})\}/g, (_m, hex: string) =>
        String.fromCodePoint(Math.min(Number.parseInt(hex, 16), 0x10ffff)),
      )
      .replace(/\\([0-3][0-7]{2})/g, (_m, oct: string) =>
        String.fromCharCode(Number.parseInt(oct, 8)),
      )
      // JSON escapes.
      .replace(/\\u([0-9A-Fa-f]{4})/g, (_m, hex: string) =>
        String.fromCharCode(Number.parseInt(hex, 16)),
      )
      .replace(/\\\//g, "/")
      .replace(/\\\\/g, "\\")
      // Percent / URL escapes (never throws, unlike decodeURIComponent).
      .replace(/%([0-9A-Fa-f]{2})/g, (_m, hex: string) =>
        String.fromCharCode(Number.parseInt(hex, 16)),
      )
      // HTML numeric entities and the named slash.
      .replace(/&#x([0-9A-Fa-f]{1,6});/g, (_m, hex: string) =>
        String.fromCodePoint(Math.min(Number.parseInt(hex, 16), 0x10ffff)),
      )
      .replace(/&#([0-9]{1,7});/g, (_m, dec: string) =>
        String.fromCodePoint(Math.min(Number.parseInt(dec, 10), 0x10ffff)),
      )
      .replace(/&sol;/gi, "/")
      .replace(/&bsol;/gi, "\\")
  );
}

/** The string as written plus every distinct decoded form (up to three decoding rounds). */
export function decodedForms(text: string): string[] {
  const forms = [text];
  let current = text;
  for (let round = 0; round < 3; round++) {
    const next = decodeOnce(current);
    if (next === current) break;
    forms.push(next);
    current = next;
  }
  return forms;
}

function wordPattern(word: string): RegExp {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^A-Za-z0-9])${escaped}(?:$|[^A-Za-z0-9])`, "i");
}

function machineIdentity(): HostIdentity {
  let user = "";
  try {
    user = userInfo().username;
  } catch {
    user = "";
  }
  return { user, host: hostname() };
}

function identityPatterns(options: HygieneOptions): Array<[LeakKind, RegExp]> {
  const out: Array<[LeakKind, RegExp]> = [];
  if (options.identityFile !== undefined)
    for (const line of readFileSync(options.identityFile, "utf8").split(/\r?\n/)) {
      const s = line.trim();
      if (s.length >= 3 && !s.startsWith("#")) out.push(["identity", wordPattern(s)]);
    }
  if (options.hostIdentity === false) return out;
  const { user, host: fullHost } = options.identity ?? machineIdentity();
  if (user.length >= 3 && !GENERIC_ACCOUNTS.has(user.toLowerCase())) {
    out.push(["username", wordPattern(user)]);
  }
  const host = fullHost.split(".")[0] ?? "";
  if (host.length >= 4 && host.toLowerCase() !== "localhost") {
    out.push(["hostname", wordPattern(host)]);
  }
  return out;
}

/** Kinds found in one string (any decoded form), in a fixed order. */
export function leaksIn(text: string, options: HygieneOptions = {}): LeakKind[] {
  const forms = decodedForms(text);
  const pathForms = forms.map((f) => f.replace(PLACEHOLDER, "PLACEHOLDER"));
  const kinds: LeakKind[] = [];
  if (HOST_PATH.some((re) => pathForms.some((f) => re.test(f)))) kinds.push("host-path");
  for (const [kind, re] of identityPatterns(options)) {
    if (forms.some((f) => re.test(f)) && !kinds.includes(kind)) kinds.push(kind);
  }
  if (forms.some((f) => f.includes(PLANTED_MARKER))) kinds.push("planted-marker");
  for (const s of options.forbiddenStrings ?? []) {
    if (s.length > 0 && forms.some((f) => f.includes(s))) {
      kinds.push("forbidden-string");
      break;
    }
  }
  if (SECRET_SHAPED.some((re) => forms.some((f) => re.test(f)))) kinds.push("secret-shaped");
  return kinds;
}

/** Every leak in `value`, keys included. Non-string leaves (numbers, booleans) cannot leak. */
export function scanForLeaks(value: unknown, options: HygieneOptions = {}, path = "$"): Leak[] {
  const out: Leak[] = [];
  const visit = (v: unknown, p: string) => {
    if (typeof v === "string") {
      for (const kind of leaksIn(v, options)) out.push({ path: p, kind });
    } else if (Array.isArray(v)) {
      for (const [i, item] of v.entries()) visit(item, `${p}[${i}]`);
    } else if (v !== null && typeof v === "object") {
      for (const [key, item] of Object.entries(v)) {
        const keyLeaks = leaksIn(key, options);
        // A leaking key is never echoed into a path (the path goes into the refusal).
        const name = keyLeaks.length > 0 ? "<key>" : key;
        for (const kind of keyLeaks) out.push({ path: `${p}.<key>`, kind });
        visit(item, `${p}.${name}`);
      }
    }
  };
  visit(value, path);
  return out;
}

/**
 * Builds the operator's `forbiddenStrings` from files a desktop agent must never echo (a
 * vault export, a secrets file, a planted canary): every non-empty line, and the value of
 * every `NAME=value` / `name: value` line, of at least `minLength` characters. A vault value
 * that does not LOOK like a secret is caught only this way (docs/product/linux-scale.md §6).
 *
 * The values stay in memory and are only compared: a refusal names the location, never the
 * value. Callers pass file paths; this never reads the environment.
 */
export function forbiddenStringsFromFiles(paths: readonly string[], minLength = 8): string[] {
  const out = new Set<string>();
  for (const path of paths) {
    for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
      const line = raw.trim();
      if (line.length >= minLength) out.add(line);
      const m = /^[A-Za-z0-9_.-]+\s*[=:]\s*(.+)$/.exec(line);
      const value = m?.[1]?.trim().replace(/^["']|["']$/g, "");
      if (value !== undefined && value.length >= minLength) out.add(value);
    }
  }
  return [...out];
}
