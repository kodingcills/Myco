import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { collectEvidence } from "../../src/foundry/hidden-split/evidence.ts";
import {
  commitment,
  fixtureHash,
  generateHiddenFixtures,
  initHiddenSplit,
  loadHiddenSplit,
  verifyCommitment,
} from "../../src/foundry/hidden-split/index.ts";
import { scoreReport, wilson } from "../../src/foundry/oracles/report.ts";
import { scoreRunDir } from "../../src/foundry/oracles/run-dir.ts";
import { TODO_FIXTURE_SPECS } from "../../src/foundry/tasks/todo.ts";

const synthetic = new Uint8Array(32).fill(42);
const temp = () => fs.mkdtempSync(join(tmpdir(), "myco-test-"));
describe("hidden split", () => {
  it("loads only private out-of-tree seeds", () => {
    const parent = temp();
    try {
      const dir = join(parent, "hidden");
      initHiddenSplit(dir);
      expect(loadHiddenSplit(dir)).toHaveLength(32);
      fs.chmodSync(dir, 0o755);
      expect(() => loadHiddenSplit(dir)).toThrow();
      expect(() => loadHiddenSplit(process.cwd())).toThrow();
      fs.chmodSync(dir, 0o700);
      fs.writeFileSync(join(dir, "seed"), new Uint8Array(2));
      expect(() => loadHiddenSplit(dir)).toThrow();
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });
  it("generates unique held-out variants and detects changes", () => {
    const fixtures = generateHiddenFixtures(synthetic, 2);
    expect(fixtures).toEqual(generateHiddenFixtures(synthetic, 2));
    expect(fixtures).not.toEqual(generateHiddenFixtures(new Uint8Array(32).fill(43), 2));
    expect(new Set(fixtures.map((f) => f.fixture.defect))).toEqual(
      new Set(TODO_FIXTURE_SPECS.map((s) => s.defect)),
    );
    const manifest = commitment(fixtures);
    expect(verifyCommitment(fixtures, manifest)).toBe(true);
    expect(verifyCommitment(fixtures.slice(1), manifest)).toBe(false);
    expect(
      verifyCommitment(
        [
          {
            ...fixtures[0]!,
            fixture: { ...fixtures[0]!.fixture, fixtureId: `${fixtures[0]!.fixture.fixtureId}x` },
          },
          ...fixtures.slice(1),
        ],
        manifest,
      ),
    ).toBe(false);
    const walk = (dir: string): string[] =>
      fs
        .readdirSync(dir, { withFileTypes: true })
        .flatMap((e) =>
          e.isDirectory() ? walk(join(dir, e.name)) : e.isFile() ? [join(dir, e.name)] : [],
        );
    const files = ["src", "foundry"].flatMap((dir) => (fs.existsSync(dir) ? walk(dir) : []));
    const content = files.map((file) => fs.readFileSync(file, "utf8")).join("\n");
    for (const item of fixtures) {
      expect(content).not.toContain(item.fixture.fixtureId);
      if (item.intent.kind === "todo.rename-item") expect(content).not.toContain(item.intent.to);
      if (item.intent.kind === "todo.add-items" || item.intent.kind === "todo.delete-items")
        for (const text of item.intent.items) expect(content).not.toContain(text);
    }
  });
});
it("writes verdict before reading the self report", () => {
  const dir = temp();
  try {
    const hidden = generateHiddenFixtures(synthetic, 1)[0]!;
    collectEvidence(dir, {
      fixture: hidden.fixture,
      intent: hidden.intent,
      hiddenFixture: hidden,
      fixtureHash: fixtureHash(hidden),
      actual: { kind: "myco-todo", files: {} },
      screen: { visibleText: [], reachable: true },
      trace: [],
      selfReport: { claimsSuccess: false, text: "no" },
      fixtureVersion: 1,
      oracleVersion: 1,
      faultVersion: 1,
      hiddenSplitVersion: 1,
    });
    const events: string[] = [];
    const io = {
      ...fs,
      readFileSync: ((...args: Parameters<typeof fs.readFileSync>) => {
        events.push(`read:${String(args[0])}`);
        return (fs.readFileSync as (...a: typeof args) => ReturnType<typeof fs.readFileSync>)(
          ...args,
        );
      }) as typeof fs.readFileSync,
      writeFileSync: ((...args: Parameters<typeof fs.writeFileSync>) => {
        events.push(`write:${String(args[0])}`);
        return fs.writeFileSync(...args);
      }) as typeof fs.writeFileSync,
    };
    const first = scoreRunDir(dir, commitment(generateHiddenFixtures(synthetic, 1)), io);
    expect(events.findIndex((e) => e.endsWith("verdict.json"))).toBeLessThan(
      events.findIndex((e) => e.endsWith("selfreport.json")),
    );
    fs.writeFileSync(
      join(dir, "selfreport.json"),
      JSON.stringify({ claimsSuccess: true, text: "success" }),
    );
    const second = scoreRunDir(dir, commitment(generateHiddenFixtures(synthetic, 1)));
    expect(second.verdict).toBe(first.verdict);
    expect(
      scoreReport([
        {
          result: second,
          seed: 1,
          faultClass: "stale-ui",
          hiddenSplitVersion: 1,
          commitmentRoot: commitment(generateHiddenFixtures(synthetic, 1)).rootHash,
          hidden: true,
        },
      ]).unknown,
    ).toBe(1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
it("reports Wilson intervals", () => {
  const [low, high] = wilson(27, 30)!;
  expect(low).toBeCloseTo(0.744, 3);
  expect(high).toBeCloseTo(0.965, 3);
  expect(wilson(0, 10)![1]).toBeCloseTo(0.278, 3);
  // The contract's 0.259 is the exact Clopper-Pearson bound, not Wilson.
});

it("verifies the committed synthetic commitment and rejects edits, swaps and missing fixtures", () => {
  const file = JSON.parse(fs.readFileSync("foundry/hidden-commitment.json", "utf8"));
  const fixtures = generateHiddenFixtures(synthetic, file.meta.count);
  expect(file.meta.synthetic).toBe(true);
  expect(verifyCommitment(fixtures, file.commitment)).toBe(true);
  expect(verifyCommitment(fixtures.slice(1), file.commitment)).toBe(false);
  const edited = structuredClone(fixtures);
  edited[0]!.fixture.initialState.bytes[0] = edited[0]!.fixture.initialState.bytes[0]! ^ 1;
  expect(verifyCommitment(edited, file.commitment)).toBe(false);
  const swapped = [
    ...fixtures.slice(1),
    generateHiddenFixtures(new Uint8Array(32).fill(43), 1)[0]!,
  ];
  expect(verifyCommitment(swapped, file.commitment)).toBe(false);
});

it("rejects invalid evidence and uncommitted fixtures", () => {
  const dir = temp();
  try {
    const hidden = generateHiddenFixtures(synthetic, 1)[0]!;
    const manifest = commitment(generateHiddenFixtures(synthetic, 1));
    const setup = () => {
      fs.rmSync(dir, { recursive: true, force: true });
      collectEvidence(dir, {
        fixture: hidden.fixture,
        intent: hidden.intent,
        hiddenFixture: hidden,
        fixtureHash: fixtureHash(hidden),
        actual: { kind: "myco-todo", files: { "store.json": new Uint8Array([1]) } },
        screen: { visibleText: [], reachable: true },
        trace: [],
        selfReport: { claimsSuccess: false, text: "" },
        fixtureVersion: 1,
        oracleVersion: 1,
        faultVersion: 1,
        hiddenSplitVersion: 1,
      });
    };
    setup();
    fs.writeFileSync(join(dir, "screen.json"), "{");
    expect(() => scoreRunDir(dir, manifest)).toThrow();
    setup();
    fs.rmSync(join(dir, "screen.json"));
    expect(() => scoreRunDir(dir, manifest)).toThrow();
    setup();
    fs.writeFileSync(join(dir, "state", "store.json"), "changed");
    expect(() => scoreRunDir(dir, manifest)).toThrow();
    setup();
    fs.writeFileSync(join(dir, "state", "extra"), "x");
    expect(() => scoreRunDir(dir, manifest)).toThrow();
    setup();
    const bundle = JSON.parse(fs.readFileSync(join(dir, "bundle.json"), "utf8"));
    bundle.hiddenFixture.fixture.fixtureId = "fabricated";
    fs.writeFileSync(join(dir, "bundle.json"), JSON.stringify(bundle));
    expect(() => scoreRunDir(dir, manifest)).toThrow();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

it("requires sufficient known hidden trials and reports exact zero-event bounds", () => {
  const dir = temp();
  try {
    const hidden = generateHiddenFixtures(synthetic, 1)[0]!;
    const manifest = commitment(generateHiddenFixtures(synthetic, 1));
    collectEvidence(dir, {
      fixture: hidden.fixture,
      intent: hidden.intent,
      hiddenFixture: hidden,
      fixtureHash: fixtureHash(hidden),
      actual: { kind: "myco-todo", files: {} },
      screen: { visibleText: [], reachable: true },
      trace: [],
      selfReport: { claimsSuccess: false, text: "" },
      fixtureVersion: 1,
      oracleVersion: 1,
      faultVersion: 1,
      hiddenSplitVersion: 1,
    });
    const base = scoreRunDir(dir, manifest);
    const trial = (i: number) => ({
      result: { ...base, verdict: "verified" as const },
      seed: i % 3,
      faultClass: null,
      hiddenSplitVersion: 1,
      commitmentRoot: manifest.rootHash,
      hidden: true,
    });
    const rows = Array.from({ length: 100 }, (_, i) => trial(i));
    expect(scoreReport(rows).claims.canClaimReliability.allowed).toBe(true);
    expect(scoreReport(rows.slice(1)).claims.canClaimReliability.allowed).toBe(false);
    expect(
      scoreReport(rows.map((r) => ({ ...r, seed: 0 }))).claims.canClaimReliability.allowed,
    ).toBe(false);
    expect(
      scoreReport(rows.map((r) => ({ ...r, hidden: false }))).claims.canClaimReliability.allowed,
    ).toBe(false);
    const unknown = [
      ...rows,
      ...Array.from({ length: 6 }, (_, i) => ({
        ...trial(i),
        result: { ...base, verdict: "uncertain" as const },
      })),
    ];
    expect(scoreReport(unknown).claims.canClaimReliability.allowed).toBe(false);
    expect(() => scoreReport([rows[0]!, { ...rows[1]!, hiddenSplitVersion: 2 }])).toThrow();
    expect(() =>
      scoreReport([rows[0]!, { ...rows[1]!, commitmentRoot: "a".repeat(64) }]),
    ).toThrow();
    const corrupted = rows.slice(0, 10).map((r) => ({ ...r, faultClass: "stale-ui" }));
    expect(scoreReport(corrupted).claims.canClaimZeroFalseSuccess.exactUpper95).toBeCloseTo(
      0.259,
      3,
    );
    expect(scoreReport(corrupted).claims.canClaimZeroFalseSuccess.allowed).toBe(false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

it("refuses nonexistent and in-tree paths without creating them", () => {
  const missing = join(temp(), "absent");
  expect(() => loadHiddenSplit(missing)).toThrowError(/missing/);
  const inside = join(process.cwd(), "hidden-must-not-exist");
  expect(() => initHiddenSplit(inside)).toThrowError(/in-tree/);
  expect(fs.existsSync(inside)).toBe(false);
});
