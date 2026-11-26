/**
 * Identity strings in an export (lead ruling 2026-11-26 21:52Z): a bare host username, the host
 * name, or any configured identity string (a full name, say) is a LEAK wherever it appears in an
 * exported episode, alone or in a path, in any field, the closed id and token fields included
 * (`task.id`, `provenance.runId`, `harness.plannerModelId`, key and app names). The export fails
 * closed on one: it is refused, naming the JSON path and the class, never the value.
 *
 * Scope, matching the shared leak guard (#560, `src/leak-guard/detect.ts`):
 *  - `username`: the host account name (`os.userInfo().username`), at least 3 characters and not
 *    a generic account (`root`, `runner`, ...: their home paths are caught as paths);
 *  - `hostname`: the host name's first DNS label (`os.hostname()`), at least 4 characters, not
 *    `localhost`;
 *  - `identity`: each line of an optional identity file passed by path (a full name, another
 *    account), at least 3 characters.
 * Matching is case-insensitive and by SUBSTRING, so joined forms are caught too: `<name>_trial`,
 * `<name>.x`, `t-<name>-1`, `<Name>2`, `xx<name>`, `<name>Trial`. It runs over every string the
 * export keeps verbatim (closed.ts, `joinedIdentity`). An id or token holding one is DIGESTED,
 * and any other closed pattern field holding one (a task family, a task-set id, a version)
 * REFUSES the export, as does the export filter. Free text is always digested. Enum values and
 * digests are exempt: they are fixed vocabulary or hex, so a substring match there would only be a
 * false refusal (a hex-only name inside a digest, an account named like an enum word). The host values are
 * read at export time from `os`, never from the environment, and always included, whatever host
 * facts the caller passes: a fake host in a test does not switch the real check off.
 */
import { readFileSync } from "node:fs";
import { hostname, userInfo } from "node:os";

export type IdentityClass = "username" | "hostname" | "identity";

export interface IdentityIssue {
  readonly class: IdentityClass;
  /** JSON path of the string (never the string). */
  readonly path: string;
}

/** Account names too generic to look for as a word (as #560). */
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

export interface IdentityOptions {
  /** Extra account names (tests plant them; the host's own is always added). */
  readonly users?: readonly string[];
  /** Extra host names (the host's own is always added). */
  readonly hosts?: readonly string[];
  /** A file of identity strings, one per line (blank lines and `#` comments ignored). */
  readonly identityFile?: string;
}

/** An identity string and its class (lower-cased for joined-form matching; never printed). */
export type IdentityEntry = readonly [IdentityClass, string];

/** The identity strings: the host's (always), plus the caller's and the identity file's. */
export function identityEntries(options: IdentityOptions = {}): IdentityEntry[] {
  const users = [safe(() => userInfo().username), ...(options.users ?? [])].filter(
    (u) => u.length >= 3 && !GENERIC_ACCOUNTS.has(u.toLowerCase()),
  );
  const hosts = [safe(hostname), ...(options.hosts ?? [])]
    .map((h) => h.split(".")[0] ?? "")
    .filter((h) => h.length >= 4 && h.toLowerCase() !== "localhost");
  const configured =
    options.identityFile === undefined
      ? []
      : readFileSync(options.identityFile, "utf8")
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter((l) => l.length >= 3 && !l.startsWith("#"));
  return [
    ...[...new Set(users)].map((u): IdentityEntry => ["username", u]),
    ...[...new Set(hosts)].map((h): IdentityEntry => ["hostname", h]),
    ...[...new Set(configured)].map((c): IdentityEntry => ["identity", c]),
  ];
}
