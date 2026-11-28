/**
 * Capability track V: the orch-v1 task set is frozen and sealed. The committed bundle is what
 * the builder writes, byte for byte; the shape is spec-2 §2 V's (60 tasks, 2-4 gated Calc-CSV
 * parts); every part is a valid gate task with its own fixture and state file; and for every
 * part the gate and the independent grader agree on the honest edit (verified / pass) and on
 * the untouched fixture (refuted / fail).
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { type ColumnType, grade } from "../../src/benchmark/grade/grade.ts";
import { calcRecordEditFamily } from "../../src/gate/families.ts";
import { buildRegistry, specDigest } from "../../src/gate/gate.ts";
import {
  ORCH_TASK_COUNT,
  type OrchPart,
  type OrchTask,
  renderOrchBundle,
} from "../../src/orchestrate/orch-taskset.ts";

const ROOT = resolve(import.meta.dirname, "..", "..");
const BUNDLE = join(ROOT, "benchmark/orchestration/orch-v1");
const sha256 = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
const rendered = renderOrchBundle();
const tasks = readFileSync(join(BUNDLE, "tasks.jsonl"), "utf8")
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line) as OrchTask);
const allParts = tasks.flatMap((t) => t.parts);

/** The fixture with the part's edit applied (CSV, the format the gate reads for Calc). */
function edited(part: OrchPart): string {
  const csv = readFileSync(join(BUNDLE, part.fixtureFile), "utf8");
  const rows = csv
    .trimEnd()
    .split("\n")
    .map((r) => r.split(","));
  const header = rows[0] as string[];
  const col = header.indexOf(part.intent.column);
  const row = rows.find((r) => r[0] === part.intent.rowKey);
  if (col < 0 || row === undefined) throw new Error(`target missing for ${part.partId}`);
  row[col] = part.intent.newValue;
  return `${rows.map((r) => r.join(",")).join("\n")}\n`;
}

describe("orch-v1 bundle", () => {
  it("the committed bundle is what the builder writes, byte for byte, with no extra file", () => {
    const committed = [
      ...readdirSync(BUNDLE).filter((f) => f !== "fixtures"),
      ...readdirSync(join(BUNDLE, "fixtures")).map((f) => `fixtures/${f}`),
    ].sort();
    expect(committed).toEqual([...rendered.keys()].sort());
    for (const [path, content] of rendered)
      expect(readFileSync(join(BUNDLE, path), "utf8"), path).toBe(content);
  });

  it("--check exits 0 on the committed bundle", { timeout: 60_000 }, () => {
    const r = spawnSync("npx", ["tsx", "scripts/orch-taskset.ts", "--check"], {
      cwd: ROOT,
      encoding: "utf8",
    });
    expect(r.status, r.stderr).toBe(0);
  });

  it("the manifest pins every other file by its SHA-256", () => {
    const manifest = JSON.parse(readFileSync(join(BUNDLE, "manifest.json"), "utf8")) as {
      files: Record<string, string>;
      tasks: number;
      parts: number;
    };
    const others = [...rendered.keys()].filter((p) => p !== "manifest.json").sort();
    expect(Object.keys(manifest.files).sort()).toEqual(others);
    for (const p of others)
      expect(manifest.files[p], p).toBe(sha256(readFileSync(join(BUNDLE, p))));
    expect(manifest.tasks).toBe(ORCH_TASK_COUNT);
    expect(manifest.parts).toBe(allParts.length);
  });
});

