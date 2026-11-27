/**
 * IDENTITY MATCHING shared by every export surface (#580 O1, lead ruling 02:55Z): the episode
 * export (`src/episode/identity.ts`, `closed.ts`), track U's container (`src/dataset/closed.ts`)
 * and track Q's bundles (`src/proof/identity.ts`). One fold and one rule for which parts of a
 * configured string are looked for, so the three surfaces cannot drift apart.
 *
 *  - `identityFold`: NFKC, then FULL Unicode case folding (upper-case then lower-case until the
 *    value stops changing, so `ß`, `ẞ` and `SS` all fold to `ss`, dotless `ı` and `İ` to `i`;
 *    final `ς` mapped to `σ` after the fold, because lower-casing picks one from context), then
 *    accents stripped (#579 O2, `stripAccents`), then letters and digits only. Both sides (the
 *    configured string and the value) fold.
 *  - `identityNeedles`: the folded forms looked for, by substring, for one configured string:
 *    the WHOLE string (a full name matches every joined form, `FirstLast`, `first.last`,
 *    `First-Last`), and, when it has several whitespace-separated words, EACH WORD of at least
 *    `IDENTITY_WORD_MIN_CHARS` (3) folded characters ALONE (#553/#562's rule, now on every
 *    surface). So with `First Last` configured, `<first>_trial`, `<Last>2`, `xx<first>`,
 *    `<first>Trial` and `runFirst` all match; a word of 1 or 2 characters (`Al`, `Li`) is not
 *    looked for alone (it would match nearly every id).
 *
 * Words are split on whitespace only: a host name or account (`my-box`, `j.smith`) is one word
 * and is matched whole, as before. The generic-account exclusions (#560's list) apply to the
 * account source on each surface and are unchanged; a word of a configured full name is never
 * exempted (a false refusal at worst, never a leak).
 *
 * Imports nothing outside `src/export-guard` (and nothing from `src/benchmark`).
 */
import { stripAccents } from "./fold.ts";

/** A word of a multi-word configured string is matched alone from this many folded characters. */
export const IDENTITY_WORD_MIN_CHARS = 3;

/** Full Unicode case folding by round trip (see the module comment). */
export function caseFold(text: string): string {
  let cur = text.normalize("NFKC");
  for (let i = 0; i < 4; i++) {
    const next = cur.toUpperCase().toLowerCase().normalize("NFKC");
    if (next === cur) break;
    cur = next;
  }
  return cur.replace(/ς/g, "σ");
}

/** The form identity matching compares (both sides): case and accents folded, letters and digits. */
export function identityFold(text: string): string {
  return stripAccents(caseFold(text)).replace(/[^\p{L}\p{N}]+/gu, "");
}

/**
 * The folded needles for one configured string: the whole string when it has at least
 * `wholeMin` folded characters, and each whitespace-separated word of at least
 * `IDENTITY_WORD_MIN_CHARS` folded characters when there are several words. Never printed.
 */
export function identityNeedles(raw: string, wholeMin: number): string[] {
  const out: string[] = [];
  const whole = identityFold(raw);
  if (whole.length >= wholeMin) out.push(whole);
  const words = raw.trim().split(/\s+/);
  if (words.length > 1)
    for (const w of words) {
      const f = identityFold(w);
      if (f.length >= IDENTITY_WORD_MIN_CHARS && !out.includes(f)) out.push(f);
    }
  return out;
}

/** A configured entry: a class or kind, and the configured string (never printed). */
export type IdentityPair = readonly [string, string];

/**
 * The needles of each entry of one entry list, computed once per list and wholeMin. Keyed on
 * the list object (a WeakMap): nothing outlives the caller's list.
 */
const NEEDLES = new WeakMap<readonly IdentityPair[], { min: number; needles: string[][] }>();
function needlesOf(entries: readonly IdentityPair[], wholeMin: number): string[][] {
  const hit = NEEDLES.get(entries);
  if (hit !== undefined && hit.min === wholeMin) return hit.needles;
  const needles = entries.map(([, raw]) => identityNeedles(raw, wholeMin));
  NEEDLES.set(entries, { min: wholeMin, needles });
  return needles;
}

/**
 * The indices (in order) of every entry `value` holds: the folded value contains the entry's
 * whole folded string, or one of its words of 3+ characters (`identityNeedles`).
 */
export function heldEntries(
  value: string,
  entries: readonly IdentityPair[],
  wholeMin: number,
): number[] {
  const v = identityFold(value);
  const out: number[] = [];
  for (const [i, ns] of needlesOf(entries, wholeMin).entries())
    if (ns.some((n) => v.includes(n))) out.push(i);
  return out;
}
