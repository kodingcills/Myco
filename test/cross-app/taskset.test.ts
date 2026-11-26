/**
 * Capability track P, acceptance item 4: the cross-app task set xa-v1 is frozen and sealed.
 * The committed bundle is what the builder writes, byte for byte; every fixture is named and
 * pinned by its SHA-256; the manifest pins every file (pre-register by its digest); each
 * task's spec is valid for the gate, and its digest is the one the gate records.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { readNotice } from "../../src/gate/cross-app-demo.ts";
import { buildRegistry } from "../../src/gate/gate.ts";
import { fieldLabel } from "../../src/tasks/cross-app.ts";
import { renderXaBundle, XA_TASK_COUNT, type XaTask } from "../../src/tasks/cross-app-taskset.ts";
import { BUNDLE } from "./helpers.ts";

const ROOT = resolve(import.meta.dirname, "..", "..");
const sha256 = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
const rendered = renderXaBundle();
const tasks = readFileSync(join(BUNDLE, "tasks.jsonl"), "utf8")
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line) as XaTask);

describe("xa-v1 bundle", () => {
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
    const r = spawnSync("npx", ["tsx", "scripts/cross-app-taskset.ts", "--check"], {
      cwd: ROOT,
      encoding: "utf8",
    });
    expect(r.status, r.stderr).toBe(0);
  });

  it("the manifest pins every other file", () => {
    const manifest = JSON.parse(readFileSync(join(BUNDLE, "manifest.json"), "utf8")) as {
      files: Record<string, string>;
      tasks: number;
    };
    expect(manifest.tasks).toBe(XA_TASK_COUNT);
    expect(Object.keys(manifest.files).sort()).toEqual(
      [...rendered.keys()].filter((p) => p !== "manifest.json").sort(),
    );
    for (const [path, digest] of Object.entries(manifest.files))
      expect(sha256(readFileSync(join(BUNDLE, path))), path).toBe(digest);
  });

  it("every task's fixtures are named by and match their digests; the notice states the calc values", () => {
    expect(tasks).toHaveLength(XA_TASK_COUNT);
    for (const t of tasks) {
      for (const [file, digest] of [
        [t.fixtureFile, t.fixtureSha256],
        [t.reportTemplateFile, t.reportTemplateSha256],
        [t.sourceFile, t.sourceSha256],
      ] as const) {
        expect(file).toBe(`fixtures/${digest}.${file.split(".").pop()}`);
        expect(sha256(readFileSync(join(BUNDLE, file)))).toBe(digest);
      }
      expect(t.spec.source.sha256).toBe(t.sourceSha256);
      expect(sha256(t.instruction)).toBe(t.instructionSha256);
      const notice = readNotice(readFileSync(join(BUNDLE, t.sourceFile), "latin1"));
      for (const step of t.spec.steps.filter((s) => s.app === "calc"))
        for (const e of step.edits) expect(notice.get(fieldLabel(e))).toBe(e.newValue);
      // The values are in the notice, not in the instruction.
      for (const step of t.spec.steps)
        for (const e of step.edits) expect(t.instruction).not.toContain(e.newValue);
    }
  });

  it("every spec is valid for the gate and its digest is the one the gate records", () => {
    const registry = buildRegistry(
      tasks.map((t) => ({ id: t.taskId, family: t.family, stateFile: t.stateFile, spec: t.spec })),
    );
    for (const t of tasks) {
      const entry = registry.get(t.taskId);
      expect(entry?.specSha256).toBe(t.specSha256);
      expect(entry?.family.version).toBe(t.familyVersion);
      expect(entry?.stateFiles).toEqual([
        t.stateFile,
        ...t.evidenceFiles.filter((f) => f !== t.stateFile),
      ]);
    }
  });

  it("covers every typed data column across the set", () => {
    const columns = new Set(
      tasks.flatMap((t) => t.spec.steps.flatMap((s) => s.edits.map((e) => e.column))),
    );
    expect([...columns].sort()).toEqual(["joined", "name", "qty", "salary"]);
  });
});
