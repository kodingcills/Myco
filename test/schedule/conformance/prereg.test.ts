/**
 * Track S s-v1: the frozen pre-registration and the trg-v1 corpus (capability-spec §3,
 * capability-spec-2 §1.1 and §2 S). Offline, $0.
 */
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { SV1RefusalError } from "../../../src/schedule/conformance/analysis.ts";
import { canonicalJson, sha256Hex } from "../../../src/schedule/conformance/canonical.ts";
import {
  ANALYSIS_MODULES,
  ANALYSIS_SCRIPT,
  buildSV1Prereg,
  CASES_PATH,
  CORPUS_BUILDER,
  extractSBar,
  loadSV1Prereg,
  MANIFEST_PATH,
  MUTANT_COUNT,
  MUTATION_SCRIPT,
  mutantsFromScript,
  PREREG_PATH,
  parseMutationLog,
  preregFileText,
  preregSha256,
  SPEC_PATH,
} from "../../../src/schedule/conformance/prereg.ts";
import {
  buildTrgManifest,
  buildTrgV1,
  casesJsonl,
  TRG_V1_DEFERRED,
} from "../../../src/schedule/conformance/trg-v1.ts";
import { tmp } from "../helpers.ts";
import { perfectResults } from "./fixtures.ts";

const ROOT = resolve(import.meta.dirname, "../../..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

function refusal(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof SV1RefusalError) return e.code;
    throw e;
  }
  return "NOT_REFUSED";
}

/** A copy of exactly the files the pre-registration binds, to tamper with. */
function copyRoot(): string {
  const dir = tmp("myco-sv1-");
  for (const p of [
    PREREG_PATH,
    SPEC_PATH,
    CASES_PATH,
    MANIFEST_PATH,
    ANALYSIS_SCRIPT,
    ...ANALYSIS_MODULES,
    CORPUS_BUILDER,
    MUTATION_SCRIPT,
  ]) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    cpSync(join(ROOT, p), join(dir, p));
  }
  return dir;
}

const append = (dir: string, p: string, text: string) =>
  writeFileSync(join(dir, p), readFileSync(join(dir, p), "utf8") + text);

// biome-ignore lint/suspicious/noExplicitAny: tests tamper with arbitrary prereg fields.
type Prereg = any;

/** Edit the copy's prereg body and re-hash it consistently, as a forger would. */
function rehash(dir: string, edit: (p: Prereg) => unknown): void {
  const f = JSON.parse(readFileSync(join(dir, PREREG_PATH), "utf8"));
  edit(f.preregistration);
  f.preregSha256 = preregSha256(f.preregistration);
  writeFileSync(join(dir, PREREG_PATH), JSON.stringify(f));
}

describe("trg-v1: the conformance corpus", () => {
  const cases = buildTrgV1();

  it("the committed corpus is exactly the builder's output (deterministic)", () => {
    expect(read(CASES_PATH)).toBe(casesJsonl(cases));
    expect(read(CASES_PATH)).toBe(casesJsonl(buildTrgV1()));
    expect(JSON.parse(read(MANIFEST_PATH))).toEqual(buildTrgManifest(cases));
  });

  it("case ids are unique and the counts are stated", () => {
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
    const m = buildTrgManifest(cases);
    expect(m.counts).toEqual({
      total: 92,
      inScope: 88,
      outOfScope: 4,
      perKind: { cron: 20, inbox: 21, manual: 19, webhook: 26, service: 6 },
    });
  });

  it("every trigger kind is crossed with every shared pipeline case spec-2 §2 S lists", () => {
    const shared = [
      "policy-denies",
      "policy-throws",
      "policy-malformed",
      "paused-then-resume",
      "killed-mid-run",
      "duplicate",
      "restart-between-claim-and-run",
      "runs-per-day",
      "concurrency",
      "wall-time",
    ];
    for (const kind of ["cron", "inbox", "manual", "webhook"])
      for (const s of shared) expect(cases.some((c) => c.id === `trg-v1-${kind}-${s}`)).toBe(true);
    const ids = cases.map((c) => c.scenario);
    for (const s of [
      "zero-policies",
      "corrupt-claims",
      "missed-skip",
      "missed-run-latest",
      "bad-signature",
      "signature-replayed-new-delivery",
      "secret-unreadable",
      "symlink-entry",
      "dotfile-entry",
      "secret-in-config",
    ])
      expect(ids).toContain(s);
  });

  it("the S-live case is deferred and stated, not silently missing", () => {
    expect(TRG_V1_DEFERRED.map((d) => d.scenario)).toEqual(["vm-lock-held"]);
    expect(cases.some((c) => c.scenario === "vm-lock-held")).toBe(false);
    expect(buildTrgManifest(cases).deferred).toEqual(TRG_V1_DEFERRED);
  });

  it("out-of-scope cases state why and still carry an expected outcome", () => {
    for (const c of cases.filter((x) => !x.inScope)) {
      expect(c.outOfScopeReason).toMatch(/\w/);
      expect(c.expected.unwrittenRows).toEqual([
        { status: "error", codes: ["LEDGER_FAILED"], accepted: false },
      ]);
    }
    for (const c of cases.filter((x) => x.inScope)) expect(c.outOfScopeReason).toBeNull();
  });

  it("only a verified row is ever expected accepted", () => {
    for (const c of cases)
      for (const r of [...c.expected.ledgerRows, ...c.expected.unwrittenRows])
        expect(r.accepted).toBe(r.status === "verified");
  });

  it("a policy that denies, throws or is malformed never reaches the executor", () => {
    const policy = cases.filter((c) => c.scenario.startsWith("policy-"));
    expect(policy).toHaveLength(12);
    for (const c of policy) {
      expect(c.expected.executorCalls).toBe(0);
      expect(c.expected.ledgerRows.map((r) => r.status)).toEqual(["denied"]);
    }
  });

  it("every case names the bar items it exercises", () => {
    for (const c of cases) {
      expect(c.bar.length).toBeGreaterThan(0);
      for (const b of c.bar) expect([1, 2, 3, 4, 5]).toContain(b);
    }
    for (const b of [1, 2, 3, 4, 5]) expect(cases.some((c) => c.bar.includes(b as 1))).toBe(true);
  });
});

