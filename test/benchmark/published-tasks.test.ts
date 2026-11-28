/**
 * The published task set, read from its committed bundle and pinned by SHA-256
 * (`src/benchmark/published-tasks.ts`; #547 O1 follow-up). The binding and the corrections A/B
 * read it instead of rebuilding fc-v1 with the task generators, so these tests pin: it equals the
 * builder's tasks (no binding changes), the bytes are pinned, and each row and count check bites.
 */
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkTaskRows,
  PUBLISHED_TASK_SETS,
  parsePublishedTasks,
  publishedTasks,
  REPO_ROOT,
} from "../../src/benchmark/published-tasks.ts";
import { buildTaskSet } from "../../src/benchmark/taskset.ts";
import { knownTaskSet } from "../../src/benchmark/taskset-binding.ts";
import { STAGE0_TASK_IDS } from "../../src/m2/corrections-ab.ts";

const BUNDLE = join(REPO_ROOT, "benchmark", "false-completion", "fc-v1");
const BYTES = readFileSync(join(BUNDLE, "tasks.jsonl"));
const TEXT = BYTES.toString("utf8");
const LINES = TEXT.split("\n").filter((l) => l !== "");
const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");

/** The text with row `i` replaced by `edit(row)`. */
const withRow = (i: number, edit: (r: Record<string, unknown>) => unknown) =>
  LINES.map((l, k) => (k === i ? JSON.stringify(edit(JSON.parse(l))) : l)).join("\n");

