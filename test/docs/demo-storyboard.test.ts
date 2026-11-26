/**
 * docs/product/demo-storyboard.md: every operator command is either runnable on main (and is
 * run here, with its stated exit code) or marked "lands with #<PR>". No VM, no model, no
 * network: the commands are the mock gate demo and `myco-gate check` on its output.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..");
const DOC = readFileSync(join(ROOT, "docs/product/demo-storyboard.md"), "utf8");
const PENDING_PRS = new Set(["512", "513", "514"]);

function shellLines(markdown: string): string[] {
  const lines: string[] = [];
  for (const block of markdown.matchAll(/```sh\n([\s\S]*?)```/g))
    for (const line of (block[1] ?? "").split("\n"))
      if (line.trim() !== "" && !line.trim().startsWith("#")) lines.push(line.trim());
  return lines;
}

const lines = shellLines(DOC);
const pending = lines.filter((l) => /# lands with #\d+/.test(l));
const setup = lines.filter((l): l is string => l === "OUT=$(mktemp -d)");
const runnable = lines.filter((l) => !pending.includes(l) && !setup.includes(l));

describe("demo storyboard commands", () => {
  const out = mkdtempSync(join(tmpdir(), "myco-storyboard-"));
  afterAll(() => rmSync(out, { recursive: true, force: true }));

  it("marks every command as runnable (with an exit code) or pending a known PR", () => {
    expect(setup).toHaveLength(1);
    expect(runnable.length).toBeGreaterThanOrEqual(5);
    expect(pending.length).toBeGreaterThanOrEqual(1);
    for (const line of pending) {
      const pr = /# lands with #(\d+)/.exec(line)?.[1] ?? "";
      expect(PENDING_PRS, line).toContain(pr);
    }
    for (const line of runnable) expect(line, line).toMatch(/ # exit \d+$/);
    // Flags that exist only on the pending branches never appear in a runnable line.
    for (const line of runnable) expect(line).not.toMatch(/myco-watch|--corrections|myco init/);
  });

  it("the shot list's beat seconds sum to 90", () => {
    const seconds = [...DOC.matchAll(/^\| \d \| \d:\d\d–\d:\d\d \| (\d+) \|/gm)].map((m) =>
      Number(m[1]),
    );
    expect(seconds).toHaveLength(8);
    expect(seconds.reduce((a, b) => a + b, 0)).toBe(90);
  });

  it("runs every main-today command with its stated exit code and the quoted output", () => {
    let stdout = "";
    for (const line of runnable) {
      const expected = Number(/ # exit (\d+)$/.exec(line)?.[1]);
      const result = spawnSync("bash", ["-c", line], {
        cwd: ROOT,
        env: { ...process.env, OUT: out },
        encoding: "utf8",
        timeout: 60_000,
      });
      expect(result.status, `${line}\n${result.stderr}`).toBe(expected);
      stdout += result.stdout;
    }
    const quoted = [
      "refuted (not accepted): ORACLE_FAIL, CLAIM_RECORDED",
      "not persisted: bug: login page crashes on save, BUG: token expires too early",
      "step 2: TARGET_MISMATCH: cell C4 (record EMP-0003, column qty) does not hold the requested value",
      "verified (accepted): ORACLE_PASS, CLAIM_RECORDED",
    ];
    for (const text of quoted) {
      expect(stdout).toContain(text);
      expect(DOC).toContain(text);
    }
  }, 120_000);
});
