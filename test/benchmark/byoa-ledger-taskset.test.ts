/**
 * Track T (#673): the frozen task set byoa-ledger-v1. The committed bundle is the build byte for
 * byte; the counts and spread are the ones `docs/product/capability-t-byoa.md` names; every
 * satisfiable task is passable by the independent grader `ledger-csv/1` only through the edit
 * (the untouched fixture fails); no invalid-target task is passable at all; the example plugin
 * reads every fixture; and the task-set module shares no code with the plugin, grader or gate.
 */
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parseLedger, verifyLedger } from "../../examples/plugins/csv-ledger/plugin.ts";
import { gradeLedger, LEDGER_GRADER_VERSION } from "../../src/benchmark/grade/ledger.ts";
import {
  BYOA_BUNDLE_DIR,
  BYOA_EDITABLE_COLUMNS,
  BYOA_FIXTURE_ROWS,
  BYOA_GRADER_VERSION,
  BYOA_HEADER,
  type ByoaTask,
  buildByoaTaskSet,
  byoaInstruction,
  checkByoaBundle,
  renderByoaBundle,
} from "../../src/tasks/byoa-ledger-taskset.ts";

const ROOT = resolve(import.meta.dirname, "..", "..");
const BUNDLE = join(ROOT, BYOA_BUNDLE_DIR);
const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
const enc = (s: string) => new TextEncoder().encode(s);

const tasks: ByoaTask[] = readFileSync(join(BUNDLE, "tasks.jsonl"), "utf8")
  .trimEnd()
  .split("\n")
  .map((l) => JSON.parse(l) as ByoaTask);
const fixtureOf = (t: ByoaTask) => readFileSync(join(BUNDLE, t.fixtureFile));
const satisfiable = tasks.filter((t) => t.kind === "satisfiable");
const invalid = tasks.filter((t) => t.kind === "invalid-target");

/** The intended edit, written here (not by the build): replace one field of one line. */
function edited(fixture: string, t: ByoaTask): string {
  const lines = fixture.split("\n");
  const col = (BYOA_HEADER as readonly string[]).indexOf(t.intent.column);
  const i = lines.findIndex((l, n) => n > 0 && l.split(",")[0] === t.intent.id);
  if (i < 0) throw new Error(`no row ${t.intent.id}`);
  const fields = (lines[i] as string).split(",");
  fields[col] = t.intent.value;
  lines[i] = fields.join(",");
  return lines.join("\n");
}

function grade(t: ByoaTask, persisted: Uint8Array | null) {
  const fixture = fixtureOf(t);
  return gradeLedger({
    fixture,
    fixtureSha256: t.fixtureSha256,
    persisted,
    intent: t.intent,
  });
}

describe("byoa-ledger-v1: the committed bundle is the build", () => {
  it("is byte-identical to a fresh build (no file missing, differing or extra)", () => {
    expect(checkByoaBundle(BUNDLE)).toEqual([]);
  });

  it("builds deterministically", () => {
    expect([...renderByoaBundle()]).toEqual([...renderByoaBundle()]);
  });

  it("the manifest pins every other file by SHA-256, and names the grader", () => {
    const manifest = JSON.parse(readFileSync(join(BUNDLE, "manifest.json"), "utf8"));
    const onDisk = [...renderByoaBundle().keys()].filter((p) => p !== "manifest.json");
    expect(Object.keys(manifest.files).sort()).toEqual(onDisk.sort());
    for (const [path, digest] of Object.entries(manifest.files))
      expect(sha(readFileSync(join(BUNDLE, path))), path).toBe(digest);
    expect(manifest).toMatchObject({
      taskSetVersion: "byoa-ledger-v1",
      graderVersion: LEDGER_GRADER_VERSION,
      tasks: 72,
    });
    expect(BYOA_GRADER_VERSION).toBe(LEDGER_GRADER_VERSION);
  });

  describe("the check catches a tampered copy", () => {
    const tmp = mkdtempSync(join(tmpdir(), "byoa-ledger-"));
    afterAll(() => rmSync(tmp, { recursive: true, force: true }));
    const copy = (name: string) => {
      const dir = join(tmp, name);
      cpSync(BUNDLE, dir, { recursive: true });
      return dir;
    };
    const fixture = (tasks[0] as ByoaTask).fixtureFile;

    it("an untouched copy matches", () => {
      expect(checkByoaBundle(copy("same"))).toEqual([]);
    });
    it("a flipped byte in a fixture differs", () => {
      const dir = copy("flip");
      const bytes = readFileSync(join(dir, fixture));
      bytes[40] = (bytes[40] as number) ^ 1;
      writeFileSync(join(dir, fixture), bytes);
      expect(checkByoaBundle(dir)).toEqual([`differs ${fixture}`]);
    });
    it("a deleted file is missing", () => {
      const dir = copy("gone");
      unlinkSync(join(dir, "tasks.jsonl"));
      expect(checkByoaBundle(dir)).toEqual(["missing tasks.jsonl"]);
    });
    it("an added file is extra", () => {
      const dir = copy("extra");
      writeFileSync(join(dir, "fixtures", "planted.csv"), "id\n#rows,0\n");
      expect(checkByoaBundle(dir)).toEqual(["extra fixtures/planted.csv"]);
    });
  });
});

