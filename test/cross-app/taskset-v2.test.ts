/**
 * Capability track P: xa-v2, the 40-task set the p-v1 bar runs on
 * (`docs/product/capability-spec-2.md` §P, "Task set"), is built by #535's builder and frozen
 * the same way as xa-v1: the committed bundle is the builder's output byte for byte, the
 * manifest pins every file, every spec is valid for the gate, and no task repeats an xa-v1
 * task. xa-v1 itself stays byte-identical (`taskset.test.ts`).
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { readNotice } from "../../src/gate/cross-app-demo.ts";
import { buildRegistry } from "../../src/gate/gate.ts";
import { fieldLabel } from "../../src/tasks/cross-app.ts";
import {
  buildXaTaskSet,
  renderXaBundle,
  XA_V1,
  XA_V2,
  type XaTask,
  xaTaskIds,
} from "../../src/tasks/cross-app-taskset.ts";

const ROOT = resolve(import.meta.dirname, "..", "..");
const BUNDLE = join(ROOT, "benchmark", "cross-app", "xa-v2");
const sha256 = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
const rendered = renderXaBundle(XA_V2);
const tasks = readFileSync(join(BUNDLE, "tasks.jsonl"), "utf8")
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line) as XaTask);

describe("xa-v2 bundle", () => {
  it("has 40 tasks, xa-v2-001 .. xa-v2-040", () => {
    expect(XA_V2.count).toBe(40);
    expect(tasks.map((t) => t.taskId)).toEqual(xaTaskIds(XA_V2));
    expect(tasks[0]?.taskId).toBe("xa-v2-001");
    expect(tasks[39]?.taskId).toBe("xa-v2-040");
    expect(new Set(tasks.map((t) => t.taskSetVersion))).toEqual(new Set(["xa-v2"]));
  });

  it("the committed bundle is what the builder writes, byte for byte, with no extra file", () => {
    const committed = [
      ...readdirSync(BUNDLE).filter((f) => f !== "fixtures"),
      ...readdirSync(join(BUNDLE, "fixtures")).map((f) => `fixtures/${f}`),
    ].sort();
    expect(committed).toEqual([...rendered.keys()].sort());
    for (const [path, content] of rendered)
      expect(readFileSync(join(BUNDLE, path), "utf8"), path).toBe(content);
  });

  it("--set xa-v2 --check exits 0 on the committed bundle; an unknown set exits 2", {
    timeout: 60_000,
  }, () => {
    const ok = spawnSync(
      "npx",
      ["tsx", "scripts/cross-app-taskset.ts", "--set", "xa-v2", "--check"],
      {
        cwd: ROOT,
        encoding: "utf8",
      },
    );
    expect(ok.status, ok.stderr).toBe(0);
    const bad = spawnSync(
      "npx",
      ["tsx", "scripts/cross-app-taskset.ts", "--set", "xa-v9", "--check"],
      {
        cwd: ROOT,
        encoding: "utf8",
      },
    );
    expect(bad.status).toBe(2);
  });

  it("the manifest pins every other file and names the set", () => {
    const manifest = JSON.parse(readFileSync(join(BUNDLE, "manifest.json"), "utf8")) as {
      files: Record<string, string>;
      tasks: number;
      taskSetVersion: string;
    };
    expect(manifest.tasks).toBe(40);
    expect(manifest.taskSetVersion).toBe("xa-v2");
    expect(Object.keys(manifest.files).sort()).toEqual(
      [...rendered.keys()].filter((p) => p !== "manifest.json").sort(),
    );
    for (const [path, digest] of Object.entries(manifest.files))
      expect(sha256(readFileSync(join(BUNDLE, path))), path).toBe(digest);
  });

  it("every task's fixtures match their digests; the values are in the notice, not the instruction", () => {
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
      for (const step of t.spec.steps)
        for (const e of step.edits) expect(t.instruction).not.toContain(e.newValue);
    }
  });

  it("every spec is valid for the gate and its digest is the one the gate records", () => {
    const registry = buildRegistry(
      tasks.map((t) => ({ id: t.taskId, family: t.family, stateFile: t.stateFile, spec: t.spec })),
    );
    for (const t of tasks) {
      expect(registry.get(t.taskId)?.specSha256).toBe(t.specSha256);
      expect(t.spec.steps.map((s) => s.app)).toEqual(["calc", "calc", "writer"]);
    }
  });

  it("no task repeats: 40 distinct specs, none shared with xa-v1, every typed column covered", () => {
    const v1 = new Set(buildXaTaskSet(XA_V1).tasks.map((t) => t.specSha256));
    const v2 = tasks.map((t) => t.specSha256);
    expect(new Set(v2).size).toBe(40);
    for (const d of v2) expect(v1.has(d)).toBe(false);
    const columns = new Set(
      tasks.flatMap((t) => t.spec.steps.flatMap((s) => s.edits.map((e) => e.column))),
    );
    expect([...columns].sort()).toEqual(["joined", "name", "qty", "salary"]);
  });
});
