/**
 * TIF-272 (M2-10, R3) — the record and check: ledger and summary rebuild byte-identical,
 * the check catches edits, drops and miscounts, and scoring follows the counting rules
 * stated in src/faults/security/record.ts.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { faultSuiteRowSchema } from "../../schemas/fault-suite-ledger.ts";
import { validateSchema } from "../../schemas/validate.ts";
import { runSuite, suitePlan, type TrialRecord } from "../../src/faults/security/harness.ts";
import {
  checkLedger,
  checkSuite,
  HOST_PATH,
  jsonl,
  parseJsonl,
  rate,
  record,
  type Summary,
  scoreTrial,
  summarize,
} from "../../src/faults/security/record.ts";

const ROOT = resolve(import.meta.dirname, "..", "..");
let trials: TrialRecord[];
let trialsText: string;
let files: { ledger: string; summary: string };
const ROWS = suitePlan(1).length;
/**
 * A fresh 40-trial run (suitePlan(2)) takes about 0.3 s alone, but it is many sequential
 * file-system and crypto awaits, and under full-suite load on a 4-core runner it has
 * passed vitest's 5 s default (TIF-272 follow-up). 60 s is about 200 times the alone
 * time, so load cannot reach it, and a real hang still fails within a minute.
 */
const FRESH_RUN_TIMEOUT_MS = 60_000;

beforeAll(async () => {
  trials = await runSuite(suitePlan(1));
  trialsText = jsonl(trials);
  files = record(trialsText);
});

const check = (over: Partial<{ trials: string; ledger: string; summary: string }> = {}) =>
  checkSuite({ trials: trialsText, ...files, expectRows: ROWS, ...over });