describe("orch-v1 shape (spec-2 §2 V)", () => {
  it("has 60 tasks: 20 with 2 parts, 20 with 3, 20 with 4, ids in order", () => {
    expect(tasks).toHaveLength(60);
    expect(tasks.map((t) => t.taskId)).toEqual(
      Array.from({ length: 60 }, (_, i) => `orch-v1-${String(i + 1).padStart(3, "0")}`),
    );
    const counts = tasks.map((t) => t.parts.length);
    expect(counts.slice(0, 20).every((n) => n === 2)).toBe(true);
    expect(counts.slice(20, 40).every((n) => n === 3)).toBe(true);
    expect(counts.slice(40, 60).every((n) => n === 4)).toBe(true);
    expect(allParts).toHaveLength(180);
  });

  it("every part has its own id, fixture and seed; parts of a task never share a state file", () => {
    expect(new Set(allParts.map((p) => p.partId)).size).toBe(allParts.length);
    expect(new Set(allParts.map((p) => p.fixtureFile)).size).toBe(allParts.length);
    expect(new Set(allParts.map((p) => p.spec.fixtureSeed)).size).toBe(allParts.length);
    for (const t of tasks) {
      expect(new Set(t.parts.map((p) => p.stateFile)).size, t.taskId).toBe(t.parts.length);
      t.parts.forEach((p, k) => {
        expect(p.partId).toBe(`${t.taskId}-p${k + 1}`);
        expect(p.stateFile).toBe(`part-${k + 1}.csv`);
      });
    }
  });

  it("every part is a calc-record-edit gate task, CSV-only, and the gate registry accepts all 180", () => {
    for (const p of allParts) {
      expect(p.family).toBe("calc-record-edit");
      expect(p.spec.persistedFormat).toBe("csv");
      expect(calcRecordEditFamily.checkSpec(p.spec), p.partId).toBeUndefined();
      expect(p.specSha256).toBe(specDigest(p.spec));
      expect(p.intent).toEqual({
        rowKey: p.spec.rowKey,
        column: p.spec.column,
        newValue: p.spec.newValue,
      });
    }
    const registry = buildRegistry(
      allParts.map((p) => ({
        id: p.partId,
        family: p.family,
        stateFile: p.stateFile,
        spec: p.spec,
      })),
    );
    expect(registry.size).toBe(180);
  });

  it("the agent's instruction names every part's job and file, and no oracle internals", () => {
    for (const t of tasks) {
      expect(sha256(t.instruction)).toBe(t.instructionSha256);
      for (const p of t.parts) {
        expect(t.instruction).toContain(p.instruction);
        expect(p.instruction).toContain(p.stateFile);
        expect(sha256(p.instruction)).toBe(p.instructionSha256);
        expect(t.instruction).not.toContain(p.spec.fixtureSeed);
        expect(t.instruction).not.toContain(p.fixtureSha256);
      }
    }
  });

  it("spreads the four data columns across parts", () => {
    const columns = new Set(allParts.map((p) => p.intent.column));
    expect([...columns].sort()).toEqual(["joined", "name", "qty", "salary"]);
  });
});

describe("orch-v1 parts are gradable by both the gate and the independent grader", () => {
  it("the honest edit is gate-verified and grader-pass; the untouched fixture is refuted and fail", () => {
    for (const t of tasks)
      for (const p of t.parts) {
        const fixture = readFileSync(join(BUNDLE, p.fixtureFile));
        expect(sha256(fixture)).toBe(p.fixtureSha256);
        const honest = new TextEncoder().encode(edited(p));
        const base = {
          fixtureCsv: fixture,
          fixtureSha256: p.fixtureSha256,
          intent: p.intent,
          columnTypes: t.columnTypes as Record<string, ColumnType>,
        };
        expect(
          grade({ ...base, persisted: { format: "csv", bytes: honest } }).status,
          p.partId,
        ).toBe("pass");
        expect(
          grade({ ...base, persisted: { format: "csv", bytes: fixture } }).status,
          p.partId,
        ).toBe("fail");
        const ref = p.partId;
        expect(calcRecordEditFamily.decide(honest, p.spec, ref, {}).status, p.partId).toBe(
          "verified",
        );
        expect(calcRecordEditFamily.decide(fixture, p.spec, ref, {}).status, p.partId).toBe(
          "refuted",
        );
      }
  });
});
