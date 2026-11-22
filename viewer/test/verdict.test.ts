import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import { loadRunFiles } from "../src/data/loaders.ts";
import { parseRun } from "../src/data/parse.ts";
import type { ResultRecord, RunData } from "../src/data/types.ts";
import {
  deriveChecks,
  deriveComparatorRows,
  deriveFailuresAndRecovery,
  deriveVerdict,
} from "../src/data/verdict.ts";

async function fromFolder(
  path: string,
  edit = (_name: string, body: string): string | undefined => body,
  extra: Record<string, string> = {},
) {
  const folder = new URL(`${path}/`, import.meta.url);
  const entries = await readdir(folder, { withFileTypes: true });
  const files = await Promise.all(
    entries
      .filter((entry) => entry.isFile())
      .map(async ({ name }) => {
        const body = edit(name, await readFile(new URL(name, folder), "utf8"));
        return body === undefined
          ? []
          : [{ file: new File([body], name), relativePath: `run/${name}` }];
      }),
  );
  const added = Object.entries(extra).map(([name, body]) => ({
    file: new File([body], name),
    relativePath: `run/${name}`,
  }));
  return parseRun(await loadRunFiles([...files.flat(), ...added]));
}

const sha256 = (body: string) => createHash("sha256").update(body).digest("hex");

/** Edit one evidence file in a test copy and regenerate the manifest digests to match. */
async function fromEditedFolder(path: string, file: string, edit: (body: string) => string) {
  const folder = new URL(`${path}/`, import.meta.url);
  const edited = edit(await readFile(new URL(file, folder), "utf8"));
  const manifest = JSON.parse(await readFile(new URL("manifest.json", folder), "utf8"));
  manifest.files[file] = sha256(edited);
  return fromFolder(path, (name, body) =>
    name === file ? edited : name === "manifest.json" ? JSON.stringify(manifest) : body,
  );
}