describe("s-v1: the frozen pre-registration", () => {
  const committed = JSON.parse(read(PREREG_PATH));

  it("the committed prereg.json is exactly what the freeze builds from this tree", () => {
    expect(read(PREREG_PATH)).toBe(preregFileText(buildSV1Prereg(ROOT)));
  });

  it("the pre-registration hash is the SHA-256 of the body's canonical JSON", () => {
    expect(committed.preregSha256).toBe(sha256Hex(canonicalJson(committed.preregistration)));
    expect(committed.preregSha256).toBe(preregSha256(committed.preregistration));
  });

  it("records every capability-spec §3.1 field", () => {
    const p = committed.preregistration;
    expect(p.bar.text).toBe(extractSBar(read(SPEC_PATH)));
    expect(p.bar.text).toMatch(/^\*\*Pre-registered bar \(property, all must hold\)\.\*\*/);
    expect(p.bar.text).toContain("6. Mutation table");
    expect(p.corpus.version).toBe("trg-v1");
    expect(p.corpus.manifestSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(p.seeds.caseOrder).toMatch(/\w/);
    expect(p.seeds.marker).toMatch(/\w/);
    expect(p.seeds).toMatchObject({ taskBuild: null, assignment: null, bootstrap: null });
    expect(p.seeds.note).toMatch(/assignment and bootstrap seeds do not apply/);
    expect(p.stepBudget).toBeNull();
    expect(p.stepBudgetNote).toMatch(/Not applicable/);
    expect(p.modelId).toBeNull();
    expect(p.modelIdNote).toMatch(/Not applicable/);
    expect(p.analysis.script.path).toBe(ANALYSIS_SCRIPT);
    expect(p.analysis.script.sha256).toBe(sha256Hex(readFileSync(join(ROOT, ANALYSIS_SCRIPT))));
    expect(p.mutationProof.mutants).toBe(MUTANT_COUNT);
  });

  it("the pre-registered mutant count matches the mutation proof script", () => {
    expect(read(MUTATION_SCRIPT).match(/^\("/gm)).toHaveLength(MUTANT_COUNT);
  });

  it("is never evidence and never claims a ratified bar", () => {
    const p = committed.preregistration;
    expect(p.evidence).toMatchObject({ evidence: false, simulated: true, r1Evidence: false });
    expect(p.status).toMatch(/lead ruling pending \(not ratified\)/);
    expect(p.leadRulingPending.length).toBeGreaterThan(0);
    // No ruling was posted on #637 before the freeze; any later one is recorded with its time.
    expect(p.leadRulings).toEqual([]);
    expect(p.leadRulingsNote).toMatch(/No lead ruling was posted/);
    expect(p.executor).toMatch(/no VM lock/);
  });

  it("loads and verifies against this tree", () => {
    const l = loadSV1Prereg(ROOT);
    expect(l.frozen.preregSha256).toBe(committed.preregSha256);
    expect(l.corpus).toEqual(buildTrgV1());
    expect(l.frozen.mutantCount).toBe(MUTANT_COUNT);
  });
});

describe("s-v1: the analysis refuses a tree that changed after the freeze", () => {
  it("an untouched copy verifies", () => {
    expect(refusal(() => loadSV1Prereg(copyRoot()))).toBe("NOT_REFUSED");
  });

  it.each([
    ["an analysis module", ANALYSIS_MODULES[0], "ANALYSIS_MODULE_CHANGED"],
    ["the canonical-JSON module", ANALYSIS_MODULES[1], "ANALYSIS_MODULE_CHANGED"],
    ["the analysis script", ANALYSIS_SCRIPT, "ANALYSIS_SCRIPT_CHANGED"],
    ["the mutation proof script", MUTATION_SCRIPT, "MUTATION_SCRIPT_CHANGED"],
    ["the corpus cases", CASES_PATH, "CORPUS_CHANGED"],
    ["the corpus builder", CORPUS_BUILDER, "CORPUS_CHANGED"],
  ])("%s", (_, path, code) => {
    const dir = copyRoot();
    append(dir, path, "\n// changed\n");
    expect(refusal(() => loadSV1Prereg(dir))).toBe(code);
  });

  it("the S bar edited in the spec", () => {
    const dir = copyRoot();
    const spec = readFileSync(join(dir, SPEC_PATH), "utf8");
    writeFileSync(join(dir, SPEC_PATH), spec.replace("1. **0 bypasses:**", "1. **0 bypass:**"));
    expect(refusal(() => loadSV1Prereg(dir))).toBe("SPEC_BAR_CHANGED");
  });

  it("a prereg body edited without re-hashing", () => {
    const dir = copyRoot();
    const f = JSON.parse(readFileSync(join(dir, PREREG_PATH), "utf8"));
    f.preregistration.mutationProof.mutants = 55;
    writeFileSync(join(dir, PREREG_PATH), JSON.stringify(f));
    expect(refusal(() => loadSV1Prereg(dir))).toBe("PREREG_HASH_MISMATCH");
  });

  it("a re-hashed prereg whose manifest hash disagrees with the committed manifest", () => {
    const dir = copyRoot();
    rehash(dir, (p) => {
      p.corpus.manifestSha256 = "00".repeat(32);
    });
    expect(refusal(() => loadSV1Prereg(dir))).toBe("CORPUS_CHANGED");
  });

  it("cases edited with a re-hashed prereg but the manifest left as frozen", () => {
    const dir = copyRoot();
    append(dir, CASES_PATH, "\n");
    const sha = sha256Hex(readFileSync(join(dir, CASES_PATH)));
    rehash(dir, (p) => {
      p.corpus.cases.sha256 = sha;
    });
    expect(refusal(() => loadSV1Prereg(dir))).toBe("CORPUS_CHANGED");
  });

  it.each([
    ["no pending list", (p: Prereg) => delete p.leadRulingPending],
    ["a pending list that is not strings", (p: Prereg) => (p.leadRulingPending = [1])],
    ["no lead-rulings list", (p: Prereg) => delete p.leadRulings],
  ])("a re-hashed prereg with %s is refused (B1)", (_, edit) => {
    const dir = copyRoot();
    rehash(dir, edit);
    expect(refusal(() => loadSV1Prereg(dir))).toBe("PREREG_SCHEMA");
  });

  it("a re-hashed prereg whose mutant count disagrees with the frozen script (B2)", () => {
    const dir = copyRoot();
    rehash(dir, (p) => {
      p.mutationProof.mutants = MUTANT_COUNT + 1;
    });
    expect(refusal(() => loadSV1Prereg(dir))).toBe("MUTANT_COUNT_MISMATCH");
  });
});

describe("s-v1: the frozen mutant set comes from the frozen script (B2)", () => {
  it("loads every mutant of schedule-mutation-proof.py with its file", () => {
    const { mutants } = loadSV1Prereg(ROOT).frozen;
    expect(mutants).toHaveLength(MUTANT_COUNT);
    expect(mutants).toContainEqual({
      label: "idempotency: duplicate key check",
      file: "src/schedule/scheduler.ts",
    });
    expect(mutants).toContainEqual({
      label: "cron: scan bound",
      file: "src/schedule/cron.ts",
    });
    expect(new Set(mutants.map((m) => m.label)).size).toBe(MUTANT_COUNT);
  });

  const script = read(MUTATION_SCRIPT);
  it.each([
    [
      "a tuple line that does not parse",
      script.replace('("cron: scan bound", S+', '("cron: scan bound", T+'),
    ],
    ["no S prefix", script.replace('S="src/schedule/"', 'S = "src/schedule/"')],
    ["a repeated label", script.replace('("cron: scan bound",', '("cron: dom/dow OR rule",')],
    ["no tuples", 'S="src/schedule/"\nM=[]\n'],
  ])("refuses a script with %s", (_, text) => {
    expect(refusal(() => mutantsFromScript(text))).toBe("MUTATION_SCRIPT_UNPARSEABLE");
  });
});

describe("s-v1: the mutation log and the CLI", () => {
  it("parses the mutation proof script's table", () => {
    const log = "a b | src/x.ts | killed\nc | src/y.ts | SURVIVED\n1/2 mutants killed\n";
    expect(parseMutationLog(log, "ab").rows).toEqual([
      { label: "a b", file: "src/x.ts", status: "killed" },
      { label: "c", file: "src/y.ts", status: "SURVIVED" },
    ]);
  });

  /** Run the analysis CLI of the tree at `root` (the repo, or a tampered copy). */
  function cli(results: unknown, log: string, root = ROOT) {
    const dir = tmp("myco-sv1-cli-");
    writeFileSync(join(dir, "results.json"), JSON.stringify(results));
    writeFileSync(join(dir, "mutation.txt"), log);
    return spawnSync(
      "npx",
      [
        "tsx",
        join(root, ANALYSIS_SCRIPT),
        "--results",
        join(dir, "results.json"),
        "--mutation-log",
        join(dir, "mutation.txt"),
      ],
      { cwd: ROOT, encoding: "utf8" },
    );
  }

  const committed = JSON.parse(read(PREREG_PATH));
  // What `python3 scripts/schedule-mutation-proof.py` prints when every mutant is killed.
  const allKilled = mutantsFromScript(read(MUTATION_SCRIPT))
    .map((m) => `${m.label} | ${m.file} | killed`)
    .join("\n");
  const fabricated = Array.from(
    { length: MUTANT_COUNT },
    (_, i) => `fake${i} | nowhere | killed`,
  ).join("\n");

  /** A copy of the tree with no lead ruling pending, re-hashed: the bar can hold there. */
  function ruledRoot() {
    const dir = copyRoot();
    rehash(dir, (p) => {
      p.leadRulingPending = [];
    });
    const sha = JSON.parse(readFileSync(join(dir, PREREG_PATH), "utf8")).preregSha256 as string;
    return { dir, results: { ...perfectResults(), preregSha256: sha } };
  }

  it("on this tree, a conforming run exits 1 'not shown' with LEAD_RULING_PENDING (B1)", () => {
    const ok = { ...perfectResults(), preregSha256: committed.preregSha256 };
    const r = cli(ok, `${allKilled}\n`);
    expect(r.status, r.stderr).toBe(1);
    const report = JSON.parse(r.stdout);
    expect(report.verdict).toBe("not shown");
    expect(report.reasons).toEqual(["LEAD_RULING_PENDING"]);
    expect(report.leadRulingPending).toEqual(committed.preregistration.leadRulingPending);
  }, 60_000);

  it("with no ruling pending, exits 0 'property holds' and 1 on a surviving mutant", () => {
    const { dir, results } = ruledRoot();
    const r = cli(results, `${allKilled}\n`, dir);
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout).verdict).toBe("property holds");
    const bad = cli(results, `${allKilled.replace(/killed$/, "SURVIVED")}\n`, dir);
    expect(bad.status, bad.stderr).toBe(1);
    expect(JSON.parse(bad.stdout).reasons).toEqual(["MUTANT_SURVIVED"]);
  }, 60_000);

  it("a fabricated mutation log (56 made-up labels, all killed) is 'not shown' (B2)", () => {
    const { dir, results } = ruledRoot();
    const r = cli(results, `${fabricated}\n${MUTANT_COUNT}/${MUTANT_COUNT} mutants killed\n`, dir);
    expect(r.status, r.stderr).toBe(1);
    const report = JSON.parse(r.stdout);
    expect(report.reasons).toEqual(["MUTANT_MISSING", "MUTANT_UNKNOWN"]);
    expect(report.mutation.missing).toHaveLength(MUTANT_COUNT);
  }, 60_000);

  it("exits 2 and analyses nothing for a results file under another pre-registration", () => {
    const r = cli(perfectResults(), `${allKilled}\n`);
    expect(r.status).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("PREREG_MISMATCH");
  }, 60_000);
});
