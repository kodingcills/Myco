/**
 * Track U dataset exporter (src/dataset/export.ts): which runs are exported, which are
 * refused, and that nothing that would leak is ever written. Mutation-proved by
 * scripts/desktops-mutation-proof.sh.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { datasetRecordSchema } from "../../schemas/dataset-export.ts";
import { validateSchema } from "../../schemas/validate.ts";
import {
  canonicalJson,
  classify,
  type ExportCandidate,
  ExportRefused,
  exportDataset,
} from "../../src/dataset/export.ts";

const sha = (s: string | Uint8Array) => createHash("sha256").update(s).digest("hex");
const NOW = () => new Date("2026-11-26T16:00:00.000Z");
const FIXTURE_SHA = sha("pristine fixture");
const DOC = Buffer.from("id,qty\nEMP-0001,42\n");

function candidate(k: number, over: Partial<ExportCandidate> = {}): ExportCandidate {
  const taskId = `task-${k}`;
  const runId = `run-${k}`;
  return {
    trialKey: `${taskId}/${runId}`,
    taskId,
    runId,
    family: "calc-record-edit",
    instruction: `Set record EMP-0001, column qty, to "42", and save. (${k})`,
    fixtureSha256: FIXTURE_SHA,
    steps: [
      {
        index: 0,
        action: { tool: "open_file", input: { path: "fixture.csv" } },
        observation: { kind: "text", text: "opened" },
      },
      { index: 1, action: { tool: "save", input: {} }, observation: null },
    ],
    claim: { done: true, text: "Done." },
    gate: {
      source: "myco-gate",
      result: {
        apiVersion: "myco.gate/v1",
        verdict: "verified",
        accepted: true,
        reasonCodes: ["ORACLE_PASS"],
        request: { taskId, runId },
      },
    },
    grade: {
      graderVersion: "false-completion-grader/1",
      status: "pass",
      fixtureSha256: FIXTURE_SHA,
      persistedSha256: sha(DOC),
      mismatchCount: 0,
    },
    persisted: { path: "doc.csv", format: "csv", bytes: DOC },
    provenance: {
      backend: "local-process/1",
      isolation: "process",
      networkEnforced: false,
      image: "myco-linux-desktop/1",
      plannerModelId: "claude-model-x",
      simulated: false,
      harness: "test/1",
      startedAt: "2026-11-26T15:00:00.000Z",
      finishedAt: "2026-11-26T15:01:00.000Z",
    },
    ...over,
  };
}

function refuted(k: number, over: Partial<ExportCandidate> = {}): ExportCandidate {
  const c = candidate(k);
  return candidate(k, {
    gate: {
      source: "myco-gate",
      result: {
        ...c.gate!.result,
        verdict: "refuted",
        accepted: false,
        reasonCodes: ["ORACLE_FAIL"],
      },
    },
    grade: { ...c.grade!, status: "fail", mismatchCount: 1 },
    ...over,
  });
}

const gateWith = (k: number, fields: Record<string, unknown>) => {
  const c = candidate(k);
  return { source: "myco-gate" as const, result: { ...c.gate!.result, ...fields } };
};

function out(): string {
  return join(mkdtempSync(join(tmpdir(), "myco-u-export-")), "ds");
}

function refusal(fn: () => unknown): ExportRefused {
  try {
    fn();
  } catch (e) {
    if (e instanceof ExportRefused) return e;
    throw e;
  }
  throw new Error("expected the export to be refused");
}

describe("classify: positives need gate verified AND grader pass AND both bound", () => {
  it("verified + pass + claimed done is positive", () => {
    expect(classify(candidate(1), false)).toEqual({ label: "positive" });
  });

  it.each<[string, string, ExportCandidate]>([
    ["no gate record", "MISSING_GATE", candidate(1, { gate: null })],
    ["no grade record", "MISSING_GRADE", candidate(1, { grade: null })],
    ["no capture", "MISSING_CAPTURE", candidate(1, { persisted: null })],
    [
      "wrong api version",
      "GATE_MALFORMED",
      candidate(1, { gate: gateWith(1, { apiVersion: "myco.gate/v2" }) }),
    ],
    [
      "unknown verdict",
      "GATE_MALFORMED",
      candidate(1, { gate: gateWith(1, { verdict: "VERIFIED" }) }),
    ],
    [
      "verified but not accepted",
      "GATE_MALFORMED",
      candidate(1, { gate: gateWith(1, { accepted: false }) }),
    ],
    [
      "refuted but accepted",
      "GATE_MALFORMED",
      candidate(1, { gate: gateWith(1, { verdict: "refuted", accepted: true }) }),
    ],
    [
      "gate answered another task",
      "GATE_NOT_BOUND",
      candidate(1, { gate: gateWith(1, { request: { taskId: "task-2", runId: "run-1" } }) }),
    ],
    [
      "gate answered another run",
      "GATE_NOT_BOUND",
      candidate(1, { gate: gateWith(1, { request: { taskId: "task-1", runId: "run-2" } }) }),
    ],
    [
      "gate request without ids",
      "GATE_NOT_BOUND",
      candidate(1, { gate: gateWith(1, { request: {} }) }),
    ],
    [
      "grade of other bytes",
      "GRADE_NOT_BOUND",
      candidate(1, { grade: { ...candidate(1).grade!, persistedSha256: sha("other") } }),
    ],
    [
      "grade with no persisted digest",
      "GRADE_NOT_BOUND",
      candidate(1, { grade: { ...candidate(1).grade!, persistedSha256: null } }),
    ],
    [
      "grade against another fixture",
      "GRADE_NOT_BOUND",
      candidate(1, { grade: { ...candidate(1).grade!, fixtureSha256: sha("x") } }),
    ],
    [
      "captured bytes changed after grading",
      "GRADE_NOT_BOUND",
      candidate(1, {
        persisted: { path: "doc.csv", format: "csv", bytes: Buffer.from("tampered") },
      }),
    ],
    [
      "gate uncertain",
      "GATE_UNCERTAIN",
      candidate(1, { gate: gateWith(1, { verdict: "uncertain", accepted: false }) }),
    ],
    [
      "grader ungradable",
      "GRADE_UNGRADABLE",
      candidate(1, { grade: { ...candidate(1).grade!, status: "ungradable" } }),
    ],
    [
      "gate verified, grader fail (a false VERIFIED)",
      "GATE_GRADER_DISAGREE",
      candidate(1, { grade: { ...candidate(1).grade!, status: "fail" } }),
    ],
    [
      "gate refuted, grader pass",
      "GATE_GRADER_DISAGREE",
      refuted(1, { grade: candidate(1).grade }),
    ],
    ["correct but not claimed", "NOT_CLAIMED", candidate(1, { claim: { done: false, text: "" } })],
    ["refuted + fail without includeNegatives", "NEGATIVES_NOT_REQUESTED", refuted(1)],
  ])("%s is excluded (%s)", (_name, code, c) => {
    expect(classify(c, false)).toEqual({ excluded: code });
  });

  it("refuted + fail is a labelled negative only when negatives are requested", () => {
    expect(classify(refuted(1), true)).toEqual({ label: "negative" });
    // includeNegatives never turns anything else into an export.
    expect(
      classify(
        candidate(1, { gate: gateWith(1, { verdict: "uncertain", accepted: false }) }),
        true,
      ),
    ).toEqual({ excluded: "GATE_UNCERTAIN" });
    expect(
      classify(candidate(1, { grade: { ...candidate(1).grade!, status: "fail" } }), true),
    ).toEqual({ excluded: "GATE_GRADER_DISAGREE" });
  });
});

describe("exportDataset", () => {
  it("writes records, manifest and schema; records validate; digests match; deterministic", () => {
    const cands = [candidate(2), candidate(1), refuted(3), candidate(4, { gate: null })];
    const a = out();
    const b = out();
    const ra = exportDataset(cands, { outDir: a, includeNegatives: true, now: NOW });
    exportDataset([...cands].reverse(), { outDir: b, includeNegatives: true, now: NOW });
    for (const f of ["records.jsonl", "manifest.json", "schema.json"]) {
      expect(readFileSync(join(a, f))).toEqual(readFileSync(join(b, f)));
    }
    const lines = readFileSync(join(a, "records.jsonl"), "utf8").trimEnd().split("\n");
    expect(lines.map((l) => JSON.parse(l).trialKey)).toEqual([
      "task-1/run-1",
      "task-2/run-2",
      "task-3/run-3",
    ]);
    expect(lines.map((l) => JSON.parse(l).label)).toEqual(["positive", "positive", "negative"]);
    for (const line of lines) {
      const record = JSON.parse(line);
      expect(validateSchema(record, datasetRecordSchema)).toEqual([]);
      expect(record.hashes.persistedSha256).toBe(sha(DOC));
      expect(record.hashes.instructionSha256).toBe(sha(record.instruction));
      expect(record.hashes.transcriptSha256).toBe(
        sha(canonicalJson({ steps: record.steps, claim: record.claim })),
      );
    }
    expect(ra.manifest).toMatchObject({
      evidence: false,
      negativesIncluded: true,
      counts: {
        candidates: 4,
        records: 3,
        positive: 2,
        negative: 1,
        simulated: 0,
        excluded: { MISSING_GATE: 1 },
      },
    });
  });

  it("refuses an existing output directory", () => {
    const dir = out();
    mkdirSync(dir);
    expect(refusal(() => exportDataset([candidate(1)], { outDir: dir })).code).toBe("OUT_EXISTS");
  });

  it("refuses duplicate trial keys or run ids", () => {
    expect(refusal(() => exportDataset([candidate(1), candidate(1)], { outDir: out() })).code).toBe(
      "DUPLICATE_TRIAL",
    );
    const dupRun = candidate(2, { runId: "run-1", trialKey: "task-2/run-1b" });
    expect(refusal(() => exportDataset([candidate(1), dupRun], { outDir: out() })).code).toBe(
      "DUPLICATE_TRIAL",
    );
  });

  it("refuses a scripted planner or mock gate that is not labelled simulated", () => {
    const scripted = candidate(1, {
      provenance: { ...candidate(1).provenance, plannerModelId: null },
    });
    expect(refusal(() => exportDataset([scripted], { outDir: out() })).code).toBe(
      "SIMULATED_UNLABELLED",
    );
    const mock = candidate(1, { gate: { ...candidate(1).gate!, source: "mock-gate" } });
    expect(refusal(() => exportDataset([mock], { outDir: out() })).code).toBe(
      "SIMULATED_UNLABELLED",
    );
    // Even an excluded run must be labelled honestly.
    const excludedMock = candidate(1, {
      gate: { ...candidate(1).gate!, source: "mock-gate" },
      grade: null,
    });
    expect(refusal(() => exportDataset([excludedMock], { outDir: out() })).code).toBe(
      "SIMULATED_UNLABELLED",
    );
    // Labelled, it exports and is counted as simulated.
    const labelled = candidate(1, {
      provenance: { ...candidate(1).provenance, plannerModelId: null, simulated: true },
    });
    const r = exportDataset([labelled], { outDir: out() });
    expect(r.manifest.counts).toMatchObject({ records: 1, simulated: 1 });
  });

  it("refuses a record that fails its schema", () => {
    const bad = candidate(1, {
      steps: [{ index: 0, action: { tool: "1-bad tool", input: {} }, observation: null }],
    });
    const e = refusal(() => exportDataset([bad], { outDir: out() }));
    expect(e.code).toBe("SCHEMA_INVALID");
    expect(e.where).toContain("$.steps[0].action.tool");
  });

  // Planted-marker tests: each marker is built at runtime so this file never matches the
  // repo's own secret and home-path scanners.
  const MARKERS: Array<[string, string]> = [
    ["POSIX home path", ["/", "home", "/", "carol", "/", "work", "/doc.csv"].join("")],
    ["macOS home path", ["/", "Users", "/", "dave", "/", "doc.csv"].join("")],
    ["tmp path", ["/", "tmp", "/", "myco-desktops-x", "/d-1"].join("")],
    ["Windows path", ["C:", "\\", "Users", "\\", "erin"].join("")],
    ["file URL", ["file:", "//", "srv/share"].join("")],
    ["home-relative path", ["see ", "~", "/", ".config/x"].join("")],
    ["sk-ant key", ["sk", "-ant-", "api03", "-", "Z".repeat(20)].join("")],
    ["GitHub token", ["gh", "p_", "A1b2".repeat(6)].join("")],
    ["AWS key id", ["AK", "IA", "ABCDEFGHIJKLMNOP"].join("")],
    ["private key", ["-----BEGIN ", "RSA ", "PRIVATE KEY-----"].join("")],
    ["bearer token", ["Bear", "er ", "abcDEF123456ghiJKL789"].join("")],
    ["key assignment", ["api", "_key", "=", "hunter2hunter2"].join("")],
    ["operator marker", "zz-operator-planted-marker"],
  ];
  const FIELDS: Array<[string, (m: string) => Partial<ExportCandidate>]> = [
    ["instruction", (m) => ({ instruction: `Do it. ${m}` })],
    [
      "observation",
      (m) => ({
        steps: [
          { index: 0, action: { tool: "x", input: {} }, observation: { kind: "text", text: m } },
        ],
      }),
    ],
    [
      "action input value",
      (m) => ({
        steps: [{ index: 0, action: { tool: "x", input: { path: m } }, observation: null }],
      }),
    ],
    [
      "action input key",
      (m) => ({
        steps: [{ index: 0, action: { tool: "x", input: { [m]: 1 } }, observation: null }],
      }),
    ],
    [
      "nested action input",
      (m) => ({
        steps: [{ index: 0, action: { tool: "x", input: { a: [{ b: m }] } }, observation: null }],
      }),
    ],
    ["claim", (m) => ({ claim: { done: true, text: `saved to ${m}` } })],
  ];

  for (const [markerName, marker] of MARKERS) {
    for (const [fieldName, put] of FIELDS) {
      it(`a ${markerName} in the ${fieldName} refuses the whole export, naming no value`, () => {
        const dir = out();
        const e = refusal(() =>
          exportDataset([candidate(1), candidate(2, put(marker))], {
            outDir: dir,
            hygiene: { forbiddenStrings: ["zz-operator-planted-marker"] },
          }),
        );
        expect(e.code).toBe("LEAK");
        expect(e.message).not.toContain(marker);
        expect(e.where.startsWith("task-2/run-2:$.")).toBe(true);
        expect(existsSync(dir)).toBe(false);
      });
    }
  }

  it("a leak in a provenance field or trial key is refused too, without echoing the key", () => {
    const hygiene = { forbiddenStrings: ["zz-operator-planted-marker"] };
    const home = ["/", "home", "/", "frank"].join("");
    // An absolute path cannot even be an id: the schema refuses it before the scan.
    const e0 = refusal(() =>
      exportDataset([candidate(1, { provenance: { ...candidate(1).provenance, harness: home } })], {
        outDir: out(),
      }),
    );
    expect(e0.code).toBe("SCHEMA_INVALID");
    const e1 = refusal(() =>
      exportDataset(
        [
          candidate(1, {
            provenance: { ...candidate(1).provenance, harness: "zz-operator-planted-marker" },
          }),
        ],
        { outDir: out(), hygiene },
      ),
    );
    expect(e1.code).toBe("LEAK");
    expect(e1.where).toBe("task-1/run-1:$.provenance.harness");
    const e2 = refusal(() =>
      exportDataset([candidate(1, { trialKey: "zz-operator-planted-marker/1" })], {
        outDir: out(),
        hygiene,
      }),
    );
    expect(e2.code).toBe("LEAK");
    expect(e2.message).not.toContain("zz-operator-planted-marker");
  });

  it("excluded runs are never scanned into the output (a leak in an excluded run does not block)", () => {
    const leakyExcluded = candidate(2, { gate: null, instruction: "zz-operator-planted-marker" });
    const r = exportDataset([candidate(1), leakyExcluded], {
      outDir: out(),
      hygiene: { forbiddenStrings: ["zz-operator-planted-marker"] },
    });
    expect(r.manifest.counts).toMatchObject({ records: 1, excluded: { MISSING_GATE: 1 } });
  });

  it("placeholders the backend writes are clean", () => {
    const c = candidate(1, {
      steps: [
        {
          index: 0,
          action: { tool: "x", input: { path: "<home>/doc.csv" } },
          observation: { kind: "text", text: "<desktop>/tmp ok; docs/var/x" },
        },
      ],
    });
    expect(exportDataset([c], { outDir: out() }).manifest.counts).toMatchObject({ records: 1 });
  });
});