const wrongClaim =
  '{"type":"claim","step":10,"source":"app-ui","field":"item-call-mom-persisted","value":"WRONG","timestamp":"2026-11-21T12:00:04.000Z"}\n';

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
    const data = await fromFolder(`${fixture}/recovered`, (name, body) => {
      if (name === "manifest.json") return;
      if (name !== "trace.jsonl") return body;
      return body
        .split("\n")
        .filter((line) => !line.includes('"type":"recovery"'))
        .join("\n");
    });
    expect(deriveVerdict(data)).toMatchObject({ label: "Recovered" });
    const guard = data.events.find(
      (entry) => entry.kind === "standard" && entry.event.type === "guard-failure",
    );
    expect(deriveVerdict(data).sources).toContainEqual(guard?.source);
  });

  test.each([
    ["none", "Verified"],
    ["retry-after-refresh", "Recovered"],
    ["aborted-uncertain", "Unknown"],
  ])("classifies recovery event %s as %s", async (event, label) => {
    const data = await fromFolder(`${fixture}/verified`, (name, body) => {
      if (name === "manifest.json") return;
      if (name !== "trace.jsonl") return body;
      return (
        body +
        JSON.stringify({
          type: "recovery",
          event,
          timestamp: "2026-11-21T12:00:04Z",
          stateVersion: 12,
        }) +
        "\n"
      );
    });
    expect(deriveVerdict(data).label).toBe(label);
  });

  test("a failed retry does not clear an aborted recovery", async () => {
    const data = await fromFolder(`${fixture}/verified`, (name, body) => {
      if (name === "manifest.json") return;
      if (name !== "trace.jsonl") return body;
      return (
        body +
        ["aborted-uncertain", "retry:1-failed"]
          .map(
            (event) =>
              `${JSON.stringify({
                type: "recovery",
                event,
                timestamp: "2026-11-21T12:00:05Z",
                stateVersion: 12,
              })}\n`,
          )
          .join("")
      );
    });
    expect(deriveVerdict(data)).toMatchObject({
      label: "Unknown",
      reason: {
        value: "Recovery ended in uncertainty",
        source: { file: "trace.jsonl", line: 110 },
      },
    });
  });

  test.each([7, 11])(
    "a replayed step %s postcondition cannot complete a step 6 guard failure",
    async (step) => {
      const recovered = await fromFolder(`${fixture}/recovered`);
      const guard = recovered.events.find(({ event }) => event.type === "guard-failure");
      const data = await fromFolder(`${fixture}/verified`, (name, body) => {
        if (name === "manifest.json") return;
        if (name !== "trace.jsonl") return body;
        const post = body
          .split("\n")
          .find((line) => line.includes(`"step":${step},"phase":"post"`));
        if (!guard?.raw || !post) throw new Error("Expected guard and passing postcondition");
        return `${body}${guard.raw}\n${post}\n`;
      });
      expect(deriveVerdict(data)).toMatchObject({
        label: "Unknown",
        reason: { value: "No completion follows the guard failure" },
      });
    },
  );

  test("only complete evidence can promote a verified result", async () => {
    const data = await fromFolder(`${fixture}/recovered`);
    for (const events of [[], data.events.slice(0, 64), data.events]) {
      expect(deriveVerdict({ ...data, events, validation: { kind: "pending" } })).toMatchObject({
        label: "Unknown",
        reason: { value: "Checking run evidence" },
      });
    }
  });

  test.each([true, false])(
    "detects removed recovery and guard failure (manifest supplied: %s)",
    async (withManifest) => {
      const data = await fromFolder(`${fixture}/recovered`, (name, body) => {
        if (name === "manifest.json" && !withManifest) return;
        if (name !== "trace.jsonl") return body;
        return body
          .split("\n")
          .filter((line) => !/"type":"(?:guard-failure|recovery)"/.test(line))
          .join("\n");
      });
      expect(deriveVerdict(data)).toMatchObject({
        label: "Unknown",
        reason: {
          value: withManifest
            ? "SHA-256 mismatch for trace.jsonl"
            : "Trace is missing failure or recovery evidence for step 6",
        },
      });
    },
  );

  test.each([
    ["different manifest ID", "run ID", (body: string) => body.replace("viewer-verified", "other")],
    [
      "uncovered result",
      "missing the digest for result.json",
      (body: string) => body.replace(/.*"result.json".*\n/, ""),
    ],
    [
      "uncovered trace",
      "missing the digest for trace.jsonl",
      (body: string) => body.replace(/.*"trace.jsonl".*\n/, ""),
    ],
    [
      "missing listed file",
      "missing file missing.json",
      (body: string) => body.replace('"files": {', `"files": {"missing.json":"${"e".repeat(64)}",`),
    ],
    [
      "malformed digest",
      "Invalid SHA-256 digest",
      (body: string) => body.replace(/"[a-f0-9]{64}"/, "42"),
    ],
  ] as const)("fails closed for %s", async (_name, reason, edit) => {
    const data = await fromFolder(`${fixture}/verified`, (name, body) =>
      name === "manifest.json" ? edit(body) : body,
    );
    expect(deriveVerdict(data).label).toBe("Unknown");
    expect(deriveVerdict(data).reason?.value).toContain(reason);
  });

  test.each([
    ["malformed JSON", (body: string) => `${body}{\n`, "Incomplete evidence"],
    [
      "another run",
      (body: string) => body.replace("viewer-verified", "other"),
      "Trace run identity",
    ],
    [
      "missing final action",
      (body: string) =>
        body
          .split("\n")
          .filter((line) => !line.includes('"step":11,"action":'))
          .join("\n"),
      "missing the recorded action",
    ],
  ] as const)("detects %s without a manifest", async (_label, edit, reason) => {
    const data = await fromFolder(`${fixture}/verified`, (name, body) => {
      if (name === "manifest.json") return;
      return name === "trace.jsonl" ? edit(body) : body;
    });
    expect(deriveVerdict(data).label).toBe("Unknown");
    expect(deriveVerdict(data).reason?.value).toContain(reason);
  });

  test("a schema violation in the last result step blocks a positive verdict", async () => {
    const data = await fromFolder(`${fixture}/verified`, (name, body) => {
      if (name === "manifest.json") return;
      if (name !== "result.json") return body;
      const result = JSON.parse(body);
      result.steps.at(-1).postconditionResults[0].passed = "true";
      return JSON.stringify(result);
    });
    expect(deriveVerdict(data)).toMatchObject({
      label: "Unknown",
      reason: { value: "The result record could not be read" },
    });
    expect(data.parseErrors[0]).toMatchObject({
      source: { file: "result.json", path: "" },
      issues: [{ path: "$", keyword: "anyOf" }],
    });
  });

  test("invalid UTF-8 in a JSON string cannot produce a positive verdict", async () => {
    const folder = new URL(`${fixture}/verified/`, import.meta.url);
    const result = await readFile(new URL("result.json", folder));
    const trace = await readFile(new URL("trace.jsonl", folder));
    const data = await parseRun(
      await loadRunFiles([
        new File([result], "result.json"),
        new File([trace, '{"type":"future","value":"', Uint8Array.of(0xff), '"}\n'], "trace.jsonl"),
      ]),
    );
    expect(deriveVerdict(data).label).toBe("Unknown");
    expect(data.parseErrors[0]).toMatchObject({
      source: { file: "trace.jsonl" },
      issues: [{ message: "Could not read UTF-8 JSON Lines" }],
    });
  });

  test("a matching ledger oracle supports False success without a recorded claim", async () => {
    const { result, ledger, validation } = await fromFolder(`${fixture}/false-success`);
    expect(deriveVerdict({ result, ledger, validation })).toMatchObject({
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

describe("positive verdicts contradicted by other evidence (beyond the literal §6.2 table)", () => {
  async function withClaim(folder: string, claim: string) {
    const trace = await readFile(new URL(`${folder}/trace.jsonl`, import.meta.url), "utf8");
    return fromFolder(folder, (name, body) => (name === "manifest.json" ? undefined : body), {
      "trace.extended.jsonl": trace + claim,
    });
  }

  test("an explicit claim that disagrees with the persisted value cannot read as Verified", async () => {
    const data = await withClaim(`${fixture}/verified`, wrongClaim);
    expect(data.result?.recordKind === "session" ? undefined : data.result?.verdict.status).toBe(
      "verified",
    );
    expect(deriveComparatorRows(data).find((row) => row.comparison === "disagree")).toMatchObject({
      claimedLabel: "claimed",
      claimed: { value: "WRONG" },
    });
    const verdict = deriveVerdict(data);
    expect(verdict).toMatchObject({ label: "Failed", subtype: "False success" });
    expect(verdict.reason?.value).toBe(
      "Stored verdict says verified, but claim WRONG contradicts persisted call mom (items[1].text)",
    );
    expect(verdict.sources).toContainEqual({ file: "trace.extended.jsonl", line: 110 });
  });

  test("an explicit claim that disagrees with a Recovered result also fails", async () => {
    const data = await withClaim(`${fixture}/recovered`, wrongClaim);
    expect(deriveVerdict(data)).toMatchObject({ label: "Failed", subtype: "False success" });
  });

  test("an agreeing explicit claim keeps Verified", async () => {
    const data = await withClaim(`${fixture}/verified`, wrongClaim.replace("WRONG", "call mom"));
    expect(deriveVerdict(data).label).toBe("Verified");
  });

  test("a derived-only claim keeps the stored verdict", async () => {
    const data = await fromFolder(`${fixture}/verified`);
    expect(
      deriveComparatorRows(data).every((row) => row.claimedLabel === "claimed (derived)"),
    ).toBe(true);
    expect(deriveVerdict(data).label).toBe("Verified");
  });

  test("ledger oracle ground-truth:false overrides a stored Verified result", async () => {
    const data = await fromEditedFolder(`${fixture}/verified`, "ledger.jsonl", (body) =>
      body.replace("verifier:verified+ground-truth", "ground-truth:false"),
    );
    expect(data.parseErrors).toEqual([]);
    expect(data.validation).toEqual({ kind: "complete", manifestChecked: true });
    const verdict = deriveVerdict(data);
    expect(verdict).toMatchObject({ label: "Failed", subtype: "False success" });
    expect(verdict.reason?.value).toBe(
      "Stored verdict says verified, but the ledger oracle is ground-truth:false",
    );
    expect(verdict.sources).toContainEqual({ file: "ledger.jsonl", line: 1 });
  });

  test("ground-truth:false for another run does not change a Verified result", async () => {
    const data = await fromFolder(`${fixture}/verified`, (name, body) =>
      name === "manifest.json"
        ? undefined
        : name === "ledger.jsonl"
          ? body
              .replace("verifier:verified+ground-truth", "ground-truth:false")
              .replace("viewer-verified", "someone-else")
          : body,
    );
    expect(deriveVerdict(data).label).toBe("Verified");
  });

  test("unknown event types in trace.jsonl are extended and cannot change a verdict", async () => {
    const data = await fromFolder(`${fixture}/verified`, (name, body) =>
      name === "manifest.json"
        ? undefined
        : name === "trace.jsonl"
          ? `${body}{"type":"vendor-note","verdict":"refuted","field":"item-call-mom-persisted","value":"WRONG"}\n`
          : body,
    );
    const extended = data.events.find((entry) => entry.event.type === "vendor-note");
    expect(extended).toMatchObject({ kind: "extended", source: { file: "trace.jsonl" } });
    expect(deriveVerdict(data).label).toBe("Verified");
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
