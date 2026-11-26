/**
 * docs/product/capability-spec.md is a pre-registration document: its bars and its statistics
 * table are what later capability packs are judged against. These tests pin the parts that
 * must not drift silently:
 *  - every capability I-M keeps each required part (what it is and is not, surface, arms,
 *    task set, primary metric, pre-registered bar, guardrails);
 *  - the McNemar critical-value table is the exact one-sided binomial tail it claims;
 *  - the pre-registration rule and the measurement constraints keep their binding lines.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const DOC = readFileSync(
  join(import.meta.dirname, "../../docs/product/capability-spec.md"),
  "utf8",
);

const CAPABILITIES = ["I", "J", "K", "L", "M"] as const;

const REQUIRED_PARTS = [
  "**What it is.**",
  "**What it is not.**",
  "**Agent-facing surface",
  "**Arms.**",
  "**Task set",
  "**Primary metric",
  "**Pre-registered bar",
  "**Guardrails.**",
] as const;

/** The text of capability `id`'s section: from its `### X.` heading to the next heading of level 2 or 3. */
function section(id: string): string {
  const start = DOC.indexOf(`\n### ${id}. `);
  if (start < 0) return "";
  const rest = DOC.slice(start + 1);
  const next = rest.slice(4).search(/\n#{2,3} /);
  return next < 0 ? rest : rest.slice(0, next + 4);
}

/** P(X >= b) for X ~ Binomial(d, 1/2). */
function upperTail(b: number, d: number): number {
  let choose = 1;
  let sum = 0;
  for (let k = 0; k <= d; k++) {
    if (k > 0) choose = (choose * (d - k + 1)) / k;
    if (k >= b) sum += choose;
  }
  return sum / 2 ** d;
}

describe("capability spec: structure", () => {
  for (const id of CAPABILITIES) {
    it(`capability ${id} has every required part`, () => {
      const text = section(id);
      expect(text, `section ### ${id}. missing`).not.toBe("");
      for (const part of REQUIRED_PARTS) expect(text, `${id}: ${part}`).toContain(part);
    });

    it(`capability ${id}'s bar names a test or a threshold and alpha-level rule`, () => {
      const bar = section(id).slice(section(id).indexOf("**Pre-registered bar"));
      expect(bar).toMatch(/McNemar|bootstrap|non-inferior|≥ 2\.8/);
    });
  }

  it("M never stores refuted or uncertain runs", () => {
    expect(section("M")).toContain("`refuted` and `uncertain` runs are never stored");
  });

  it("K keeps every attempt in the attempt ledger", () => {
    expect(section("K")).toContain("stays in #518's attempt ledger");
  });

  it("J logs the route of every action", () => {
    expect(section("J")).toContain("Every action has a route record");
  });

  it("L fails on a single contamination event", () => {
    expect(section("L")).toContain("Zero contamination events");
  });
});

describe("capability spec: statistics table", () => {
  const rows = [...DOC.matchAll(/^ {2}\| (\d+) \| (none|\d+) \| (-|0\.\d{4}) \|$/gm)];

  it("has the table", () => {
    expect(rows.length).toBeGreaterThanOrEqual(6);
  });

  it("each row is the smallest count with one-sided exact p <= 0.05, and that p", () => {
    for (const [, dText, bText, pText] of rows) {
      const d = Number(dText);
      let smallest: number | null = null;
      for (let b = 0; b <= d; b++)
        if (upperTail(b, d) <= 0.05) {
          smallest = b;
          break;
        }
      if (bText === "none") {
        expect(smallest, `d=${d}`).toBeNull();
        expect(pText).toBe("-");
      } else {
        expect(Number(bText), `d=${d}`).toBe(smallest);
        expect(pText, `d=${d}`).toBe(upperTail(Number(bText), d).toFixed(4));
      }
    }
  });

  it("states the minimum of 5 discordant tasks the table implies", () => {
    expect(DOC).toContain("fewer than 5 discordant tasks");
    expect(upperTail(4, 4)).toBeGreaterThan(0.05);
    expect(upperTail(5, 5)).toBeLessThanOrEqual(0.05);
  });
});

describe("capability spec: binding lines", () => {
  it.each([
    "They never\n   count as R1 evidence unless the lead rules otherwise.",
    "**Packs record the hash.**",
    "`myco.gate/v1` still takes only `taskId`, `runId` and\n   `claim`.",
    "**The gate's verdict cannot be influenced by a capability tool.**",
    "never billed USD",
    "never 0",
    "**Claude Ultra only.**",
    "**Codex is gated.**",
    "**No runs until GO.**",
    "3-round review cap",
    "**No public leaderboard.**",
  ])("keeps %j", (line) => {
    expect(DOC).toContain(line);
  });

  it("claims no result and quotes no price beyond $0", () => {
    expect(DOC).toContain("no result is claimed");
    expect(DOC.match(/\$\d[\d.,]*/g) ?? []).toEqual(["$0", "$0"]);
  });
});