describe("the published fc-v1 task set (#547 O1 follow-up)", () => {
  it("is the builder's task set, row for row, so reading it changes no binding", () => {
    expect(publishedTasks("fc-v1")).toEqual(buildTaskSet().tasks);
    expect(knownTaskSet("fc-v1")).toEqual(buildTaskSet().tasks);
    expect([...STAGE0_TASK_IDS]).toEqual(
      buildTaskSet()
        .tasks.filter((t) => t.inDemo)
        .map((t) => t.taskId),
    );
  });

  it("pins the committed tasks.jsonl by sha256, and the manifest agrees", () => {
    expect(PUBLISHED_TASK_SETS["fc-v1"]?.tasksSha256).toBe(sha(BYTES));
    const manifest = JSON.parse(readFileSync(join(BUNDLE, "manifest.json"), "utf8")) as {
      files: Record<string, string>;
    };
    expect(manifest.files["tasks.jsonl"]).toBe(sha(BYTES));
  });

  it("refuses any other bytes before parsing, a one-byte edit included", () => {
    const edited = Buffer.from(BYTES);
    edited[10] = (edited[10] as number) ^ 1;
    expect(() => parsePublishedTasks("fc-v1", edited)).toThrow(
      /fc-v1 tasks.jsonl is not the published file \(sha256 [0-9a-f]{64}, pinned 59d10dd1/,
    );
    // A forged hash with a matching instruction would still need the pin to move.
    const forged = Buffer.from(withRow(0, (r) => ({ ...r, fixtureSha256: "0".repeat(64) })));
    expect(() => parsePublishedTasks("fc-v1", forged)).toThrow(/not the published file/);
  });

  it("an unpublished version binds nothing; a missing bundle throws", () => {
    expect(publishedTasks("fc-v2")).toBeUndefined();
    expect(() => parsePublishedTasks("fc-v2", BYTES)).toThrow(/is not published/);
    const empty = mkdtempSync(join(tmpdir(), "no-bundle-"));
    try {
      expect(() => publishedTasks("fc-v1", empty)).toThrow(/ENOENT/);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it("reads the bundle under the given root, and a substituted file there is refused", () => {
    const root = mkdtempSync(join(tmpdir(), "bundle-"));
    try {
      const dir = join(root, "benchmark", "false-completion", "fc-v1");
      cpSync(BUNDLE, dir, { recursive: true });
      expect(publishedTasks("fc-v1", root)).toHaveLength(100);
      const other = mkdtempSync(join(tmpdir(), "bundle-"));
      try {
        cpSync(BUNDLE, join(other, "benchmark", "false-completion", "fc-v1"), { recursive: true });
        writeFileSync(
          join(other, "benchmark", "false-completion", "fc-v1", "tasks.jsonl"),
          withRow(0, (r) => ({ ...r, faultClass: "kill-app" })),
        );
        expect(() => publishedTasks("fc-v1", other)).toThrow(/not the published file/);
      } finally {
        rmSync(other, { recursive: true, force: true });
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  describe("each row and count check bites (without the pin)", () => {
    it("accepts the committed text", () => {
      expect(checkTaskRows("fc-v1", TEXT)).toHaveLength(100);
    });
    const rowCases: [string, (r: Record<string, unknown>) => unknown, RegExp][] = [
      ["not an object", () => [1], /line 1: not an object/],
      ["schema", (r) => ({ ...r, schema: "x" }), /line 1: schema is not myco.benchmark.task\/1/],
      ["version", (r) => ({ ...r, taskSetVersion: "fc-v0" }), /taskSetVersion is not fc-v1/],
      ["taskId", (r) => ({ ...r, taskId: "fc-v1-1" }), /taskId malformed/],
      ["missing field", ({ taskId: _t, ...r }) => r, /taskId missing/],
      ["family", (r) => ({ ...r, family: "writer" }), /family is not calc-record-edit/],
      ["faultClass", (r) => ({ ...r, faultClass: "tamper" }), /faultClass unknown/],
      ["inDemo", (r) => ({ ...r, inDemo: "yes" }), /inDemo\/satisfiable not boolean/],
      ["satisfiable", (r) => ({ ...r, satisfiable: 1 }), /inDemo\/satisfiable not boolean/],
      [
        "instruction hash shape",
        (r) => ({ ...r, instructionSha256: "ab" }),
        /instructionSha256 malformed/,
      ],
      [
        "instruction hash value",
        (r) => ({ ...r, instruction: `${r.instruction} ` }),
        /instructionSha256 is not the instruction's sha256/,
      ],
      ["fixture hash shape", (r) => ({ ...r, fixtureSha256: "XY" }), /fixtureSha256 malformed/],
      [
        "fixture path",
        (r) => ({ ...r, fixtureFile: "fixtures/other.csv" }),
        /fixtureFile is not content-addressed by fixtureSha256/,
      ],
      ["fixture seed", ({ fixtureSeed: _s, ...r }) => r, /fixtureSeed missing/],
      ["intent", (r) => ({ ...r, intent: { rowKey: "EMP-1" } }), /intent malformed/],
      ["columnTypes", (r) => ({ ...r, columnTypes: null }), /columnTypes malformed/],
      ["persistedFormat", (r) => ({ ...r, persistedFormat: "csv" }), /persistedFormat is not xlsx/],
    ];
    for (const [name, edit, msg] of rowCases) {
      it(`refuses a row with a bad ${name}`, () => {
        expect(() => checkTaskRows("fc-v1", withRow(0, edit))).toThrow(msg);
      });
    }
    it("refuses a duplicated task, a missing task, and wrong unsatisfiable or demo counts", () => {
      const dup = [...LINES.slice(0, 99), LINES[0]].join("\n");
      expect(() => checkTaskRows("fc-v1", dup)).toThrow(/1 duplicated task id\(s\)/);
      expect(() => checkTaskRows("fc-v1", LINES.slice(1).join("\n"))).toThrow(
        /99 tasks, published 100/,
      );
      const unsat = LINES.findIndex((l) => l.includes('"satisfiable":false'));
      expect(() =>
        checkTaskRows(
          "fc-v1",
          withRow(unsat, (r) => ({ ...r, satisfiable: true })),
        ),
      ).toThrow(/9 unsatisfiable tasks, published 10/);
      expect(() =>
        checkTaskRows(
          "fc-v1",
          withRow(0, (r) => ({ ...r, inDemo: false })),
        ),
      ).toThrow(/29 demo tasks, published 30/);
    });
  });
});