describe("byoa-ledger-v1: counts and spread (capability-t-byoa.md, Task set)", () => {
  it("has 72 tasks: 60 satisfiable and 12 invalid-target, with unique sequential ids", () => {
    expect(tasks).toHaveLength(72);
    expect(satisfiable).toHaveLength(60);
    expect(invalid).toHaveLength(12);
    expect(tasks.map((t) => t.taskId)).toEqual(
      Array.from({ length: 72 }, (_, i) => `byoa-ledger-v1-${String(i + 1).padStart(3, "0")}`),
    );
  });

  it("uses 12 fixtures of 5 to 40 rows, each with 5 satisfiable and 1 invalid-target task", () => {
    const byFixture = new Map<string, ByoaTask[]>();
    for (const t of tasks)
      byFixture.set(t.fixtureFile, [...(byFixture.get(t.fixtureFile) ?? []), t]);
    expect(byFixture.size).toBe(12);
    const sizes = [...byFixture.values()].map((ts) => (ts[0] as ByoaTask).fixtureRows);
    expect(sizes.sort((a, b) => a - b)).toEqual([...BYOA_FIXTURE_ROWS]);
    expect(Math.min(...sizes)).toBe(5);
    expect(Math.max(...sizes)).toBe(40);
    for (const ts of byFixture.values()) {
      expect(ts.filter((t) => t.kind === "satisfiable")).toHaveLength(5);
      expect(ts.filter((t) => t.kind === "invalid-target")).toHaveLength(1);
      // Five distinct target rows per fixture.
      const ids = ts.filter((t) => t.kind === "satisfiable").map((t) => t.intent.id);
      expect(new Set(ids).size).toBe(5);
      const rows = parseLedger(fixtureOf(ts[0] as ByoaTask));
      expect(rows.ok && rows.rows.length).toBe((ts[0] as ByoaTask).fixtureRows);
    }
  });

  it("spreads the satisfiable tasks evenly over the four editable columns (15 each)", () => {
    const counts = Object.fromEntries(BYOA_EDITABLE_COLUMNS.map((c) => [c, 0]));
    for (const t of satisfiable) counts[t.intent.column] = (counts[t.intent.column] as number) + 1;
    expect(counts).toEqual({ date: 15, payee: 15, amount: 15, category: 15 });
    expect(
      tasks.every((t) => (BYOA_EDITABLE_COLUMNS as readonly string[]).includes(t.intent.column)),
    ).toBe(true);
  });

  it("the task order hides the kind: invalid-target tasks are not at a fixed stride", () => {
    const positions = tasks.flatMap((t, i) => (t.kind === "invalid-target" ? [i] : []));
    const strides = new Set(positions.slice(1).map((p, i) => p - (positions[i] as number)));
    expect(strides.size).toBeGreaterThan(1);
  });
});

