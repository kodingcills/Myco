import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { collectEvidence, decode, encode } from "../../src/foundry/hidden-split/evidence.ts";
import {
  commitment,
  fixtureHash,
  generateHiddenFixtures,
  initHiddenSplit,
  loadHiddenSplit,
  verifyCommitment,
} from "../../src/foundry/hidden-split/index.ts";
import { scoreTrial } from "../../src/foundry/oracles/blind.ts";
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
      scoreReport(
        [
          {
            result: second,
            seed: 1,
            faultClass: "stale-ui",
            hiddenSplitVersion: 1,
            commitmentRoot: commitment(generateHiddenFixtures(synthetic, 1)).rootHash,
            fixtureHash: fixtureHash(hidden),
          },
        ],
        false,
        commitment(generateHiddenFixtures(synthetic, 1)),
      ).unknown,
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
    expect(() => scoreRunDir(dir, manifest)).toThrow(/Malformed screen.json/);
    setup();
    fs.rmSync(join(dir, "screen.json"));
    expect(() => scoreRunDir(dir, manifest)).toThrow(/Cannot read screen.json/);
    setup();
    fs.writeFileSync(join(dir, "state", "store.json"), "changed");
    expect(() => scoreRunDir(dir, manifest)).toThrow(/State integrity failure/);
    setup();
    fs.writeFileSync(join(dir, "state", "extra"), "x");
    expect(() => scoreRunDir(dir, manifest)).toThrow(/Unexpected state files/);
    setup();
    const bundle = JSON.parse(fs.readFileSync(join(dir, "bundle.json"), "utf8"));
    bundle.hiddenFixture.fixture.fixtureId = "fabricated";
    fs.writeFileSync(join(dir, "bundle.json"), JSON.stringify(bundle));
    expect(() => scoreRunDir(dir, manifest)).toThrow(/Commitment or version mismatch/);
    setup();
    const fabricated = structuredClone(hidden);
    (fabricated.fixture as { fixtureId: string }).fixtureId = "fabricated";
    const altered = decode(fs.readFileSync(join(dir, "bundle.json"), "utf8")) as Record<
      string,
      unknown
    >;
    altered.hiddenFixture = fabricated;
    altered.fixture = fabricated.fixture;
    altered.fixtureHash = fixtureHash(fabricated);
    fs.writeFileSync(join(dir, "bundle.json"), encode(altered));
    expect(() => scoreRunDir(dir, manifest)).toThrow(/Commitment or version mismatch/);
    setup();
    fs.writeFileSync(
      join(dir, "trace.jsonl"),
      JSON.stringify({ type: "action", timestamp: "now" }),
    );
    expect(() => scoreRunDir(dir, manifest)).toThrow(/Invalid trace/);
    setup();
    fs.writeFileSync(
      join(dir, "screen.json"),
      JSON.stringify({ visibleText: "bad", reachable: true }),
    );
    expect(() => scoreRunDir(dir, manifest)).toThrow(/Invalid screen/);
    for (const key of ["hiddenSplitVersion", "faultVersion"]) {
      setup();
      const data = JSON.parse(fs.readFileSync(join(dir, "bundle.json"), "utf8"));
      data[key] = 1.5;
      fs.writeFileSync(join(dir, "bundle.json"), JSON.stringify(data));
      expect(() => scoreRunDir(dir, manifest)).toThrow(/Commitment or version mismatch/);
    }
    setup();
    fs.writeFileSync(
      join(dir, "state", "manifest.json"),
      JSON.stringify({ "store.json": "not-a-hash" }),
    );
    expect(() => scoreRunDir(dir, manifest)).toThrow(/Invalid state manifest/);
    setup();
    let calls = 0;
    expect(() =>
      scoreRunDir(dir, manifest, fs, (input) => {
        const result = scoreTrial(input);
        return ++calls === 1
          ? result
          : { ...result, verdict: result.verdict === "verified" ? "refuted" : "verified" };
      }),
    ).toThrow(/Scoring changed the verdict/);
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
      fixtureHash: fixtureHash(hidden),
    });
    const rows = Array.from({ length: 100 }, (_, i) => trial(i));
    expect(scoreReport(rows, false, manifest).claims.canClaimReliability.allowed).toBe(true);
    expect(scoreReport(rows.slice(1), false, manifest).claims.canClaimReliability.allowed).toBe(
      false,
    );
    expect(
      scoreReport(
        rows.map((r) => ({ ...r, seed: 0 })),
        false,
        manifest,
      ).claims.canClaimReliability.allowed,
    ).toBe(false);
    expect(
      scoreReport(
        rows.map((r) => ({ ...r, fixtureHash: "0".repeat(64), hidden: true })),
        false,
        manifest,
      ).claims.canClaimReliability.allowed,
    ).toBe(false);
    const unknown = [
      ...rows,
      ...Array.from({ length: 6 }, (_, i) => ({
        ...trial(i),
        result: { ...base, verdict: "uncertain" as const },
      })),
    ];
    expect(scoreReport(unknown, false, manifest).claims.canClaimReliability.allowed).toBe(false);
    expect(() =>
      scoreReport([rows[0]!, { ...rows[1]!, hiddenSplitVersion: 2 }], false, manifest),
    ).toThrow();
    expect(() =>
      scoreReport([rows[0]!, { ...rows[1]!, commitmentRoot: "a".repeat(64) }], false, manifest),
    ).toThrow();
    const corrupted = rows.slice(0, 10).map((r) => ({ ...r, faultClass: "stale-ui" }));
    expect(
      scoreReport(corrupted, false, manifest).claims.canClaimZeroFalseSuccess.exactUpper95,
    ).toBeCloseTo(0.259, 3);
    expect(scoreReport(corrupted, false, manifest).claims.canClaimZeroFalseSuccess.allowed).toBe(
      false,
    );
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

it("refuses a directory owned by another uid", () => {
  if (typeof process.getuid !== "function") return;
  const parent = temp();
  try {
    const dir = join(parent, "hidden");
    initHiddenSplit(dir);
    const other = ((path: fs.PathLike) => ({
      ...fs.statSync(path),
      uid: process.getuid!() + 1,
    })) as typeof fs.statSync;
    expect(() => loadHiddenSplit(dir, other)).toThrow(/owner/);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});
