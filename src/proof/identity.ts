/**
 * Track Q (replayable proof): the IDENTITY GUARD (#553 round 3, lead ruling 21:52Z).
 *
 * The ruling: a bare host username, or any configured identity string (the account name, a
 * full name, the hostname), is a leak when it appears ON ITS OWN, not only inside a path. The
 * allowlist (`closed.ts`) writes a value that matches a closed grammar as is, and a closed id
 * such as `alice`, `ALICE-run-1` or `run.alice` matches that grammar. So every string the
 * exporter would write as is from its input (ids, arms, the anchor's ledger ids) is first put
 * to this guard, and:
 *
 *  - an id field whose value CONTAINS an identity string, case-insensitively, is digested
 *    (`h-<60hex>`, `hashed.ts`), exactly as a value outside the grammar is (equality stays
 *    checkable);
 *  - a value that cannot be digested because it sits under another chain (the attempt
 *    ledger's ids, carried verbatim) refuses the export (`PROOF_IDENTITY`).
 *
 * The scope is #560's leak guard: host username, home paths, hostnames and key-like strings.
 *  - Configured strings (`IdentityContext`) come from the host at write time
 *    (`os.userInfo().username`, `os.hostname()`, `os.homedir()`), plus the lines of an
 *    optional identity file whose PATH is passed in (a full name, another account name) and
 *    any `--user-file` entries. The values are never printed, logged or put in a message.
 *  - The HOST's identity is ALWAYS part of the guard (#562, fixing #553's final-round D1). A
 *    caller may ADD identity strings (an identity file, `--user-file`, a test's synthetic
 *    names) but can never replace or drop the host's: every guard this module hands out for
 *    writing or verifying is `guardWithHost(extra)`, which is
 *    `compileIdentity(mergeIdentity(hostIdentity(), extra))`, as #560's leak guard does with
 *    `mergeIdentity(hostIdentity(), ...)`. There is no "no identity" export argument.
 *  - "Contains" is matched on a normal form (`identityNormal`), on both sides: NFKC, then
 *    FULL Unicode case folding (#562, fixing #553's final-round D2: plain lower-casing left
 *    `GROSS` unmatched by a configured `Groß`), then every character that is not a letter or a
 *    digit removed. The fold upper-cases then lower-cases until nothing changes, so `ß`, `ẞ`
 *    and `SS` all fold to `ss`, dotless `ı` and `I` fold to `i`, and final `ς` is mapped to `σ`
 *    after the fold (lower-casing picks one from context).
 *    So `Alice`, `ALICE`, `a.l.i.c.e`, `run-alice-1` and `alice_smith` all contain `alice`,
 *    and a full name `First Last` is matched JOINED, as `firstlast` (`FirstLast`,
 *    `first.last`, `first_last`, `First-Last`, `FIRSTLAST`), and by each of its words of
 *    three or more characters (`First` alone). A hostname is matched whole and by its first
 *    DNS label (`box` for `box.local`). A home directory is matched whole and by its last
 *    segment.
 *  - Generic shapes (key-like strings, home-root and other host paths, `DOMAIN\user`,
 *    `user@host`) are the backstop's own patterns (`backstop.ts`), run on the raw value.
 *  - A configured string shorter than `MIN_IDENTITY` characters after normalisation is not
 *    matched (a one-letter needle would match nearly every id); this is stated in the doc.
 *
 * A hit is reported as a CLASS (`identity`, `home-path`, `key-like`) and a location only.
 */
import { readFileSync } from "node:fs";
import { homedir, hostname, userInfo } from "node:os";
import { EMPTY_REDACTION, findLeaks } from "./backstop.ts";

/** What a guard hit is, never what it matched. */
export type IdentityClass = "identity" | "home-path" | "key-like";

/** The configured identity strings. Values only ever flow into `compileIdentity`. */
export interface IdentityContext {
  /** Account names, full names, hostnames: matched whole and by part (see above). */
  readonly names: readonly string[];
  /** Home directories: matched whole and by their last segment. */
  readonly homes: readonly string[];
}

/** No configured strings. Internal: it is never an export or verify argument (#562, D1). */
const EMPTY_IDENTITY: IdentityContext = { names: [], homes: [] };