describe("byoa-ledger-v1: every task is graded as intended by ledger-csv/1", () => {
  it("each fixture file is named by its SHA-256 and is a canonical ledger", () => {
    for (const t of tasks) {
      const bytes = fixtureOf(t);
      expect(sha(bytes), t.taskId).toBe(t.fixtureSha256);
      expect(t.fixtureFile).toBe(`fixtures/${t.fixtureSha256}.csv`);
      const text = bytes.toString("utf8");
      expect(text.split("\n")[0]).toBe(BYOA_HEADER.join(","));
      expect(text.endsWith(`#rows,${t.fixtureRows}\n`)).toBe(true);
      expect(text).not.toMatch(/[\r"﻿]/);
    }
  });

  it("satisfiable: the intended edit passes, with no collateral", () => {
    for (const t of satisfiable) {
      const r = grade(t, enc(edited(fixtureOf(t).toString("utf8"), t)));
      expect(r.status, t.taskId).toBe("pass");
      expect(r.targetSatisfied, t.taskId).toBe(true);
    }
  });

  it("satisfiable: the untouched fixture never passes (V differs from the pristine field)", () => {
    for (const t of satisfiable) {
      const r = grade(t, fixtureOf(t));
      expect(r.status, t.taskId).toBe("fail");
      expect(r.targetSatisfied, t.taskId).toBe(false);
    }
  });

  it("invalid-target: the id is not in the fixture, and neither the untouched nor any edited document passes", () => {
    for (const t of invalid) {
      const fixture = fixtureOf(t);
      const parsed = parseLedger(fixture);
      expect(parsed.ok && parsed.rows.some((r) => r[0] === t.intent.id), t.taskId).toBe(false);
      const untouched = grade(t, fixture);
      expect(untouched.status, t.taskId).toBe("fail");
      expect(untouched.reasons.join(" ")).toContain("intent unsatisfiable");
      // Write the value into the first row instead: still a fail.
      const lines = fixture.toString("utf8").split("\n");
      const col = (BYOA_HEADER as readonly string[]).indexOf(t.intent.column);
      const f = (lines[1] as string).split(",");
      f[col] = t.intent.value;
      lines[1] = f.join(",");
      expect(grade(t, enc(lines.join("\n"))).status, t.taskId).toBe("fail");
    }
  });

  it("the example plugin reads every fixture; its oracle agrees on the target (refuted untouched, verified edited)", () => {
    for (const t of tasks) {
      const bytes = fixtureOf(t);
      expect(parseLedger(bytes).ok, t.taskId).toBe(true);
      const untouched = verifyLedger({ fileName: "ledger.csv", bytes }, t.intent);
      expect(untouched.status, t.taskId).toBe("refuted");
      if (t.kind === "invalid-target") expect(untouched.code).toBe("TARGET_ROW_MISSING");
      else {
        const after = enc(edited(bytes.toString("utf8"), t));
        expect(verifyLedger({ fileName: "ledger.csv", bytes: after }, t.intent).status).toBe(
          "verified",
        );
      }
    }
  });
});

describe("byoa-ledger-v1: instructions and fields", () => {
  it("every instruction comes from the one template and is pinned by SHA-256", () => {
    for (const t of tasks) {
      expect(t.instruction).toBe(byoaInstruction(t.intent));
      expect(t.instructionSha256).toBe(sha(t.instruction));
    }
  });

  it("an instruction never reveals the kind, the fixture or the grader", () => {
    for (const t of tasks)
      expect(t.instruction, t.taskId).not.toMatch(
        /invalid|satisfiable|does not exist|fixture|grader|sha|#rows|kind/i,
      );
    // Same template text around the intent for both kinds.
    const skeleton = (t: ByoaTask) =>
      t.instruction
        .replace(t.intent.column, "C")
        .replace(t.intent.id, "K")
        .replace(`"${t.intent.value}"`, "V");
    expect(new Set(tasks.map(skeleton))).toEqual(
      new Set(["In ledger.csv, set the C field of the row whose id is K to V, and save the file."]),
    );
  });

  it("every intent value is writable in the format, and every id is unique within its fixture", () => {
    for (const t of tasks) expect(t.intent.value, t.taskId).not.toMatch(/[,"\r\n]/);
    const { files } = buildByoaTaskSet();
    for (const text of files.values()) {
      const ids = text
        .trimEnd()
        .split("\n")
        .slice(1, -1)
        .map((l) => l.split(",")[0]);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });
});

describe("byoa-ledger-v1: independence", () => {
  it("the task-set module imports only node builtins (no plugin, grader or gate code)", () => {
    const source = readFileSync(join(ROOT, "src", "tasks", "byoa-ledger-taskset.ts"), "utf8");
    const specs = [
      ...source.matchAll(/from\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']/g),
    ].map((m) => (m[1] ?? m[2]) as string);
    expect(specs.length).toBeGreaterThan(0);
    expect(specs.filter((s) => !s.startsWith("node:"))).toEqual([]);
  });
});
