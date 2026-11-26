/**
 * Track Q test helper (#562): does an output carry an identity string? Returns a BOOLEAN and
 * never a value, so no identity string can reach a test log or an assertion message.
 *
 * Structural, against a NEUTRAL output of the same shape: a string (value or key) that differs
 * from the neutral one at the same place is value-derived, and it must not contain any needle
 * in a folded normal form (`foldForCheck`: NFKC, full case folding, letters and digits
 * only), unless it is a digest (`h-<64hex>` or 64 hex). Comparing against the neutral output
 * keeps constants of the format (key names, the claim) out of the check, so this holds for
 * needles of any length, even a 2-character hostname.
 */
const DIGEST = /^(?:h-)?[0-9a-f]{64}$/;

/**
 * The checker's OWN normal form, independent of `identityNormal` (so a mutant of the code
 * under test cannot weaken the check): NFKC, upper/lower round trip three times (`ẞ` -> `ß`
 * -> `ss`), letters and digits only.
 */
export function foldForCheck(s: string): string {
  let v = s.normalize("NFKC");
  for (let i = 0; i < 3; i++) v = v.toUpperCase().toLowerCase().normalize("NFKC");
  return v.replace(/[^\p{L}\p{N}]+/gu, "");
}

export function carriesIdentity(
  planted: unknown,
  neutral: unknown,
  needles: readonly string[],
): boolean {
  const ns = needles.map(foldForCheck).filter((n) => n.length >= 2);
  let found = false;
  const check = (s: string) => {
    if (found || DIGEST.test(s)) return;
    const v = foldForCheck(s);
    if (ns.some((n) => v.includes(n))) found = true;
  };
  const walk = (p: unknown, n: unknown) => {
    if (typeof p === "string") {
      if (p !== n) check(p);
    } else if (Array.isArray(p)) {
      p.forEach((x, i) => {
        walk(x, Array.isArray(n) ? n[i] : undefined);
      });
    } else if (p !== null && typeof p === "object") {
      const no = n !== null && typeof n === "object" ? (n as Record<string, unknown>) : {};
      for (const [k, x] of Object.entries(p)) {
        if (!(k in no)) check(k);
        walk(x, no[k]);
      }
    }
  };
  walk(planted, neutral);
  return found;
}
