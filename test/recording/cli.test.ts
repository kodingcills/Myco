/**
 * Track R CLI: `myco-record demo` runs the $0 scripted end to end and exits 0; `record` is
 * operator-only and refuses without an interactive terminal (nothing is recorded).
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { generateFixture } from "../../src/tasks/fixture.ts";

const ROOT = resolve(import.meta.dirname, "..", "..");
const dir = mkdtempSync(join(tmpdir(), "myco-record-cli-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const run = (args: string[]) =>
  spawnSync(
    process.execPath,
    ["--import", "tsx", join(ROOT, "scripts", "myco-record.ts"), ...args],
    {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 60_000,
    },
  );

describe("myco-record CLI", () => {
  it("demo: scripted human end to end, exit 0, banner on stderr", () => {
    const r = run(["demo", "--out", join(dir, "demo")]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toContain("MYCO IS RECORDING");
    expect(r.stdout).toMatch(/PASS {2}honest .*VERIFIED/);
    expect(r.stdout).toMatch(/PASS {2}skip-save .*REFUTED/);
  }, 60_000);

  it("record refuses without an interactive terminal and writes nothing", () => {
    const doc = join(dir, "doc.csv");
    writeFileSync(doc, generateFixture("cli").csv);
    const dest = join(dir, "rec.json");
    const r = run(["record", "--doc", doc, "--out", dest]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("operator-only");
    expect(existsSync(dest)).toBe(false);
  }, 60_000);

  it("usage errors exit 3", () => {
    expect(run(["nope"]).status).toBe(3);
    expect(run(["compile", "--recording"]).status).toBe(3);
  }, 60_000);
});
