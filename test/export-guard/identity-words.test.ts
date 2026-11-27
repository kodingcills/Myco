/**
 * #603 round 2: the claims the round-1 verdict found unexecuted, now executed.
 *
 *  - D2: the single-word rule (and the fold) is IDENTICAL on the episode export, track U and Q;
 *    for whole strings Q is STRICTER (a 2-character configured string, the first dotted label of
 *    a configured string, no generic-account exemption). Booleans `[episode, U, Q]` pin both.
 *  - D1: no exporter writes the dataset README; the docs say publishing it is a manual step.
 *  - Nit 1: the needle cache follows the list's CONTENT, so a list mutated after first use is
 *    matched against its new entries.
 *  - Nit 2: a configured name separated by NBSP, tab or another Unicode space is split into
 *    words (kills "split on space only"), and format characters (ZWJ, ZWSP, soft hyphen, word
 *    joiner) planted in a value are dropped by the fold (kills "format characters kept").
 *
 * Every planted value is a fake word built at run time; no value is printed (booleans compared).
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { joinedIdentity as uJoined } from "../../src/dataset/closed.ts";
import { identityStrings } from "../../src/dataset/hygiene.ts";
import { joinedIdentity as eJoined } from "../../src/episode/closed.ts";
import { heldIdentity, type IdentityEntry, identityEntries } from "../../src/episode/identity.ts";
import {
  heldEntries,
  type IdentityPair,
  identityFold,
  identityNeedles,
} from "../../src/export-guard/identity-words.ts";
import { compileIdentity } from "../../src/proof/identity.ts";

const made: string[] = [];
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});
function identityFile(...lines: string[]): string {
  const d = mkdtempSync(join(tmpdir(), "myco-eg-iw-"));
  made.push(d);
  const p = join(d, "identity.txt");
  writeFileSync(p, `${lines.join("\n")}\n`);
  return p;
}

const FIRST = ["Qzx", "first"].join("");
const LAST = ["Qzx", "last"].join("");
const FULL = `${FIRST} ${LAST}`;

/** The three surfaces' verdict on `value`, each configured exactly as an exporter would be. */
interface Config {
  readonly lines?: readonly string[];
  readonly account?: string;
}
function surfaces(value: string, cfg: Config): [boolean, boolean, boolean] {
  const file = cfg.lines === undefined ? undefined : identityFile(...cfg.lines);
  // Episode export: identity file lines and extra accounts; a closed field is refused on a hit.
  const eEntries = identityEntries({
    identityFile: file,
    users: cfg.account === undefined ? [] : [cfg.account],
  });
  const episode = eJoined({ task: { taskSetVersion: value } }, eEntries).length > 0;
  // Track U: the same configuration through its hygiene options.
  const uStrings = identityStrings({
    hostIdentity: false,
    identity: { user: cfg.account ?? "zz", host: "zz" },
    ...(file === undefined ? {} : { identityFile: file }),
  });
  const u = uJoined({ task: { taskSetVersion: value } }, uStrings).length > 0;
  // Q: every configured string is a name.
  const q =
    compileIdentity({
      names: [...(cfg.lines ?? []), ...(cfg.account === undefined ? [] : [cfg.account])],
      homes: [],
    }).hit(value) !== null;
  return [episode, u, q];
}

describe("D2: what the three surfaces share and where Q is stricter", () => {
  it("the single-word rule is identical: each word of 3+ characters is held on all three", () => {
    for (const v of [
      `${FIRST.toLowerCase()}_trial`,
      `${LAST}2`,
      `xx${FIRST.toLowerCase()}`,
      `run${LAST.toUpperCase()}`,
    ])
      expect(surfaces(v, { lines: [FULL] })).toEqual([true, true, true]);
    // A 2-character word of a full name is looked for alone on none of them.
    const two = ["Z", "k"].join("");
    expect(surfaces(`${two.toLowerCase()}_trial`, { lines: [`${two} ${LAST}`] })).toEqual([
      false,
      false,
      false,
    ]);
  });

  it("Q also matches a whole configured string of 2 characters; the others start at 3", () => {
    const two = ["Q", "j"].join("");
    expect(surfaces(`${two.toLowerCase()}_t`, { lines: [two] })).toEqual([false, false, true]);
  });

  it("Q also matches the first dotted label of a configured string; the others match it whole", () => {
    const dotted = `${FIRST.toLowerCase()}.${LAST.toLowerCase()}`;
    expect(surfaces(`${FIRST.toLowerCase()}_t`, { lines: [dotted] })).toEqual([false, false, true]);
    // The whole dotted string, in any joined form, is held on all three.
    expect(surfaces(`${FIRST}${LAST}`, { lines: [dotted] })).toEqual([true, true, true]);
  });

  it("the episode export and U exempt #560's generic accounts; Q exempts none", () => {
    expect(surfaces("runner7", { account: "runner" })).toEqual([false, false, true]);
    // A non-generic account is held on all three.
    const acct = ["qzx", "acct"].join("");
    expect(surfaces(`${acct}7`, { account: acct })).toEqual([true, true, true]);
  });
});