/** The union of several identity contexts (order kept, duplicates dropped). */
export function mergeIdentity(...ctxs: readonly (IdentityContext | undefined)[]): IdentityContext {
  const names = new Set<string>();
  const homes = new Set<string>();
  for (const c of ctxs) {
    if (c === undefined) continue;
    for (const n of c.names) names.add(n);
    for (const h of c.homes) homes.add(h);
  }
  return { names: [...names], homes: [...homes] };
}

/** Needles shorter than this (after normalisation) are not matched. */
export const MIN_IDENTITY = 2;
/** A word of a multi-word name is matched alone from this length. */
export const MIN_NAME_PART = 3;

/**
 * Full Unicode case folding by round trip: upper-case then lower-case, repeated until the
 * value stops changing (at most a few passes). `ẞ` needs two: `ẞ` -> `ß` -> `ss`.
 */
export function caseFold(text: string): string {
  let cur = text.normalize("NFKC");
  for (let i = 0; i < 4; i++) {
    const next = cur.toUpperCase().toLowerCase().normalize("NFKC");
    if (next === cur) break;
    cur = next;
  }
  // JS lower-casing picks final `ς` or `σ` from context, so `Νίκος` alone ends in `ς` but
  // `ΝίκοςTrial` folds to `...σtrial`. Map `ς` to `σ` so both sides agree (#562 r1 nit).
  return cur.replace(/ς/g, "σ");
}

/** NFKC, full case folding, letters and digits only. */
export function identityNormal(text: string): string {
  return caseFold(text).replace(/[^\p{L}\p{N}]+/gu, "");
}

export interface IdentityGuard {
  /** The class of the first thing `value` carries, or null. Never the matched text. */
  readonly hit: (value: string) => IdentityClass | null;
}

/** A guard that matches only the generic shapes (no configured strings). */
export const SHAPES_ONLY: IdentityGuard = compileIdentity(EMPTY_IDENTITY);

/** Build the guard. The returned function closes over the needles; nothing else keeps them. */
export function compileIdentity(ctx: IdentityContext): IdentityGuard {
  const needles = new Map<string, IdentityClass>();
  const add = (raw: string, cls: IdentityClass, min = MIN_IDENTITY) => {
    const n = identityNormal(raw);
    if (n.length >= min && !needles.has(n)) needles.set(n, cls);
  };
  for (const name of ctx.names) {
    add(name, "identity");
    const words = name.trim().split(/\s+/);
    if (words.length > 1) for (const w of words) add(w, "identity", MIN_NAME_PART);
    const label = name.split(".")[0];
    if (label !== undefined && label !== name) add(label, "identity");
  }
  for (const home of ctx.homes) {
    add(home, "home-path");
    const last = home
      .split(/[\\/]+/)
      .filter((s) => s.length > 0)
      .at(-1);
    if (last !== undefined) add(last, "home-path");
  }
  const list = [...needles.entries()];
  return {
    hit(value: string): IdentityClass | null {
      const v = identityNormal(value);
      for (const [n, cls] of list) if (v.includes(n)) return cls;
      for (const leak of findLeaks(value, EMPTY_REDACTION)) {
        if (leak.kind === "secret" || leak.kind === "vault-key") return "key-like";
        if (leak.kind === "host-path") return "home-path";
        return "identity";
      }
      return null;
    },
  };
}

/** One literal per non-empty line of a file (its contents are never printed). */
export function readIdentityLines(path: string | undefined): string[] {
  if (path === undefined) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/**
 * The writing host's identity: its account name, hostname and home directory, plus the
 * lines of `identityFile` (a full name, other names; the PATH is passed, never a value) and
 * any extra names (`--user-file`).
 */
export function hostIdentity(
  opts: { identityFile?: string; names?: readonly string[] } = {},
): IdentityContext {
  const names: string[] = [];
  try {
    names.push(userInfo().username);
  } catch {
    // No account name to add.
  }
  try {
    names.push(hostname());
  } catch {
    // No hostname to add.
  }
  names.push(...readIdentityLines(opts.identityFile), ...(opts.names ?? []));
  let home = "";
  try {
    home = homedir();
  } catch {
    home = "";
  }
  return {
    names: names.filter((n) => n.length > 0),
    homes: home.length > 1 ? [home] : [],
  };
}

/**
 * The guard every write and verify path uses: the writing host's identity (`hostIdentity()`)
 * MERGED with whatever the caller adds. A caller's identity can only add strings; it never
 * replaces the host's (#562, D1).
 */
export function guardWithHost(extra?: IdentityContext): IdentityGuard {
  return compileIdentity(mergeIdentity(hostIdentity(), extra));
}
