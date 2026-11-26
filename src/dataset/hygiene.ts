/**
 * Leak scan for exported datasets (track U). Walks every string (keys and values) of a value
 * and reports where a host path, the host's user or machine name, an operator-named
 * forbidden string, or a secret-shaped string appears.
 *
 * The exporter never redacts: one finding refuses the whole export (fail closed), and the
 * finding names the record and JSON path and the kind, never the matched text, so a refusal
 * cannot itself leak the value. Paths the harness controls are written as `<home>` /
 * `<desktop>` placeholders at the source (`src/desktops/local-process.ts`).
 */
import { hostname, userInfo } from "node:os";

export type LeakKind = "host-path" | "username" | "hostname" | "forbidden-string" | "secret-shaped";

export interface Leak {
  /** JSON path of the string, e.g. `$.steps[2].observation.text`. */
  readonly path: string;
  readonly kind: LeakKind;
}

export interface HygieneOptions {
  /** Extra strings that must not appear (exact substring, case-sensitive). */
  readonly forbiddenStrings?: readonly string[];
  /** Add this machine's user and host names to the scan. Default true. */
  readonly hostIdentity?: boolean;
}

/**
 * Absolute host paths: a POSIX path under a well-known top-level directory, a Windows drive
 * or UNC path, a `file:` URL, or a home-relative `~/` path. The leading class keeps a
 * relative path such as `docs/var/x` from matching.
 */
const HOST_PATH: readonly RegExp[] = [
  /(?:^|[^A-Za-z0-9_.<>-])\/(?:home|Users|root|tmp|var|private|opt|etc|mnt|srv|Volumes|run|proc|nix|usr|workspace|data)(?:\/|$)/,
  /(?:^|[^A-Za-z0-9])[A-Za-z]:\\/,
  /\\\\[A-Za-z0-9._-]+\\/,
  /\bfile:\/\//i,
  /(?:^|[\s"'=(:])~\//,
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

function wordPattern(word: string): RegExp {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^A-Za-z0-9])${escaped}(?:$|[^A-Za-z0-9])`);
}

function identityPatterns(options: HygieneOptions): Array<[LeakKind, RegExp]> {
  const out: Array<[LeakKind, RegExp]> = [];
  if (options.hostIdentity !== false) {
    let user = "";
    try {
      user = userInfo().username;
    } catch {
      user = "";
    }
    if (user.length >= 3 && !GENERIC_ACCOUNTS.has(user.toLowerCase())) {
      out.push(["username", wordPattern(user)]);
    }
    const host = hostname().split(".")[0] ?? "";
    if (host.length >= 4 && host !== "localhost") out.push(["hostname", wordPattern(host)]);
  }
  return out;
}

/** Kinds found in one string, in a fixed order. */
export function leaksIn(text: string, options: HygieneOptions = {}): LeakKind[] {
  const kinds: LeakKind[] = [];
  if (HOST_PATH.some((re) => re.test(text))) kinds.push("host-path");
  for (const [kind, re] of identityPatterns(options)) {
    if (re.test(text) && !kinds.includes(kind)) kinds.push(kind);
  }
  for (const s of options.forbiddenStrings ?? []) {
    if (s.length > 0 && text.includes(s)) {
      kinds.push("forbidden-string");
      break;
    }
  }
  if (SECRET_SHAPED.some((re) => re.test(text))) kinds.push("secret-shaped");
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