describe("D1: the dataset README is published by hand, not by an exporter", () => {
  const root = join(import.meta.dirname, "..", "..");
  const srcFiles = (d: string): string[] =>
    readdirSync(join(root, d), { recursive: true, encoding: "utf8" })
      .filter((f) => f.endsWith(".ts"))
      .map((f) => join(root, d, f));

  it("no exporter (episode, U, Q) references a README", () => {
    for (const d of ["src/episode", "src/dataset", "src/proof"])
      for (const f of srcFiles(d)) expect(/readme/i.test(readFileSync(f, "utf8")), f).toBe(false);
  });

  it("the README and the two format docs say publishing it is a manual release step", () => {
    const readme = readFileSync(join(root, "docs/data/README.md"), "utf8");
    expect(readme).toContain("No exporter writes it");
    expect(readme).toContain("a manual step of the release");
    expect(readme).not.toMatch(/published beside every/);
    for (const doc of ["docs/data/episode-format.md", "docs/product/linux-scale.md"]) {
      const text = readFileSync(join(root, doc), "utf8").replace(/\s+/g, " ");
      expect(text, doc).toContain("no exporter writes that README");
      expect(text, doc).toContain("manual release step");
      expect(text, doc).not.toMatch(/README published beside/);
    }
  });

  it("the README states the shared rule and Q's stricter whole-string rule, not 'the same'", () => {
    const readme = readFileSync(join(root, "docs/data/README.md"), "utf8").replace(/\s+/g, " ");
    expect(readme).not.toContain("The rule is the same on all three surfaces");
    expect(readme).toContain("The single-word rule (and the fold) is identical on all three");
    expect(readme).toContain("Q proof bundles are stricter");
  });
});

describe("nit 1: the needle cache follows the list's content", () => {
  const OTHER_FIRST = ["Qzx", "second"].join("");
  const OTHER = `${OTHER_FIRST} ${["Qzx", "third"].join("")}`;
  const word = (w: string) => `${w.toLowerCase()}_trial`;

  it("an entry pushed, replaced or removed after first use is honoured", () => {
    const list: IdentityPair[] = [["identity", FULL]];
    expect(heldEntries(word(FIRST), list, 3)).toEqual([0]);
    expect(heldEntries(word(OTHER_FIRST), list, 3)).toEqual([]);
    list.push(["identity", OTHER]);
    expect(heldEntries(word(OTHER_FIRST), list, 3)).toEqual([1]);
    list[0] = ["identity", ["Qzx", "fourth"].join("")];
    expect(heldEntries(word(FIRST), list, 3)).toEqual([]);
    expect(heldEntries(["qzx", "fourth"].join(""), list, 3)).toEqual([0]);
    list.pop();
    expect(heldEntries(word(OTHER_FIRST), list, 3)).toEqual([]);
  });

  it("the same holds through a surface (the episode export's heldIdentity)", () => {
    const entries: IdentityEntry[] = [["identity", FULL]];
    expect(heldIdentity(word(OTHER_FIRST), entries)).toBeUndefined();
    entries.push(["identity", OTHER]);
    expect(heldIdentity(word(OTHER_FIRST), entries) !== undefined).toBe(true);
  });
});

describe("nit 2: separators of a configured name and format characters in a value", () => {
  const SEPARATORS = [" ", "\t", " ", "  ", " \t "];

  it("a name separated by NBSP, tab or another Unicode space is split into words", () => {
    for (const [i, sep] of SEPARATORS.entries()) {
      const name = `${FIRST}${sep}${LAST}`;
      const needles = identityNeedles(name, 3);
      expect(needles.includes(identityFold(FIRST)), `sep ${i}`).toBe(true);
      expect(needles.includes(identityFold(LAST)), `sep ${i}`).toBe(true);
      for (const v of [`${FIRST.toLowerCase()}_trial`, `${LAST}2`])
        expect(surfaces(v, { lines: [name] }), `sep ${i}`).toEqual([true, true, true]);
    }
  });

  it("ZWJ, ZWSP, soft hyphen and word joiner inside a planted word are dropped by the fold", () => {
    const list: IdentityPair[] = [["identity", FULL]];
    for (const [i, fmt] of ["‍", "​", "­", "⁠"].entries()) {
      const v = `${FIRST.slice(0, 3)}${fmt}${FIRST.slice(3)}_trial`;
      expect(identityFold(v) === identityFold(`${FIRST}_trial`), `fmt ${i}`).toBe(true);
      expect(heldEntries(v, list, 3), `fmt ${i}`).toEqual([0]);
      expect(surfaces(v, { lines: [FULL] }), `fmt ${i}`).toEqual([true, true, true]);
    }
  });
});
