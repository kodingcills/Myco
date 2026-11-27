/**
 * ACCENT FOLDING for identity matching, shared by every export surface (#579 O2; the episode
 * export `src/episode/identity.ts`, track U's `src/dataset/closed.ts`, track Q's
 * `src/proof/identity.ts`).
 *
 * Each surface already folds case fully (NFKC, upper then lower case: `ß`/`ẞ` -> `ss`, `ı`/`İ`
 * -> `i`). On top of that, identity matching now also matches ASCII transliterations and
 * accent-stripped forms, on BOTH sides (the configured identity and the value): Unicode NFD,
 * then every combining mark removed, then a few Latin letters NFD does not split mapped to their
 * usual ASCII spelling. So a configured `josé` matches `JOSE`, `…reña` matches `…rena`, and
 * `Søren` matches `soren`, in any case and in any joined form.
 *
 * Folding more can only add matches (a false refusal at worst, never a leak). Imports nothing.
 */

/** Latin letters with no NFD decomposition, and their ASCII spelling (applied after case folding). */
const TRANSLITERATE: Readonly<Record<string, string>> = {
  æ: "ae",
  œ: "oe",
  ø: "o",
  ł: "l",
  đ: "d",
  ð: "d",
  þ: "th",
  ħ: "h",
};
const TRANSLITERABLE = new RegExp(`[${Object.keys(TRANSLITERATE).join("")}]`, "gu");

/**
 * The accent-stripped form of an already case-folded string: NFD, combining marks removed,
 * the letters above transliterated, then NFC again (so what is left compares stably).
 */
export function stripAccents(folded: string): string {
  return folded
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .replace(TRANSLITERABLE, (c) => TRANSLITERATE[c] ?? c)
    .normalize("NFC");
}
