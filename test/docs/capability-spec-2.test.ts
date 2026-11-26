/**
 * docs/product/capability-spec-2.md is part 2 of the capability pre-registration (N-V and the
 * episode format). These tests pin the parts that must not drift silently:
 *  - every capability N-V and data capture keeps each required part;
 *  - the capabilities with no natural improvement statistic say they use a property bar;
 *  - the zero-event upper-bound table is the exact Clopper-Pearson bound it claims;
 *  - the scope override, the priority lock, #518's threat model limit and the other binding
 *    lines stay word for word.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const RAW = readFileSync(
  join(import.meta.dirname, "../../docs/product/capability-spec-2.md"),
  "utf8",
);

/** Whitespace-collapsed, so a re-wrapped paragraph does not fail a content check. */
const flat = (s: string) => s.replace(/\s+/g, " ");
const DOC = flat(RAW);

const CAPABILITIES = ["N", "O", "P", "Q", "R", "S", "T", "U", "V"] as const;

const REQUIRED_PARTS = [
  "**What it is.**",
  "**What it is not.**",
  "**Agent-facing surface",
  "**Arms.**",
  "**Task set",
  "**Primary metric",
  "**Pre-registered bar",
  "**Guardrails",
  "**Builder alignment",
] as const;

/** Text from `heading` to the next heading of level 2 or 3. */
function sectionFrom(heading: string): string {
  const start = RAW.indexOf(`\n${heading}`);
  if (start < 0) return "";
  const rest = RAW.slice(start + 1);
  const next = rest.slice(4).search(/\n#{2,3} /);
  return flat(next < 0 ? rest : rest.slice(0, next + 4));
}

const section = (id: string) => sectionFrom(`### ${id}. `);
const dataCapture = () => sectionFrom("## 3. Data capture");
/** The bar and everything after it, so a bar cannot be satisfied by text in "What it is". */
const barOf = (text: string) => text.slice(text.indexOf("**Pre-registered bar"));

describe("capability spec part 2: structure", () => {
  for (const id of CAPABILITIES) {
    it(`capability ${id} has every required part`, () => {
      const text = section(id);
      expect(text, `section ### ${id}. missing`).not.toBe("");
      for (const part of REQUIRED_PARTS) expect(text, `${id}: ${part}`).toContain(part);
    });
  }

  it("data capture has every required part", () => {
    const text = dataCapture();
    expect(text).not.toBe("");
    for (const part of REQUIRED_PARTS) expect(text, part).toContain(part);
  });

  it.each(["N", "P", "R", "T", "V"])("capability %s's bar is an exact McNemar test", (id) => {
    expect(barOf(section(id))).toMatch(/Exact one-sided McNemar.*p ≤ 0\.05/s);
    expect(barOf(section(id))).toContain("at least 5 discordant");
  });

  it.each(["O", "U"])("capability %s's bar has a non-inferiority component", (id) => {
    expect(barOf(section(id))).toContain("non-inferior");
  });

  it.each(["Q", "S", "T"])("capability %s declares a property bar, not a statistic", (id) => {
    expect(section(id)).toContain("**Property bar (§1.1)");
    expect(barOf(section(id))).toContain("(property, all must hold)");
    expect(barOf(section(id))).toContain("every mutant killed");
  });

  it("U's export half and data capture declare property bars", () => {
    expect(section("U")).toContain("**The export half has a property bar (§1.1)**");
    expect(barOf(section("U"))).toContain("**Export (property, all must hold):**");
    expect(dataCapture()).toContain("**Property bar (§1.1):**");
  });
});

describe("capability spec part 2: binding content per track", () => {
  it("reuses Part 1's shared rules by reference", () => {
    expect(DOC).toContain("`docs/product/capability-spec.md` (PR #525, in review)");
    expect(DOC).toContain("**by reference and does not restate or change them**");
  });

  it("N: zero unsafe proceeds, no self-approval, handoff rows never R1", () => {
    expect(section("N")).toContain("**N3 unsafe proceed = 0:**");
    expect(section("N")).toContain("the agent channel has no resolve verb");
    expect(section("N")).toContain("never counts toward R1");
  });

  it("O: zero violations, benign non-inferiority, host-side and fail closed", () => {
    expect(barOf(section("O"))).toContain("**Zero violations** in `B+O`");
    expect(section("O")).toContain("Host-side enforcement");
    expect(section("O")).toContain("**Fail closed:**");
    expect(section("O")).toContain("**independent violation checker**");
  });

  it("Q: tamper-evident exactly as far as #518's threat model", () => {
    const q = section("Q");
    expect(q).toContain("**Tamper-evident exactly as far as #518's ruled threat model, and no");
    expect(q).toContain(
      "The adversary is the checked agent and any guest-side process; the harness that",
    );
    expect(q).toContain("writes bundles is trusted.");
    expect(q).toContain("**It is not proof against a malicious pack author**");
    expect(barOf(q)).toContain("100% of in-scope tamper cases are refused");
    expect(barOf(q)).toContain('"not proof against a malicious pack author"');
  });

  it("R and T require R5's mutation self-test", () => {
    expect(section("R")).toContain("**A derived oracle must pass R5's mutation self-test**");
    expect(section("T")).toContain(
      "**R5 is required: a family's oracle must pass the mutation self-test**",
    );
  });

  it("S: triggers never bypass policy and never take critical-path VM time", () => {
    expect(barOf(section("S"))).toContain("Triggers never bypass policy");
    expect(barOf(section("S"))).toContain("**0 bypasses:**");
    expect(section("S")).toContain("Not allowed to take VM time from the critical path");
  });

  it("U: merged with Lightweight agent desktops, dataset export of verified runs", () => {
    expect(DOC).toContain("### U. Linux scale track, merged with Lightweight agent desktops");
    expect(barOf(section("U"))).toContain("**Zero leaked markers** across `exp-v1`");
  });

  it("V: budget, depth cap, max concurrent desktops and kill switch are all mandatory", () => {
    const v = section("V");
    expect(v).toContain("Four controls are **mandatory**");
    for (const control of [
      "**budget**",
      "**depth cap**",
      "**maximum number of concurrent desktops**",
      "**kill switch**",
    ])
      expect(v, control).toContain(control);
  });

  it("data capture: Tiffany's six groups, no secrets, no raw Sai ledger", () => {
    const dc = dataCapture();
    expect(dc).toContain(
      "**task, actions, screenshots/state, oracle verdict, ground truth, harness metadata; no secrets, no raw Sai ledger.**",
    );
    for (const group of [
      "| Task |",
      "| Actions |",
      "| Screenshots/state |",
      "| Oracle verdict |",
      "| Ground truth |",
      "| Harness metadata |",
    ])
      expect(dc, group).toContain(group);
    expect(barOf(dc)).toContain("**Zero leaked markers**");
    expect(barOf(dc)).toContain("No raw Sai ledger");
  });
});

describe("capability spec part 2: builder alignment", () => {
  it.each([
    ["N", "#528"],
    ["P", "#535"],
    ["Q", "#533"],
    ["R", "#532"],
    ["S", "#536"],
    ["T", "#537"],
    ["U", "#531"],
    ["V", "#534"],
  ])("capability %s aligns with builder PR %s", (id, pr) => {
    expect(section(id)).toContain(`**Builder alignment (${pr}).**`);
  });

  it("Q adopts #533's 300-case tamper battery and keeps the property bar", () => {
    expect(section("Q")).toContain("at least **300** cases");
    expect(section("Q")).toContain("this spec keeps the property bar as Q's acceptance bar");
  });
});

describe("capability spec part 2: zero-event bound table", () => {
  const rows = [...RAW.matchAll(/^ {2}\| (\d+) \| (0\.\d{4}) \|$/gm)];

  it("has the table", () => {
    expect(rows.length).toBeGreaterThanOrEqual(6);
  });

  it("each row is the exact one-sided 95% Clopper-Pearson bound for 0 events in n", () => {
    for (const [, nText, bText] of rows) {
      const n = Number(nText);
      expect(bText, `n=${n}`).toBe((1 - 0.05 ** (1 / n)).toFixed(4));
    }
  });

  it("every bound quoted in a bar matches its row", () => {
    const table = new Map(rows.map(([, n, b]) => [Number(n), b]));
    expect(barOf(section("O"))).toContain(`zero-event bound ${table.get(60)}`);
    expect(barOf(section("U"))).toContain(`zero- event bound ${table.get(200)}`);
  });
});

describe("capability spec part 2: binding lines", () => {
  it.each([
    "Priority (Tiffany 10:46 ET): critical path is integrity fixes -> trial run (R1, hcu+shell head-to-head, corrections A/B on Ultra) -> 90 s demo; nothing may delay those or take VM time from them.",
    "**Scope override (Tiffany, 10:41 ET).** All tracks I-V are M2 scope and are built now, in parallel.",
    "It does not change when anything is **measured**",
    "**No track here adds a field to `myco.gate/v1`.**",
    "never billed USD",
    "null never 0",
    "**Claude Ultra only**",
    "**Codex is gated**",
    "**No runs until GO**",
    "3-round review cap",
    "**No public leaderboard**",
    "nothing here builds billing, accounts or hosting",
  ])("keeps %j", (line) => {
    expect(DOC).toContain(line);
  });

  it("claims no result, quotes no price beyond $0, and mentions a leaderboard only to rule it out", () => {
    expect(DOC).toContain("no result is claimed");
    expect(DOC.match(/\$\d[\d.,]*/g) ?? []).toEqual(["$0"]);
    expect(DOC.match(/leaderboard/gi)).toEqual(["leaderboard"]);
  });

  it("does not touch the integrity fixes' files", () => {
    expect(DOC).toContain("No N-V track touches their files or branches");
  });
});
