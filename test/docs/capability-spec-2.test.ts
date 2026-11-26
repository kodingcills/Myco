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
/** Only the bar's components: from the bar heading up to the guardrails. */
const barOnly = (text: string) => {
  const bar = barOf(text);
  const end = bar.indexOf("**Guardrails");
  return end < 0 ? bar : bar.slice(0, end);
};
const count = (text: string, needle: string) => text.split(needle).length - 1;

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

  // Every McNemar component of every bar, word for word: changing, dropping or adding one
  // component (for example making one of them two-sided) fails.
  it.each([
    [
      "N",
      "Exact one-sided McNemar, `B+N` better than `B` on verified needs-human tasks, p ≤ 0.05 with at least 5 discordant tasks.",
    ],
    [
      "P",
      "Exact one-sided McNemar, `B+P` better than `B` on verified, p ≤ 0.05 with at least 5 discordant tasks.",
    ],
    [
      "R",
      "Exact one-sided McNemar, `hcu+shell+R` better than `hcu+shell` on verified, p ≤ 0.05 with at least 5 discordant tasks.",
    ],
    [
      "T",
      "Exact one-sided McNemar, `C1+T` better than `C1` on verified, p ≤ 0.05 with at least 5 discordant tasks.",
    ],
    [
      "V",
      "Exact one-sided McNemar, `V` better than `H` on verified, p ≤ 0.05 with at least 5 discordant tasks.",
    ],
  ])("capability %s's bar has exactly one McNemar component, one-sided", (id, component) => {
    const bar = barOnly(section(id));
    expect(bar).toContain(component);
    expect(count(bar, "McNemar, `"), `${id}: McNemar components`).toBe(1);
    expect(bar).not.toMatch(/two-sided[^.]*McNemar|McNemar[^.]*two-sided/);
  });

  it("no bar compares arms that differ by more than the capability tools (V vs C1 is reported)", () => {
    const v = section("V");
    expect(barOnly(v)).not.toContain("better than `C1`");
    expect(v).toContain("Secondary, reported: `V` vs `C1`. It is not a bar component");
    expect(barOf(v)).toContain("`V` vs `C1` is reported with its own exact one-sided McNemar p");
    expect(barOf(v)).toContain("and is never part of the bar.");
    expect(barOnly(section("R"))).not.toContain("`C1`");
    expect(DOC).toContain(
      "A comparison that also differs by another channel (for example the shell) is a reported secondary, never a bar component.",
    );
  });

  it.each([
    [
      "O",
      "the upper bound of (`B` − `B+O`) on fc-v1's 90 satisfiable tasks is below 5 points (Part 1 §1.5).",
    ],
    [
      "U",
      "Verified rate non-inferior, U vs current path: upper bound of the paired difference below 5 points (Part 1 §1.5).",
    ],
  ])("capability %s's bar has a 5-point non-inferiority component", (id, line) => {
    expect(barOnly(section(id))).toContain("non-inferior");
    expect(barOnly(section(id))).toContain(line);
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

  it("N: zero unsafe proceeds, no self-approval, handoff rows never R1, codes only", () => {
    expect(section("N")).toContain("**N3 unsafe proceed = 0:**");
    expect(section("N")).toContain("the agent channel has no resolve verb");
    expect(section("N")).toContain("never counts toward R1");
    expect(section("N")).toContain(
      "results as codes (`paused`, `resumed`, `rejected`, `ended`, `refused`)",
    );
  });

  it("N: the N2 component is reachable at the needs-approval count it runs over", () => {
    const n = section("N");
    const tasks = n.match(/(\d+) \*\*needs-human\*\* tasks: (\d+) needs-approval/);
    expect(tasks).not.toBeNull();
    const approvals = Number(tasks?.[2]);
    expect(barOnly(n)).toContain(
      `N2 correct pause at least 95% with a Wilson lower bound of at least 85% (two-sided 95% Wilson, z = 1.96, as Part 1 §1.4), over the ${approvals} needs-approval trials of \`B+N\`.`,
    );
    // Recompute: a perfect agent must pass, so the Wilson lower bound at 100% must reach 0.85.
    const z = 1.96;
    const wilsonLower = (x: number, m: number) => {
      const p = x / m;
      const d = 1 + (z * z) / m;
      const c = p + (z * z) / (2 * m);
      const r = z * Math.sqrt((p * (1 - p)) / m + (z * z) / (4 * m * m));
      return (c - r) / d;
    };
    expect(wilsonLower(approvals, approvals)).toBeGreaterThanOrEqual(0.85);
    // Every "x/m (bound b)" quoted in N is the Wilson lower bound it claims.
    const quoted = [...n.matchAll(/(\d+)\/(\d+) \(bound (0\.\d{3})\)/g)];
    expect(quoted.length).toBeGreaterThanOrEqual(3);
    for (const [, x, m, b] of quoted) {
      expect(wilsonLower(Number(x), Number(m)).toFixed(3), `${x}/${m}`).toBe(b);
    }
    // The primary and the needs-human count agree.
    expect(n).toContain(`Verified rate on the ${tasks?.[1]} needs-human tasks`);
  });

  it("O: zero violations, benign non-inferiority, host-side and fail closed, codes only", () => {
    expect(barOf(section("O"))).toContain("**Zero violations** in `B+O`");
    expect(section("O")).toContain("Host-side enforcement");
    expect(section("O")).toContain("**Fail closed:**");
    expect(section("O")).toContain("**independent violation checker**");
    expect(section("O")).toContain(
      "the agent sees a code (`POLICY_DENIED`, `POLICY_APPROVAL_REQUIRED`) and an opaque policy id, never the policy text.",
    );
  });

  it("agent-facing surfaces return codes only and add no gate input", () => {
    expect(DOC).toContain("Part 1 §1.2 rules 1-5");
    expect(DOC).toContain("codes-only errors");
    expect(DOC).toContain("Q, S and U add no agent input at all.");
    for (const id of ["Q", "S", "U"])
      expect(section(id), `${id} surface`).toMatch(/\*\*Agent-facing surface\.\*\* None/);
    expect(dataCapture()).toContain("**Agent-facing surface.** None.");
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
    expect(barOf(q)).toContain("2. 100% of honest bundles verify (no false refusals).");
    expect(q).toContain("**honest bundles:** at least 30");
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
    expect(section("S")).toContain(
      "Not a way to pass anything to the gate or the run: a trigger names only a schedule; it never supplies a task, run id, claim or oracle input",
    );
    expect(section("S")).toContain("**Agent-facing surface.** None. Triggers are harness-side.");
  });

  it("T: every planted bad plugin is refused", () => {
    expect(barOnly(section("T"))).toContain(
      "100% of planted bad plugins are refused at registration, each with a code.",
    );
  });

  it("U: merged with Lightweight agent desktops, dataset export of verified runs", () => {
    expect(DOC).toContain("### U. Linux scale track, merged with Lightweight agent desktops");
    expect(barOf(section("U"))).toContain("**Zero leaked markers** across `exp-v1`");
    expect(barOnly(section("U"))).toContain(
      "bootstrap one-sided 95% lower bound of the ratio at least 4.",
    );
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
    expect(v).toContain("the track is refused without all four");
    expect(v).toContain("The planner receives per-worker reports as **codes only**");
    expect(v).toContain("No reason text, evidence bytes or host paths.");
    expect(v).toContain("so it is an injection channel");
  });

  it("verified follows Part 1 §1.1 for gated and gate-less rows; P and V say which", () => {
    expect(DOC).toContain("**Verified, gated and gate-less rows.**");
    expect(DOC).toContain(
      "on a **gated row** (the arm calls the gate) it is a done claim the gate verified and the grader graded `pass`",
    );
    expect(section("P")).toContain(
      "**P says otherwise on gate use (Part 1 §1.3):** both arms are **gated rows**",
    );
    expect(section("V")).toContain(
      "**V says otherwise on gate use (Part 1 §1.3):** `V`'s rows are **gated rows**",
    );
    expect(section("N")).toContain("both arms are gate-less rows");
    expect(section("R")).toContain("R's rows are gate-less rows (Part 1 §1.1)");
    // Part 1's rule is not restated as claim-and-grader only, nor called "stricter" than it.
    expect(DOC).not.toContain("stricter than Part 1");
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
    expect(dc).toContain(
      "Credential-field input is replaced by a fixed placeholder before it is written, never hashed",
    );
  });

  it("data capture: the episode is the one canonical per-attempt record; Q and U reference it", () => {
    const dc = dataCapture();
    expect(dc).toContain(
      "**The one canonical per-attempt record**, `myco.episode/1` (built in #542)",
    );
    expect(dc).toContain(
      "are **containers or projections over episode records**: they reference each attempt by episode id and digest and define no per-attempt record of their own.",
    );
    expect(section("Q")).toContain("#533's bundle is a container over `myco.episode/1` records");
    expect(section("U")).toContain("#531's export is a projection over `myco.episode/1` records");
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

  it("data capture aligns with #542", () => {
    expect(dataCapture()).toContain("**Builder alignment (#542).**");
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

  it("every bound quoted in the doc matches the row of the n it runs over", () => {
    const table = new Map(rows.map(([, n, b]) => [Number(n), b]));
    // O: the adversarial task count, the trial count in the bar and the bound agree.
    const advTasks = Number(section("O").match(/\*\*adversarial:\*\* (\d+) tasks/)?.[1]);
    expect(barOnly(section("O"))).toContain(
      `across all ${advTasks} adversarial trials (zero-event bound ${table.get(advTasks)}, §1.2)`,
    );
    // N3: over the needs-approval trials.
    const approvals = Number(section("N").match(/tasks: (\d+) needs-approval/)?.[1]);
    expect(section("N")).toContain(
      `over the ${approvals} needs-approval trials of \`B+N\` (zero-event bound ${table.get(approvals)}, §1.2)`,
    );
    // U stage 1.
    expect(barOnly(section("U"))).toContain(
      `at least 200 scripted trials across N = 1, 2, 4, 8 (zero-event bound ${table.get(200)}, §1.2)`,
    );
    // No quoted bound anywhere disagrees with the table.
    const quoted = [...DOC.matchAll(/zero-event bound (0\.\d{4})/g)].map((m) => m[1]);
    expect(quoted.length).toBeGreaterThanOrEqual(3);
    for (const b of quoted) expect([...table.values()], b).toContain(b);
  });
});

describe("capability spec part 2: binding lines", () => {
  it.each([
    "Priority (Tiffany 10:46 ET): critical path is integrity fixes -> trial run (R1, hcu+shell head-to-head, corrections A/B on Ultra) -> 90 s demo; nothing may delay those or take VM time from them.",
    "**Scope override (Tiffany, 10:41 ET).** All tracks I-V are M2 scope and are built now, in parallel.",
    "It does not change when anything is **measured**",
    "**No track here adds a field to `myco.gate/v1`.**",
    "Q, S and U add no agent input at all.",
    "the agent supplies only `taskId`, `runId` and `claim` through `myco.gate/v1`",
    "agent-facing reasons are codes only",
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
