import { readdir, readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import { loadRunFiles } from "../src/data/loaders.ts";
import { parseRun } from "../src/data/parse.ts";
import type { ResultRecord, RunData, ViewTraceEvent } from "../src/data/types.ts";
import {
  deriveChecks,
  deriveComparatorRows,
  deriveFailuresAndRecovery,
  deriveVerdict,
} from "../src/data/verdict.ts";

async function fromFolder(path: string) {
  const folder = new URL(`${path}/`, import.meta.url);
  const entries = await readdir(folder, { withFileTypes: true });
  const files = await Promise.all(
    entries
      .filter((entry) => entry.isFile())
      .map(async ({ name }) => ({
        file: new File([await readFile(new URL(name, folder))], name),
        relativePath: `run/${name}`,
      })),
  );
  return parseRun(await loadRunFiles(files));
}

const sample = "../../docs/research/experiments/m1-013-session1";
const fixture = "../../foundry/viewer-fixtures";

describe("verdict mapping", () => {
  test.each([
    [`${sample}/normal-711e16c1`, "Verified", undefined],
    [`${sample}/kill-87ee5b14`, "Unknown", undefined],
    [`${sample}/refuted-autocorrect-d7ad45bf`, "Failed", undefined],
    [`${fixture}/verified`, "Verified", undefined],
    [`${fixture}/recovered`, "Recovered", undefined],
    [`${fixture}/false-success`, "Failed", "False success"],
    [`${fixture}/unknown`, "Unknown", undefined],
  ])("%s maps to %s (%s)", async (folder, label, subtype) => {
    const data = await fromFolder(folder);
    const verdict = deriveVerdict(data);
    expect(data.parseErrors).toEqual([]);
    expect(verdict.label).toBe(label);
    expect(verdict.subtype).toBe(subtype);
    expect(verdict.sources.length).toBeGreaterThan(0);
  });

  test("session records are not scored and missing results are unknown", () => {
    expect(deriveVerdict({})).toEqual({ label: "Unknown", sources: [] });
    const result: ResultRecord = {
      recordKind: "session",
      runId: "session",
      startedAt: "now",
      steps: [],
    };
    expect(deriveVerdict({ result })).toMatchObject({
      label: "Unknown",
      subtype: "Not scored",
      sources: [{ file: "result.json", path: "/recordKind" }],
    });
  });

  test("a null check stays unknown even with a scored status", async () => {
    const { result } = await fromFolder(`${fixture}/verified`);
    if (!result || result.recordKind === "session") throw new Error("Expected scored run fixture");
    result.verdict.checks[0]!.passed = null;
    expect(deriveVerdict({ result }).label).toBe("Unknown");
    expect(deriveChecks(result)[0]?.label).toBe("Unknown");
    result.verdict.checks[0]!.passed = false;
    expect(deriveVerdict({ result }).label).toBe("Unknown");
    expect(deriveChecks(result)[0]?.label).toBe("Failed");
  });

  test("a guard failure followed by completion counts as recovery", async () => {
    const data = await fromFolder(`${fixture}/recovered`);
    const events = data.events.filter(
      (entry) => entry.kind !== "standard" || entry.event.type !== "recovery",
    );
    expect(deriveVerdict({ ...data, events })).toMatchObject({ label: "Recovered" });
    const guard = events.find(
      (entry) => entry.kind === "standard" && entry.event.type === "guard-failure",
    );
    expect(deriveVerdict({ ...data, events }).sources).toContainEqual(guard?.source);
  });

  test("an aborted-uncertain event alone does not count as recovery", async () => {
    const { result } = await fromFolder(`${fixture}/verified`);
    const events: ViewTraceEvent[] = [
      {
        kind: "standard",
        event: { type: "recovery", event: "aborted-uncertain", timestamp: "now", stateVersion: 0 },
        source: { file: "trace.jsonl", line: 1 },
      },
    ];
    expect(deriveVerdict({ result, events }).label).toBe("Verified");
  });

  test("a matching ledger oracle supports False success without a recorded claim", async () => {
    const { result, ledger } = await fromFolder(`${fixture}/false-success`);
    expect(deriveVerdict({ result, ledger })).toMatchObject({
      label: "Failed",
      subtype: "False success",
      sources: [
        { file: "result.json", path: "/verdict/status" },
        { file: "ledger.jsonl", line: 1 },
      ],
    });
    const otherRun: RunData["ledger"] = ledger.map((row) => ({
      ...row,
      value: { ...row.value, runId: "different-run" },
    }));
    const data = await fromFolder(`${sample}/refuted-autocorrect-d7ad45bf`);
    expect(deriveVerdict({ ...data, ledger: otherRun }).subtype).toBeUndefined();
  });
});

describe("source-linked Proof data", () => {
  test("joins an explicit claim to its persisted check and puts the disagreement first", async () => {
    const data = await fromFolder(`${fixture}/false-success`);
    const rows = deriveComparatorRows(data);
    expect(rows[0]).toMatchObject({
      field: "items[1].text",
      claimedLabel: "claimed",
      claimed: { value: "call mom", source: { file: "trace.extended.jsonl", line: 111 } },
      persisted: { status: "absent", source: { file: "result.json", path: "/verdict/checks/1" } },
      comparison: "disagree",
    });
    expect(rows[1]).toMatchObject({
      claimedLabel: "claimed (derived)",
      intent: { value: "buy milk", source: { file: "result.json", path: "/taskParams/items/0" } },
      persisted: { status: "value", value: "buy milk" },
      comparison: "agree",
    });
    expect(deriveVerdict({ ...data, ledger: [] }).subtype).toBe("False success");
  });

  test("derives a claimed cell value from its observed postcondition", async () => {
    const [normal, refuted] = await Promise.all([
      fromFolder(`${sample}/normal-711e16c1`),
      fromFolder(`${sample}/refuted-autocorrect-d7ad45bf`),
    ]);
    expect(deriveComparatorRows(normal)).toMatchObject([
      {
        field: "B39",
        claimedLabel: "claimed (derived)",
        claimed: {
          value: "REVISED-SESSION1",
          source: { file: "result.json", path: "/steps/2/postconditionResults/0/observed" },
        },
        persisted: { status: "value", value: "REVISED-SESSION1" },
        comparison: "agree",
      },
    ]);
    expect(deriveComparatorRows(refuted)).toMatchObject([
      {
        claimed: { value: "Revised-908578" },
        intent: { value: "revised-908578" },
        persisted: { status: "not recorded" },
        comparison: "not recorded",
      },
    ]);
  });

  test("preserves an unresolved readback and its verifier reason", async () => {
    const data = await fromFolder(`${sample}/kill-87ee5b14`);
    expect(deriveComparatorRows(data)[0]).toMatchObject({
      comparison: "unknown",
      persisted: { status: "could not look" },
      check: { value: { reason: data.result?.unresolvedState }, label: "Unknown" },
    });
    expect(deriveVerdict(data).reason).toEqual({
      value: data.result?.unresolvedState,
      source: { file: "result.json", path: "/unresolvedState" },
    });
  });

  test("keeps fault, guard and recovery items linked to their original evidence", async () => {
    const data = await fromFolder(`${fixture}/recovered`);
    expect(deriveFailuresAndRecovery(data)).toMatchObject([
      { kind: "fault-injection", source: { file: "trace.jsonl", line: expect.any(Number) } },
      { kind: "guard-failure", source: { file: "trace.jsonl", line: expect.any(Number) } },
      { kind: "recovery", source: { file: "trace.jsonl", line: expect.any(Number) } },
    ]);
    const killed = await fromFolder(`${sample}/kill-87ee5b14`);
    expect(deriveFailuresAndRecovery(killed)[0]).toMatchObject({
      kind: "guard-failure",
      alsoRecordedAt: { file: "result.json", path: "/guardFailure" },
    });
    expect(deriveFailuresAndRecovery({ result: killed.result })).toMatchObject([
      {
        kind: "guardFailure",
        source: { file: "result.json", path: "/guardFailure" },
      },
    ]);
  });
});
