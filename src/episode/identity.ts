/**
 * Identity strings in an export (lead ruling 2026-11-26 21:52Z): a bare host username, the host
 * name, or any configured identity string (a full name, say) is a LEAK wherever it appears in an
 * exported episode, alone, in a path or joined to other text, in any field, the closed id and token
 * fields included (`task.id`, `provenance.runId`, `harness.plannerModelId`, key and app names).
 *
 * Scope: the same SOURCES and thresholds as the shared leak guard (#560,
 * `src/leak-guard/detect.ts`), with STRICTER matching (#560 matches the account case-sensitively,
 * as a word; this matches every source folded, by substring, as the ruling requires):
 *  - `username`: the host account name (`os.userInfo().username`), at least 3 characters and not
 *    a generic account (#560's list: `root`, `user`, `runner`, `admin`, `ubuntu`, `node`,
 *    `nobody`, `vscode`, `codespace`; their home paths are caught as paths);
 *  - `hostname`: the host name's first DNS label (`os.hostname()`), at least 4 characters, not
 *    `localhost`;
 *  - `identity`: each line of an optional identity file passed by path (a full name, another
 *    account), at least 3 characters; CRLF and a byte-order mark are accepted.
 * The host values are read at export (and validate) time from `os`, never from the environment,
 * and ALWAYS merged into whatever the caller passes (#553's `mergeIdentity(hostIdentity(), ...)`
 * rule): fake host facts, an empty identity or a short or generic extra name never switch them off.
 *
 * Matching (`fold`): full Unicode case folding (NFKC, then upper case, then lower case, so `ß`
 * and `ẞ` become `ss` and a dotless `ı` or dotted `İ` becomes `i`), then letters and digits only.
 * So a spaced full name matches every joined form of it (`FirstLast`, `first.last`, `first_last`,
 * `First-Last`), `GROSS` matches a configured `Groß`, and `<name>_trial`, `<Name>2`, `xx<name>`,
 * `<name>Trial` all match `<name>`. closed.ts applies it to every string the export keeps verbatim:
 * an id or token holding one is DIGESTED; any other closed pattern field (a task family, a
 * task-set id, a version, the arm, a fault code) holding one REFUSES the export, as does the export
 * filter (and `validateDataset` refuses a dataset carrying one). Free text is always digested. Enum
 * values, digests and content-addressed blob names are exempt (fixed vocabulary or hex: a match
 * there could only be a false refusal).
 */
import { readFileSync } from "node:fs";
import { hostname, userInfo } from "node:os";
import { stripAccents } from "../export-guard/fold.ts";

export type IdentityClass = "username" | "hostname" | "identity";

export interface IdentityIssue {
  readonly class: IdentityClass;
  /** JSON path of the string (never the string). */
  readonly path: string;
}

/** Account names too generic to look for (identical to #560's list). */
export const GENERIC_ACCOUNTS: ReadonlySet<string> = new Set([
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

/**
 * The form identity matching compares: full Unicode case folding, then accents stripped (#579
 * O2, `stripAccents`: NFD, combining marks removed, `ø`/`ł`/`æ`… transliterated, so `josé`
 * matches `JOSE` and `reña` matches `rena`), then letters and digits only. Both sides fold.
 */
export const fold = (s: string): string =>
  stripAccents(s.normalize("NFKC").toUpperCase().toLowerCase().replace(/ß/g, "ss")).replace(
    /[^\p{L}\p{N}]/gu,
    "",
  );

/** The shortest folded identity looked for. */
export const IDENTITY_MIN_CHARS = 3;

const safe = (get: () => string): string => {
  try {
    return get();
  } catch {
    return "";
  }
};

export interface IdentityOptions {
  /** Extra account names (tests plant them; the host's own is always added). */
  readonly users?: readonly string[];
  /** Extra host names (the host's own is always added). */
  readonly hosts?: readonly string[];
  /** A file of identity strings, one per line (blank lines and `#` comments ignored). */
  readonly identityFile?: string;
}

/** An identity string and its class (never printed). */
export type IdentityEntry = readonly [IdentityClass, string];

/** The configured identity file's lines; an unreadable file refuses without naming its path. */
function identityFileLines(path: string): string[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new Error("export refused: the identity file cannot be read");
  }
  return text
    .split(/\r?\n/)
    .map((l) => l.replace(/^﻿/u, "").trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));
}

/** The identity strings: the host's (always), merged with the caller's and the identity file's. */
export function identityEntries(options: IdentityOptions = {}): IdentityEntry[] {
  const users = [safe(() => userInfo().username), ...(options.users ?? [])].filter(
    (u) => fold(u).length >= IDENTITY_MIN_CHARS && !GENERIC_ACCOUNTS.has(u.toLowerCase()),
  );
  const hosts = [safe(hostname), ...(options.hosts ?? [])]
    .map((h) => h.split(".")[0] ?? "")
    .filter((h) => h.length >= 4 && h.toLowerCase() !== "localhost");
  const configured =
    options.identityFile === undefined
      ? []
      : identityFileLines(options.identityFile).filter((l) => fold(l).length >= IDENTITY_MIN_CHARS);
  return [
    ...[...new Set(users)].map((u): IdentityEntry => ["username", u]),
    ...[...new Set(hosts)].map((h): IdentityEntry => ["hostname", h]),
    ...[...new Set(configured)].map((c): IdentityEntry => ["identity", c]),
  ];
}

/** The first identity `value` holds (folded substring), or undefined. */
export function heldIdentity(
  value: string,
  entries: readonly IdentityEntry[],
): IdentityEntry | undefined {
  const v = fold(value);
  return entries.find(([, e]) => {
    const f = fold(e);
    return f.length >= IDENTITY_MIN_CHARS && v.includes(f);
  });
}
