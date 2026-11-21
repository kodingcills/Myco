import { strToU8, zipSync } from "fflate";
import { describe, expect, test } from "vitest";
import type { RunFiles } from "../src/data/loaders.ts";
import { loadRunFiles } from "../src/data/loaders.ts";
import { parseRun } from "../src/data/parse.ts";
import type { ResultRecord, RunUpdate } from "../src/data/types.ts";

const result: ResultRecord = {
  recordKind: "session",
  runId: "example",
  startedAt: "2026-11-21T12:00:00Z",
  steps: [],
};
const action = {
  type: "action",
  timestamp: result.startedAt,
  step: 2,
  action: { kind: "type", text: "café" },
};
const trace = JSON.stringify(action);
const ledger = {
  evalId: "eval",
  runId: result.runId,
  trialIndex: 0,
  corruptionClass: "none",
  actionKind: "type",
  state: "pass",
  oracle: "ground-truth:true",
  refusalCode: null,
};
const manifest = {
  format: "mycotrace/1",
  runId: result.runId,
  files: { "trace.jsonl": "e".repeat(64) },
};

function selectedFile(name: string, text: string, webkitRelativePath: string) {
  return Object.defineProperty(new File([text], name), "webkitRelativePath", {
    value: webkitRelativePath,
  });
}

describe("evidence loaders", () => {
  test.each([0, 6] as const)(
    "opens a .mycotrace archive with compression level %s",
    async (level) => {
      const file = new File(
        [
          zipSync(
            {
              "run/result.json": strToU8(JSON.stringify(result)),
              "run/trace.jsonl": strToU8(trace),
              "run/ledger.jsonl": strToU8(JSON.stringify(ledger)),
              "run/manifest.json": strToU8(JSON.stringify(manifest)),
              "run/artifacts/screenshot-meta.json": strToU8('{"step":2}'),
            },
            { level },
          ),
        ],
        "example.mycotrace",
      );
      const files = await loadRunFiles([file]);
      const data = await parseRun(files);
      expect(data.result).toEqual(result);
      expect(data.byStep.get(2)?.[0]?.event).toEqual(action);
      expect(data.ledger).toEqual([{ value: ledger, source: { file: "ledger.jsonl", line: 1 } }]);
      expect(data.manifest).toEqual(manifest);
      expect(data.artifactPaths).toEqual(["artifacts/screenshot-meta.json"]);
      expect(await files.read("artifacts/screenshot-meta.json")?.text()).toBe('{"step":2}');
      expect(data.parseErrors).toEqual([]);
    },
  );

  test("opens a run folder using webkitRelativePath", async () => {
    const files = await loadRunFiles([
      selectedFile("screenshot.png", "image", "runs/example/artifacts/screenshot.png"),
      selectedFile("trace.jsonl", trace, "runs/example/trace.jsonl"),
      selectedFile("result.json", JSON.stringify(result), "runs/example/result.json"),
      selectedFile("README.md", "notes", "runs/example/README.md"),
    ]);
    expect((await parseRun(files)).artifactPaths).toEqual(["artifacts/screenshot.png"]);
    expect(await files.read("artifacts/screenshot.png")?.text()).toBe("image");
    expect(files.read("README.md")).toBeUndefined();
  });

  test("opens a bare pair and delivers result before touching the trace", async () => {
    const files = await loadRunFiles([
      new File([trace], "trace.jsonl"),
      new File([JSON.stringify(result)], "result.json"),
    ]);
    const order: string[] = [];
    const wrapped: RunFiles = {
      paths: files.paths,
      read(path) {
        order.push(path);
        return files.read(path);
      },
    };
    const updates: RunUpdate[] = [];
    const data = await parseRun(wrapped, (update) => {
      order.push(update.type);
      updates.push(update);
    });
    expect(order.slice(0, 3)).toEqual(["result.json", "result", "trace.jsonl"]);
    expect(updates[0]).toEqual({ type: "result", result, parseErrors: [] });
    expect(data.byStep.get(2)?.[0]).toEqual({
      kind: "standard",
      step: 2,
      event: action,
      source: { file: "trace.jsonl", line: 1 },
    });
  });

  test("rejects a selection containing two run folders", async () => {
    await expect(
      loadRunFiles([
        selectedFile("trace.jsonl", trace, "one/trace.jsonl"),
        selectedFile("trace.jsonl", trace, "two/trace.jsonl"),
      ]),
    ).rejects.toThrow("exactly one run folder");
  });

  test("keeps a trace when a folder has no result", async () => {
    const files = await loadRunFiles([selectedFile("trace.jsonl", trace, "example/trace.jsonl")]);
    expect(await parseRun(files)).toMatchObject({ result: undefined, parseErrors: [] });
  });

  test("collects syntax and schema errors with physical line numbers and keeps valid lines", async () => {
    const data = await parseRun(
      await loadRunFiles([
        new File([trace, "\r\n\r\n{broken\r\n", '{"type":"action"}\r\n', trace], "trace.jsonl"),
        new File([JSON.stringify(result)], "result.json"),
      ]),
    );
    expect(data.events.map((entry) => entry.source)).toEqual([
      { file: "trace.jsonl", line: 1 },
      { file: "trace.jsonl", line: 5 },
    ]);
    expect(data.parseErrors).toMatchObject([
      { source: { file: "trace.jsonl", line: 3 }, issues: [{ keyword: "json" }] },
      {
        source: { file: "trace.jsonl", line: 4 },
        issues: expect.arrayContaining([
          { keyword: "required", path: "$", message: 'missing required property "step"' },
        ]),
      },
    ]);
  });

  test("keeps both primary and sidecar additive events and counts copied lines once", async () => {
    const claim = {
      type: "claim",
      timestamp: result.startedAt,
      step: 2,
      field: "field",
      value: "value",
      source: "agent",
    };
    const future = { type: "future-event", step: "a future format", payload: { count: 1 } };
    const data = await parseRun(
      await loadRunFiles([
        selectedFile("trace.jsonl", `${trace}\n${JSON.stringify(future)}`, "run/trace.jsonl"),
        selectedFile(
          "trace.extended.jsonl",
          `${trace}\n${JSON.stringify(claim)}`,
          "run/trace.extended.jsonl",
        ),
      ]),
    );
    expect(data.events).toEqual([
      { kind: "standard", event: action, source: { file: "trace.jsonl", line: 1 }, step: 2 },
      { kind: "extended", event: future, source: { file: "trace.jsonl", line: 2 } },
      {
        kind: "standard",
        event: claim,
        source: { file: "trace.extended.jsonl", line: 2 },
        step: 2,
      },
    ]);
    expect(data.byStep.get(2)?.map(({ event }) => event)).toEqual([action, claim]);
    expect(data.parseErrors).toEqual([]);
  });
});
