/**
 * Track I pre-registration (capability spec §3): the committed i-v1 prereg.json is frozen,
 * hash-pinned, consistent with the spec's track I section and the frozen fc-v1 task set, and
 * freezes the analysis code by SHA-256. Also the seeded ABBA assignment (§1.3).
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { STEP_BUDGET } from "../../src/baseline/c1-trial.ts";
import { PILOT_MODEL } from "../../src/pilot/config.ts";
import { readTaskFacts } from "../../src/state/i-analysis-cli.ts";
import {
  assignmentSchedule,
  canonicalJson,
  I_PREREG_HASH_FILE,
  I_PREREG_JSON,
  type IPrereg,
  loadIPrereg,
  markdownSection,
  preregHash,
  preregProblems,
  seededUniforms,
} from "../../src/state/prereg.ts";

const ROOT = resolve(import.meta.dirname, "..", "..");
const raw = () => JSON.parse(readFileSync(join(ROOT, I_PREREG_JSON), "utf8")) as IPrereg;
// biome-ignore lint/suspicious/noExplicitAny: tests mutate the frozen object loosely
const edit = (f: (p: any) => void): IPrereg => {
  const p = structuredClone(raw());
  f(p);
  return p;
};

describe("the committed i-v1 pre-registration", () => {
  it("loads with no problems and its recorded hash is the canonical-JSON hash", () => {
    const { hash, prereg } = loadIPrereg(ROOT);
    expect(readFileSync(join(ROOT, I_PREREG_HASH_FILE), "utf8").trim()).toBe(hash);
    expect(hash).toBe(preregHash(raw()));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(prereg.track).toBe("I");
  });

  it("is consistent with the spec and the repo: C1 step budget, fc-v1 split, gate-less", () => {
    const p = raw();
    expect(p.stepBudget).toBe(STEP_BUDGET);
    expect(p.arms.primary).toEqual({ capability: "C1+I", baseline: "C1" });
    expect(p.gate).toBe("absent-in-both-arms");
    const facts = readTaskFacts(ROOT, p.taskSet.tasksFile);
    expect(facts).toHaveLength(p.taskSet.tasks);
    expect(facts.filter((t) => t.satisfiable)).toHaveLength(p.taskSet.satisfiable);
    expect(
      facts.filter((t) => !t.satisfiable).every((t) => t.faultClass === "invalid-target"),
    ).toBe(true);
  });

  it("proposes the pilot's model and flags it (and the bar) lead ruling pending", () => {
    const p = raw();
    expect(p.modelId).toBe(PILOT_MODEL);
    expect(p.leadRulingPending.join("\n")).toMatch(/modelId/);
    expect(p.leadRulingPending.join("\n")).toMatch(/bar/);
  });

  it("freezes every module the analysis CLI imports", () => {
    const IMPORT = /from\s*["']([^"']+)["']/g;
    const seen = new Set<string>();
    const walk = (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      for (const m of readFileSync(file, "utf8").matchAll(IMPORT))
        if ((m[1] as string).startsWith(".")) walk(resolve(dirname(file), m[1] as string));
    };
    walk(join(ROOT, "scripts", "capability-i-analysis.ts"));
    const reached = [...seen].map((f) => relative(ROOT, f)).sort();
    expect(reached).toEqual(Object.keys(raw().analysis.files).sort());
  });
});

describe("preregProblems names every broken freeze", () => {
  const cases: [string, (p: Record<string, never> & IPrereg) => void, RegExp][] = [
    [
      "manifest hash",
      (p) => Object.assign(p.taskSet, { manifestSha256: "0".repeat(64) }),
      /manifest/,
    ],
    [
      "analysis file hash",
      (p) => Object.assign(p.analysis.files, { "src/state/i-analysis.ts": "0".repeat(64) }),
      /i-analysis\.ts changed/,
    ],
    [
      "spec section hash",
      (p) => Object.assign(p.spec, { sectionSha256: "0".repeat(64) }),
      /section changed/,
    ],
    ["alpha", (p) => Object.assign(p.bar[0] as object, { alpha: 0.1 }), /bar 1/],
    ["min discordant", (p) => Object.assign(p.bar[0] as object, { minDiscordant: 4 }), /bar 1/],
    ["resamples", (p) => Object.assign(p.bar[1] as object, { resamples: 1000 }), /bar 2/],
    ["bar 2 order", (p) => Object.assign(p.bar[1] as object, { requires: [] }), /bar 2/],
    ["simulated model", (p) => Object.assign(p, { modelId: "simulated:scripted" }), /modelId/],
    ["gate present", (p) => Object.assign(p, { gate: "present" }), /gate presence/],
    [
      "arms swapped",
      (p) => Object.assign(p.arms.primary, { capability: "C1", baseline: "C1+I" }),
      /primary arms/,
    ],
    ["step budget", (p) => Object.assign(p, { stepBudget: 40 }), /step budget/],
    [
      "same seeds",
      (p) => Object.assign(p.seeds, { bootstrap: p.seeds.assignment }),
      /seeds must differ/,
    ],
    ["guardrail dropped", (p) => Object.assign(p, { guardrails: [] }), /guardrail/],
    [
      "metric via gate",
      (p) => Object.assign(p, { primaryMetric: "gate verified rate" }),
      /never the gate/,
    ],
  ];
  for (const [name, change, want] of cases)
    it(name, () => {
      // biome-ignore lint/suspicious/noExplicitAny: loose mutation in tests
      const problems = preregProblems(edit(change as any), ROOT);
      expect(problems.join("; ")).toMatch(want);
    });

  it("leadRulingPending that is not a list of strings", () => {
    for (const bad of [undefined, "none", [1]])
      expect(
        preregProblems(
          edit((p) => (p.leadRulingPending = bad)),
          ROOT,
        ).join("; "),
      ).toMatch(/leadRulingPending must be a list of strings/);
  });

  it("a tasks.jsonl that does not hash to the manifest's entry", () => {
    const dir = mkdtempSync(join(tmpdir(), "i-prereg-tasks-"));
    try {
      const real = readFileSync(join(ROOT, raw().taskSet.tasksFile), "utf8");
      const fake = join(dir, "tasks.jsonl");
      writeFileSync(fake, `${real}\n`);
      const problems = preregProblems(
        edit((p) => (p.taskSet.tasksFile = relative(ROOT, fake))),
        ROOT,
      );
      expect(problems.join("; ")).toMatch(/tasks\.jsonl does not hash to the manifest's entry/);
      // The same bytes under the same name pass: the check is on content, not the path.
      writeFileSync(fake, real);
      expect(
        preregProblems(
          edit((p) => (p.taskSet.tasksFile = relative(ROOT, fake))),
          ROOT,
        ),
      ).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the untouched file has none", () => {
    expect(preregProblems(raw(), ROOT)).toEqual([]);
  });
});

describe("the pre-registration hash", () => {
  it("ignores key order and whitespace, and moves with any value", () => {
    const p = raw();
    const reordered = Object.fromEntries(Object.entries(p).reverse());
    expect(preregHash(reordered)).toBe(preregHash(p));
    expect(preregHash(edit((q) => (q.seeds.bootstrap = "i-v1-bootstrap-other")))).not.toBe(
      preregHash(p),
    );
    expect(canonicalJson({ b: [1, { d: 1, c: 2 }], a: null })).toBe(
      '{"a":null,"b":[1,{"c":2,"d":1}]}',
    );
  });
});

describe("markdownSection", () => {
  it("takes the track I section and stops at the next heading", () => {
    const spec = readFileSync(join(ROOT, "docs/product/capability-spec.md"), "utf8");
    const s = markdownSection(spec, "I. Structured state access");
    expect(s.startsWith("### I. Structured state access")).toBe(true);
    expect(s).toMatch(/C1\+I/);
    expect(s).not.toMatch(/### J\./);
    expect(() => markdownSection(spec, "Z. Nothing")).toThrow(/not found/);
  });
});

describe("assignmentSchedule (seeded ABBA)", () => {
  const ids = readTaskFacts(ROOT, raw().taskSet.tasksFile).map((t) => t.taskId);
  const seed = raw().seeds.assignment;

  it("runs every task once in each arm, ABBA in two-task blocks", () => {
    const s = assignmentSchedule(ids, seed);
    expect(s).toHaveLength(200);
    for (const id of ids)
      expect(
        s
          .filter((t) => t.taskId === id)
          .map((t) => t.arm)
          .sort(),
      ).toEqual(["C1", "C1+I"]);
    for (let b = 0; b < s.length; b += 4) {
      const [a1, b1, b2, a2] = s.slice(b, b + 4);
      expect(a1?.taskId).toBe(b1?.taskId);
      expect(b2?.taskId).toBe(a2?.taskId);
      expect(a1?.arm).toBe(a2?.arm);
      expect(b1?.arm).toBe(b2?.arm);
      expect(a1?.arm).not.toBe(b1?.arm);
    }
    // ABBA balances which arm goes first: exactly half the tasks each.
    const firsts = ids.map((id) => s.find((t) => t.taskId === id)?.arm);
    expect(firsts.filter((a) => a === "C1")).toHaveLength(50);
  });

  it("is a pure function of the seed (input order does not matter)", () => {
    expect(assignmentSchedule([...ids].reverse(), seed)).toEqual(assignmentSchedule(ids, seed));
    expect(assignmentSchedule(ids, "another-seed-1")).not.toEqual(assignmentSchedule(ids, seed));
    expect(() => assignmentSchedule(["a", "a"], seed)).toThrow(/duplicate/);
  });

  it("seededUniforms is reproducible and in [0, 1)", () => {
    const a = seededUniforms("s-00000001");
    const b = seededUniforms("s-00000001");
    const xs = Array.from({ length: 1000 }, () => a());
    expect(xs).toEqual(Array.from({ length: 1000 }, () => b()));
    expect(xs.every((x) => x >= 0 && x < 1)).toBe(true);
  });
});
