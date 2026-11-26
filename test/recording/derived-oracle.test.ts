/**
 * Track R derived oracle: allowlisted assertions only, the R5 mutation self-test before it
 * can verify anything (registry build AND decision time), and no code execution.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { GATE_API_VERSION } from "../../src/gate/api.ts";
import { buildRegistry, createGate } from "../../src/gate/gate.ts";
import { applyEdits, bindWorkflow, compileRecording } from "../../src/recording/compile.ts";
import { parseCsvRows, serializeCsvRows, sha256Hex } from "../../src/recording/csv.ts";
import {
  certifyDerivedOracle,
  checkBoundOracle,
  DERIVED_CLAIMS,
  DERIVED_FAMILY_ID,
  derivedSelfTestCases,
  derivedWorkflowFamily,
  evaluateDerived,
  isCertified,
} from "../../src/recording/derived-oracle.ts";
import { recordDemonstration } from "../../src/recording/recorder.ts";
import { cellFor, scriptedHuman } from "../../src/recording/scripted-human.ts";
import type { BoundDerivedOracle, KeyedEdit } from "../../src/recording/types.ts";
import { fixtureBytes, operator, utf8 } from "./helpers.ts";

const ROOT = resolve(import.meta.dirname, "..", "..");
const demo = fixtureBytes("track-r-oracle-demo");
const fresh = fixtureBytes("track-r-oracle-fresh");

async function compiled() {
  const cell = cellFor(demo, "EMP-0004", "name");
  const rec = await recordDemonstration(
    scriptedHuman({
      document: demo,
      steps: [{ do: "type", cell, text: "Derived Value" }, { do: "save" }],
    }),
    {
      start: operator,
      indicator: () => {},
      before: demo,
      simulated: true,
      recordingId: "rec-oracle",
    },
  );
  return compileRecording(rec);
}

const correctFor = (edits: KeyedEdit[], fx = fresh) =>
  utf8(serializeCsvRows(applyEdits(parseCsvRows(fx), edits)));

function memoryReader(files: Record<string, Uint8Array>) {
  const read = async (runId: string, file: string) => {
    const bytes = files[`${runId}/${file}`];
    return bytes
      ? { ok: true as const, bytes }
      : { ok: false as const, cause: "missing" as const, detail: "missing" };
  };
  return { describe: "memory", read, readFixture: read };
}

describe("evaluator: three allowlisted assertion types, codes and cell refs only", () => {
  it("verifies the correct document and refutes target misses and collateral", async () => {
    const { edits, oracle } = bindWorkflow(await compiled());
    expect(evaluateDerived(correctFor(edits), oracle, fresh).status).toBe("verified");
    const miss = evaluateDerived(fresh, oracle, fresh);
    expect(miss).toMatchObject({ status: "refuted", codes: ["TARGET_MISMATCH"] });
    expect(miss.reasons.join(" ")).not.toContain("Derived Value");
    const rows = applyEdits(parseCsvRows(fresh), edits);
    (rows[2] as string[])[2] = "1";
    const coll = evaluateDerived(utf8(serializeCsvRows(rows)), oracle, fresh);
    expect(coll.codes).toEqual(["DOCUMENT_COLLATERAL"]);
  });

  it("refuses unknown assertion types, extra fields, and an oracle that asserts no cell", async () => {
    const { oracle } = bindWorkflow(await compiled());
    const inject = (a: unknown) => ({ ...oracle, assertions: [...oracle.assertions, a] });
    expect(checkBoundOracle(inject({ type: "run-script", code: "process.exit(1)" }))).toMatch(
      /not allowlisted/,
    );
    expect(checkBoundOracle(inject({ type: "header-equals-fixture", js: "x" }))).toMatch(
      /unknown or missing/,
    );
    expect(checkBoundOracle({ ...oracle, extra: 1 })).toMatch(/unknown or missing/);
    expect(checkBoundOracle({ ...oracle, trust: "built-in" })).toMatch(/derived/);
    expect(checkBoundOracle({ ...oracle, assertions: [{ type: "others-equal-fixture" }] })).toMatch(
      /asserts no cell/,
    );
    expect(() =>
      evaluateDerived(fresh, inject({ type: "eval" }) as BoundDerivedOracle, fresh),
    ).toThrow(/not allowlisted/);
  });

  it("refuses unreadable documents as could-not-look (CsvDocumentError)", async () => {
    const { oracle } = bindWorkflow(await compiled());
    expect(() => evaluateDerived(new Uint8Array([0xff]), oracle, fresh)).toThrow(/UTF-8/);
    expect(() => evaluateDerived(utf8('id,"x"\n'), oracle, fresh)).toThrow(/quoted/);
  });
});

describe("R5: the oracle mutation self-test gates verification", () => {
  it("a compiled oracle passes every claimed class on a fresh fixture", async () => {
    const { edits, oracle } = bindWorkflow(await compiled());
    const cert = certifyDerivedOracle(oracle, edits, fresh);
    expect(cert.report.reasons).toEqual([]);
    expect(cert.pass).toBe(true);
    for (const cls of DERIVED_CLAIMS) {
      expect(cert.report.perClass[cls].runs, cls).toBeGreaterThan(0);
      expect(cert.report.perClass[cls].caught, cls).toBe(cert.report.perClass[cls].runs);
    }
    expect(isCertified(oracle, sha256Hex(fresh))).toBe(true);
    // Certified for this fixture only.
    expect(isCertified(oracle, sha256Hex(demo))).toBe(false);
  });

  it("a weak oracle fails it and is never certified (no others-equal: collateral verifies)", async () => {
    const { edits, oracle } = bindWorkflow(await compiled());
    const weak = {
      ...oracle,
      assertions: oracle.assertions.filter((a) => a.type === "cell-equals"),
    };
    const cert = certifyDerivedOracle(weak, edits, fresh);
    expect(cert.pass).toBe(false);
    expect(cert.report.reasons.join(" ")).toMatch(/collateral/);
    expect(isCertified(weak, sha256Hex(fresh))).toBe(false);
  });

  it("an oracle for a no-op edit fails it (edit-missing is byte-identical to the control)", async () => {
    const { oracle } = bindWorkflow(await compiled());
    const rows = parseCsvRows(fresh);
    const same = { rowKey: "EMP-0004", column: "name", value: rows[4]?.[1] as string };
    const noop: BoundDerivedOracle = {
      ...oracle,
      assertions: oracle.assertions.map((a) =>
        a.type === "cell-equals" ? { ...a, value: same.value } : a,
      ),
    };
    expect(certifyDerivedOracle(noop, [same], fresh).pass).toBe(false);
  });

  it("an oracle that does not target the fixture fails it (harness error is a failure)", async () => {
    const { edits, oracle } = bindWorkflow(await compiled());
    const off = edits.map((e) => ({ ...e, rowKey: "EMP-9999" }));
    expect(certifyDerivedOracle(oracle, off, fresh).pass).toBe(false);
  });

  it("the self-test cases carry every claimed class, each differing from the control", async () => {
    const { edits } = bindWorkflow(await compiled());
    const [c] = derivedSelfTestCases(edits, fresh);
    expect(new Set(c?.corruptions.map((x) => x.cls))).toEqual(DERIVED_CLAIMS);
  });
});

describe("gate family: uncertified derived oracles cannot verify", () => {
  it("buildRegistry refuses an uncertified derived spec, so no gate starts", async () => {
    const { edits, oracle } = bindWorkflow(await compiled(), { name: "Never Certified" });
    const other = fixtureBytes("track-r-uncertified");
    void edits;
    expect(() =>
      buildRegistry(
        [
          {
            id: "t1",
            family: DERIVED_FAMILY_ID,
            stateFile: "doc.csv",
            spec: { oracle, fixtureFile: "fixture.csv", fixtureSha256: sha256Hex(other) },
          },
        ],
        new Map([[DERIVED_FAMILY_ID, derivedWorkflowFamily]]),
      ),
    ).toThrow(/R5 oracle mutation self-test/);
  });

  it("decide refuses an uncertified oracle even if a registry were built around the check", async () => {
    const { edits, oracle } = bindWorkflow(await compiled(), { name: "Decide Uncertified" });
    const fx = fixtureBytes("track-r-decide-uncertified");
    const spec = { oracle, fixtureFile: "fixture.csv", fixtureSha256: sha256Hex(fx) };
    expect(() =>
      derivedWorkflowFamily.decide(correctFor(edits, fx), spec, "r", { fixture: fx }),
    ).toThrow(/not certified/);
  });

  it("decide refuses a sealed fixture other than the certified one", async () => {
    const { edits, oracle } = bindWorkflow(await compiled());
    certifyDerivedOracle(oracle, edits, fresh);
    const spec = { oracle, fixtureFile: "fixture.csv", fixtureSha256: sha256Hex(fresh) };
    expect(() =>
      derivedWorkflowFamily.decide(correctFor(edits), spec, "r", { fixture: demo }),
    ).toThrow(/certified one/);
    expect(() => derivedWorkflowFamily.decide(correctFor(edits), spec, "r", {})).toThrow(/missing/);
  });

  it("through the real gate: certified verifies, derived family is named, unreadable is uncertain", async () => {
    const { edits, oracle } = bindWorkflow(await compiled());
    expect(certifyDerivedOracle(oracle, edits, fresh).pass).toBe(true);
    const spec = { oracle, fixtureFile: "fixture.csv", fixtureSha256: sha256Hex(fresh) };
    const tasks = buildRegistry(
      [{ id: "t1", family: DERIVED_FAMILY_ID, stateFile: "doc.csv", spec }],
      new Map([[DERIVED_FAMILY_ID, derivedWorkflowFamily]]),
    );
    const run = async (doc: Uint8Array) =>
      createGate({
        tasks,
        reader: memoryReader({ "r1/doc.csv": doc, "r1/fixture.csv": fresh }),
        assignment: { taskId: "t1", runId: "r1" },
      }).check({ apiVersion: GATE_API_VERSION, taskId: "t1", runId: "r1", claim: "done" });
    const ok = await run(correctFor(edits));
    expect(ok).toMatchObject({ verdict: "verified", accepted: true });
    expect(ok.oracle?.family).toBe("derived-workflow");
    expect(ok.oracle?.version).toBe("derived/1");
    expect(await run(fresh)).toMatchObject({ verdict: "refuted", accepted: false });
    const bad = await run(new Uint8Array([0xff, 0x00]));
    expect(bad).toMatchObject({ verdict: "uncertain", accepted: false });
    expect(bad.reasonCodes).toContain("STATE_CORRUPT");
  });
});

describe("no agent or recorded code is executed by the oracle", () => {
  it("track R modules use no eval, Function, dynamic import, vm or process launch (except the Linux UNO wrapper)", () => {
    const dir = join(ROOT, "src", "recording");
    for (const file of [
      "derived-oracle.ts",
      "compile.ts",
      "csv.ts",
      "types.ts",
      "scrub.ts",
      "recorder.ts",
      "replay.ts",
    ]) {
      const code = readFileSync(join(dir, file), "utf8").replace(/^\s*(\/\/|\*|\/\*\*).*$/gm, "");
      expect(code, file).not.toMatch(
        /\beval\s*\(|new\s+Function\b|\bFunction\s*\(|import\s*\(|node:vm|child_process|spawn/,
      );
    }
  });
});