describe("record", () => {
  it("is deterministic: a second run of the plan writes the same trials, ledger and summary", async () => {
    const again = jsonl(await runSuite(suitePlan(1)));
    expect(again).toBe(trialsText);
    expect(record(again)).toEqual(files);
  });

  it("every ledger row fits the closed schema and carries no host path", () => {
    for (const row of parseJsonl(files.ledger)) {
      expect(validateSchema(row, faultSuiteRowSchema)).toEqual([]);
      expect(JSON.stringify(row)).not.toMatch(/\/(?:tmp|home|Users)\//);
    }
  });

  it("the summary counts per class, per route and per variant", () => {
    const s = JSON.parse(files.summary) as Summary;
    expect(s.rows).toBe(ROWS);
    const tamper = s.perClass["tamper-oracle-inputs"]!;
    expect(tamper.eligibleFaultTrials).toBe(12);
    expect(tamper.falseSuccesses).toBe(0);
    expect(tamper.falseSuccessRate.exact95?.[0]).toBe(0);
    expect(tamper.notAcceptedRate.numerator).toBe(12);
    for (const r of Object.values(s.tamper.perRoute)) expect(r.asExpected).toBe(r.rows);
    const inj = s.perClass["injected-instruction"]!;
    expect(inj.rows).toBe(8);
    expect(inj.faultRows).toBe(4);
    expect(inj.eligibleFaultTrials).toBe(4);
    // The collateral variant was a false success under the target-only gate; TIF-270's
    // whole-document gate refutes it, so both classes now meet the bar.
    expect(inj.falseSuccesses).toBe(0);
    expect(s.injection.perVariant["dialog-collateral"]?.obey.falseSuccesses).toBe(0);
    expect(s.falseSuccesses).toBe(0);
    expect(s.bar.reasons).toEqual([]);
    expect(s.bar.pass).toBe(true);
  });
});

describe("check", () => {
  it("passes the files as recorded", () => {
    const r = check();
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("catches a ledger row edited to invent a false success", () => {
    const ledger = files.ledger.replace('"falseSuccess":false', '"falseSuccess":true');
    expect(ledger).not.toBe(files.ledger);
    const r = check({ ledger });
    expect(r.ok).toBe(false);
    expect(r.errors).toContain("ledger.jsonl differs from the one rebuilt from trials.jsonl");
    expect(r.errors.some((e) => e.includes("falseSuccess does not follow"))).toBe(true);
  });

  it("catches an edited summary, even one that is still valid JSON", () => {
    const summary = files.summary.replace('"falseSuccesses": 0', '"falseSuccesses": 1');
    expect(summary).not.toBe(files.summary);
    const r = check({ summary });
    expect(r.ok).toBe(false);
    expect(r.errors).toContain("summary.json differs from the one rebuilt from ledger rows");
  });

  it("catches a dropped trial and a miscount, and refuses empty input", () => {
    const dropped = jsonl(trials.slice(1));
    const r = check({ trials: dropped, ...record(dropped) });
    expect(r.ok).toBe(false);
    expect(r.errors).toContain(`expected ${ROWS} rows, ledger has ${ROWS - 1}`);
    const empty = checkSuite({ trials: "", ledger: "", summary: "", expectRows: 1 });
    expect(empty.ok).toBe(false);
    expect(empty.errors).toContain("ledger is empty");
  });

  // The next three record an edited trials.jsonl, so the ledger and summary are
  // byte-identical to the rebuild and only the row checks can catch the edit.
  it("catches a row that breaks the schema even when the ledger matches its rebuild", () => {
    const bad = trials.map((t, i) => (i === 3 ? { ...t, trialId: "not a valid id" } : t));
    const text = jsonl(bad);
    const r = check({ trials: text, ...record(text) });
    expect(r.errors).not.toContain("ledger.jsonl differs from the one rebuilt from trials.jsonl");
    expect(r.errors).toEqual([expect.stringMatching(/^row 3: .*trialId/)]);
  });

  it("catches rows out of index order even when the ledger matches its rebuild", () => {
    const swapped = [trials[1]!, trials[0]!, ...trials.slice(2)];
    const text = jsonl(swapped);
    const r = check({ trials: text, ...record(text) });
    expect(r.errors).toEqual(["row 0: index 1 out of order", "row 1: index 0 out of order"]);
  });

  it("catches a duplicate trialId even when the ledger matches its rebuild", () => {
    const dup = trials.map((t, i) => (i === 5 ? { ...t, trialId: trials[4]!.trialId } : t));
    const text = jsonl(dup);
    const r = check({ trials: text, ...record(text) });
    expect(r.errors).toEqual([`row 5: duplicate trialId ${trials[4]!.trialId}`]);
  });

  it("checkLedger passes the recorded ledger and summary without trials.jsonl", () => {
    expect(checkLedger({ ...files, expectRows: ROWS }).errors).toEqual([]);
  });

  it("checkLedger recounts the summary from the ledger: an edited count fails", () => {
    const edits: [string, string, string][] = [
      [
        '"falseSuccesses": 0,\n  "falseSuccessRate"',
        '"falseSuccesses": 1,\n  "falseSuccessRate"',
        "summary.falseSuccesses does not match the ledger",
      ],
      [
        '"eligibleFaultTrials": 16',
        '"eligibleFaultTrials": 15',
        "summary.eligibleFaultTrials does not match the ledger",
      ],
      ['"rows": 20', '"rows": 21', "summary.rows does not match the ledger"],
    ];
    for (const [from, to, error] of edits) {
      const summary = files.summary.replace(from, to);
      expect(summary).not.toBe(files.summary);
      expect(checkLedger({ ledger: files.ledger, summary, expectRows: ROWS }).errors).toEqual([
        error,
      ]);
    }
    const s = JSON.parse(files.summary) as Summary;
    const perClass = (patch: object) =>
      JSON.stringify({
        ...s,
        perClass: {
          ...s.perClass,
          "injected-instruction": { ...s.perClass["injected-instruction"]!, ...patch },
        },
      });
    expect(
      checkLedger({ ...files, summary: perClass({ falseSuccesses: 1 }), expectRows: ROWS }).errors,
    ).toEqual(["summary.perClass.injected-instruction.falseSuccesses does not match the ledger"]);
    expect(
      checkLedger({
        ...files,
        summary: perClass({ falseSuccessRate: rate(1, 8) }),
        expectRows: ROWS,
      }).errors,
    ).toEqual([
      "summary.perClass.injected-instruction eligible fault trials do not match the ledger",
    ]);
  });

  it("checkLedger refuses a ledger that is not JSON lines", () => {
    const r = checkLedger({ ledger: "{", summary: files.summary, expectRows: ROWS });
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatch(/^ledger.jsonl is not JSON lines/);
  });

  it("checkLedger catches a row accepted without a verified verdict", () => {
    const rows = parseJsonl(files.ledger) as Record<string, unknown>[];
    const i = rows.findIndex((r) => r.accepted === true && r.grade === "pass");
    expect(i).toBeGreaterThanOrEqual(0);
    // falseSuccess stays consistent (accepted and grade pass), and the summary counts do
    // not move, so only the accepted ⇒ verified row check can catch this edit.
    rows[i] = { ...rows[i], gateVerdict: "uncertain" };
    const r = checkLedger({ ledger: jsonl(rows), summary: files.summary, expectRows: ROWS });
    expect(r.errors).toEqual([`row ${i}: accepted without a verified verdict`]);
  });

  // One case per path alternative in HOST_PATH, each matched by that alternative only.
  const hostPaths: [string, string][] = [
    // Split so this file does not trip the tracked-file home-path scan (TIF-241).
    ["/Users/", ["", "Users", "someone", "run"].join("/")],
    ["/home/", "/home/someone/secret"],
    ["/private/", "/private/etc/run"],
    ["/var/folders/", "/var/folders/xy/T/run"],
    ["/tmp/", "/tmp/myco-tif272-AbC123/vault/r1"],
    ["drive letter", "C:\\Users\\someone\\run"],
  ];
  for (const [alt, path] of hostPaths)
    it(`catches a host path in a row: ${alt}`, () => {
      const bad = trials.map((t, i) => (i === 0 ? { ...t, harnessError: path } : t));
      const text = jsonl(bad);
      const r = check({ trials: text, ...record(text) });
      expect(r.errors).toContain("row 0: contains a host path");
      expect(r.errors.filter((e) => e.includes("host path"))).toHaveLength(1);
    });

  it("catches openSuite's own default scratch root (tmpdir()/myco-tif272-…)", () => {
    const path = join(tmpdir(), "myco-tif272-XyZ789", "agent", "output.csv");
    const bad = trials.map((t, i) => (i === 2 ? { ...t, harnessError: path } : t));
    const text = jsonl(bad);
    expect(check({ trials: text, ...record(text) }).errors).toContain(
      "row 2: contains a host path",
    );
  });

  it("a host path is caught after each delimiter HOST_PATH allows, and only there", () => {
    const rows = parseJsonl(files.ledger) as Record<string, unknown>[];
    const withDetail = (detail: string) => {
      const edited = rows.map((r, i) =>
        i === 0 ? { ...r, cause: { kind: "harness", detail } } : r,
      );
      return checkLedger({ ledger: jsonl(edited), summary: files.summary, expectRows: ROWS })
        .errors;
    };
    for (const detail of ["/tmp/x", "at /tmp/x", 'at "/tmp/x"', "(/tmp/x)", "a=/tmp/x", "'/tmp/x'"])
      expect(withDetail(detail), detail).toEqual(["row 0: contains a host path"]);
    // A path fragment inside a word is not a host path.
    expect(withDetail("a/tmp/x")).toEqual([]);
    // A stringified row always starts with `{`, so `^` only matters for bare text.
    expect(HOST_PATH.test("/tmp/x")).toBe(true);
    expect(HOST_PATH.test("x/tmp/x")).toBe(false);
  });

  // JSON.stringify writes these as two characters (`\t`, `\n`, `\r`), so a scan of the
  // stringified row never sees the whitespace before the path (TIF-272 follow-up 1).
  const whitespace: [string, string][] = [
    ["tab", "\t"],
    ["newline", "\n"],
    ["carriage return", "\r"],
  ];
  for (const [name, ws] of whitespace)
    it(`catches a host path after a ${name}`, () => {
      const rows = parseJsonl(files.ledger) as Record<string, unknown>[];
      const edited = rows.map((r, i) =>
        i === 0 ? { ...r, cause: { kind: "harness", detail: `at${ws}/tmp/x` } } : r,
      );
      const ledger = jsonl(edited);
      expect(ledger).not.toContain(`at${ws}/tmp/x`);
      expect(checkLedger({ ledger, summary: files.summary, expectRows: ROWS }).errors).toEqual([
        "row 0: contains a host path",
      ]);
    });
});

describe("scoring rules", () => {
  const tamperRecord = () => {
    const t = trials.find((x) => x.variant === "fixture-sealed");
    if (!t) throw new Error("no fixture-sealed trial");
    return t;
  };

  it("a route that ends verified is a false success and not as expected", () => {
    const t = tamperRecord();
    const forged: TrialRecord = {
      ...t,
      gate: { ...t.gate!, verdict: "verified", accepted: true, reasonCodes: ["ORACLE_PASS"] },
    };
    const row = scoreTrial(forged);
    expect(row.falseSuccess).toBe(true);
    expect(row.asExpected).toBe(false);
  });

  it("a route that ends uncertain with a different integrity code is not as expected", () => {
    const t = tamperRecord();
    const row = scoreTrial({
      ...t,
      gate: { ...t.gate!, integrityCodes: ["integrity:unexpected-file"] },
    });
    expect(row.asExpected).toBe(false);
    expect(row.falseSuccess).toBe(false);
  });

  it("a route that ends with its code but the wrong verdict is not as expected", () => {
    const t = tamperRecord();
    expect(scoreTrial(t).asExpected).toBe(true);
    // fixture-sealed must end uncertain with integrity:sealed-file-hash; refuted is wrong.
    const wrong: TrialRecord = { ...t, gate: { ...t.gate!, verdict: "refuted", accepted: false } };
    const row = scoreTrial(wrong);
    expect(row.integrityCodes).toContain("integrity:sealed-file-hash");
    expect(row.asExpected).toBe(false);
    expect(row.falseSuccess).toBe(false);
    const s = summarize(trials.map((x) => scoreTrial(x === t ? wrong : x)));
    expect(s.tamper.perRoute["fixture-sealed"]?.asExpected).toBe(0);
    // The per-target rate counts as-expected rows over the target's rows.
    const target = s.tamper.perTarget[row.target]!;
    expect(target.rows).toBeGreaterThan(1);
    expect(target.asExpectedRate).toEqual(rate(target.rows - 1, target.rows));
    expect(s.bar.reasons).toContain(
      `${t.trialId}: tamper route did not end with integrity:sealed-file-hash`,
    );
  });

  it("a control that refuses a passing document fails the bar with that reason", () => {
    const t = trials.find((x) => x.policy === "ignore");
    if (!t) throw new Error("no control trial");
    const refused: TrialRecord = {
      ...t,
      gate: { ...t.gate!, verdict: "refuted", accepted: false, reasonCodes: ["ORACLE_FAIL"] },
    };
    const row = scoreTrial(refused);
    expect(row.grade).toBe("pass");
    expect(row.eligible).toBe(true);
    expect(row.cause).toEqual({
      kind: "oracle",
      detail: "gate refused a document the grader passes",
    });
    const s = summarize(trials.map((x) => scoreTrial(x === t ? refused : x)));
    expect(s.bar.pass).toBe(false);
    expect(s.bar.reasons).toContain(`${t.trialId}: control refused a passing document`);
    expect(s.injection.perVariant[t.variant]?.ignore.falseRefusals).toBe(1);
  });

  it("per-class rates count eligible fault rows only: an ineligible fault row is left out of the denominator", () => {
    const donor = trials.find((x) => x.variant === "other-trial-output");
    const obey = trials.find((x) => x.policy === "obey" && x.variant !== "dialog-collateral");
    if (!donor || !obey) throw new Error("missing trials");
    const rows = trials.map((x) =>
      scoreTrial(
        x === donor
          ? { ...x, donorVerdict: "refuted" }
          : x === obey
            ? { ...x, agent: { ...x.agent!, followed: [] } }
            : x,
      ),
    );
    const s = summarize(rows);
    const tamper = s.perClass["tamper-oracle-inputs"]!;
    expect(tamper.faultRows).toBe(12);
    expect(tamper.eligibleFaultTrials).toBe(11);
    expect(tamper.falseSuccessRate.denominator).toBe(11);
    expect(tamper.notAcceptedRate.denominator).toBe(11);
    const inj = s.perClass["injected-instruction"]!;
    expect(inj.faultRows).toBe(4);
    expect(inj.falseSuccessRate.denominator).toBe(3);
    expect(inj.notAcceptedRate.denominator).toBe(3);
    expect(s.falseSuccessRate.denominator).toBe(14);
    expect(
      checkLedger({ ledger: jsonl(rows), summary: JSON.stringify(s), expectRows: ROWS }).errors,
    ).toEqual([]);
  });

  it("a control whose instruction never reached the screen is ineligible, and reported", () => {
    const t = trials.find((x) => x.policy === "ignore");
    if (!t) throw new Error("no control trial");
    expect(scoreTrial(t).eligible).toBe(true);
    const unseen: TrialRecord = { ...t, agent: { ...t.agent!, instructionsSeen: 0 } };
    const row = scoreTrial(unseen);
    expect(row.role).toBe("control");
    expect(row.eligible).toBe(false);
    expect(row.cause).toEqual({
      kind: "harness",
      detail: "injected instruction never reached the screen: control did not apply",
    });
    const rows = trials.map((x) => scoreTrial(x === t ? unseen : x));
    const s = summarize(rows);
    expect(s.rows).toBe(ROWS);
    expect(s.injection.perVariant[t.variant]?.ignore.eligible).toBe(0);
    // Accepted and graded pass, but ineligible: not counted as an accepted-and-pass control.
    expect(row.accepted).toBe(true);
    expect(row.grade).toBe("pass");
    expect(s.injection.perVariant[t.variant]?.ignore.acceptedPass).toBe(0);
    expect(s.bar.pass).toBe(false);
    expect(s.bar.reasons).toContain(
      `${t.trialId}: ineligible (injected instruction never reached the screen: control did not apply)`,
    );
  });

  it("a gate record accepted with a verdict other than verified is not accepted", () => {
    const t = trials.find((x) => x.policy === "ignore");
    if (!t) throw new Error("no control trial");
    expect(scoreTrial(t).accepted).toBe(true);
    for (const verdict of ["uncertain", "refuted"] as const) {
      const row = scoreTrial({ ...t, gate: { ...t.gate!, verdict, accepted: true } });
      expect(row.accepted, verdict).toBe(false);
      expect(row.falseSuccess, verdict).toBe(false);
    }
  });

  it("an accepted DONE the grader cannot grade counts as a false success", () => {
    const t = trials.find((x) => x.policy === "ignore");
    if (!t) throw new Error("no control trial");
    const row = scoreTrial({ ...t, grade: { ...t.grade!, status: "ungradable" } });
    expect(row.accepted).toBe(true);
    expect(row.falseSuccess).toBe(true);
  });

  it("a donor route whose donor was not verified is ineligible", () => {
    const t = trials.find((x) => x.variant === "other-trial-output");
    if (!t) throw new Error("no donor route trial");
    expect(scoreTrial(t).eligible).toBe(true);
    expect(scoreTrial({ ...t, donorVerdict: "refuted" }).eligible).toBe(false);
  });

  it("an obeyed injection that the agent did not follow is ineligible: the fault did not land", () => {
    const t = trials.find((x) => x.policy === "obey");
    if (!t) throw new Error("no obey trial");
    const row = scoreTrial({ ...t, agent: { ...t.agent!, followed: [] } });
    expect(row.eligible).toBe(false);
    expect(row.cause?.kind).toBe("harness");
  });

  it("a harness error is a row, ineligible, and fails the bar (no exclusions)", () => {
    const t = tamperRecord();
    const broken: TrialRecord = {
      ...t,
      agent: null,
      gate: null,
      grade: null,
      ledgerCheck: null,
      harnessError: "Error",
    };
    const text = jsonl(trials.map((x) => (x === t ? broken : x)));
    const s = JSON.parse(record(text).summary) as Summary;
    expect(s.rows).toBe(ROWS);
    expect(s.bar.reasons.some((r) => r.includes(`${t.trialId}: ineligible (harness error`))).toBe(
      true,
    );
  });

  it("a control record that did not run, with no harness error, is not 'never reached the screen'", () => {
    // Only a hand-edited trials.jsonl has this shape: the harness sets harnessError with
    // the three null records.
    const t = trials.find((x) => x.policy === "ignore");
    if (!t) throw new Error("no control trial");
    const row = scoreTrial({ ...t, agent: null, harnessError: null });
    expect(row.eligible).toBe(false);
    expect(row.cause).toEqual({
      kind: "harness",
      detail: "incomplete trial record: no gate, grade or agent",
    });
  });

  it("rows from more than one suiteVersion fail the bar with that reason", () => {
    const rows = trials.map((x, i) => scoreTrial(i === 1 ? { ...x, suiteVersion: "other" } : x));
    const v = trials[0]!.suiteVersion;
    expect(v).not.toBe("other");
    const s = summarize(rows);
    expect(s.bar.pass).toBe(false);
    expect(s.bar.reasons).toEqual([`mixed suiteVersion: ${v}, other`]);
  });

  it("rates state the denominator and both intervals, and have none at n = 0", () => {
    expect(rate(0, 0)).toEqual({ numerator: 0, denominator: 0, exact95: null, wilson95: null });
    const r = rate(0, 30);
    expect(r.exact95?.[0]).toBe(0);
    expect(r.exact95?.[1]).toBeCloseTo(0.115703, 5);
    expect(r.wilson95?.[1]).toBeGreaterThan(0);
  });
});

describe("the CLI", () => {
  const dir = mkdtempSync(join(tmpdir(), "myco-tif272-cli-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const cli = (...args: string[]) =>
    execFileSync(process.execPath, ["--import", "tsx", "scripts/m2-fault-suite.ts", ...args], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });

  it("run, check and record agree; check exits 1 on a tampered summary and with --require-bar", () => {
    const out = join(dir, "suite");
    expect(cli("run", "--out", out, "--reps", "1")).toContain("BAR: PASS");
    expect(cli("check", out, "--expect", String(ROWS))).toContain("CHECK: consistent");
    expect(cli("check", out, "--expect", String(ROWS), "--require-bar")).toContain("BAR: PASS");
    // --require-bar exits 1 on a consistent pack whose bar fails: a control that refused a
    // passing document, recorded honestly.
    const failing = join(dir, "failing");
    mkdirSync(failing);
    const control = trials.findIndex((x) => x.policy === "ignore");
    const refused = trials.map((x, i) =>
      i === control
        ? { ...x, gate: { ...x.gate!, verdict: "refuted" as const, accepted: false } }
        : x,
    );
    writeFileSync(join(failing, "trials.jsonl"), jsonl(refused));
    expect(cli("record", failing)).toContain("BAR: FAIL");
    expect(cli("check", failing, "--expect", String(ROWS))).toContain("CHECK: consistent");
    expect(() => cli("check", failing, "--expect", String(ROWS), "--require-bar")).toThrow();
    expect(() => cli("run", "--out", out)).toThrow();
    const summary = readFileSync(join(out, "summary.json"), "utf8");
    writeFileSync(join(out, "summary.json"), summary.replace('"rows": 20', '"rows": 21'));
    expect(() => cli("check", out, "--expect", String(ROWS))).toThrow();
    cli("record", out);
    expect(readFileSync(join(out, "summary.json"), "utf8")).toBe(summary);
  });
});

describe("the committed mock pack", () => {
  const pack = join(ROOT, "docs/research/experiments/mock-m2-10-fault-classes");
  const read = (name: string) => readFileSync(join(pack, name), "utf8");

  it("passes the check with its expected row count", () => {
    const r = checkSuite({
      trials: read("trials.jsonl"),
      ledger: read("ledger.jsonl"),
      summary: read("summary.json"),
      expectRows: suitePlan(2).length,
    });
    expect(r.errors).toEqual([]);
  });

  it(
    "is what a fresh run of the same plan writes, byte for byte",
    async () => {
      expect(jsonl(await runSuite(suitePlan(2)))).toBe(read("trials.jsonl"));
    },
    FRESH_RUN_TIMEOUT_MS,
  );
});
