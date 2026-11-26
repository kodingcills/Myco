/**
 * docs/product/demo-storyboard.md and the README's "Getting started": every operator command is
 * either runnable on main (and is run here, with its stated exit code) or marked "lands with
 * #<PR>". No VM, no model, no network: the commands are the mock gate demo, `myco-gate check`
 * on its output, and the corrections-loop test (#514, merged).
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..");
const DOC = readFileSync(join(ROOT, "docs/product/demo-storyboard.md"), "utf8");
const README = readFileSync(join(ROOT, "README.md"), "utf8");
const PENDING_PRS = new Set(["512", "513"]);
const PENDING = /# \(?lands with #(\d+)/;

function shellLines(markdown: string): string[] {
  const lines: string[] = [];
  for (const block of markdown.matchAll(/```sh\n([\s\S]*?)```/g))
    for (const line of (block[1] ?? "").split("\n"))
      if (line.trim() !== "" && !line.trim().startsWith("#")) lines.push(line.trim());
  return lines;
}

function section(markdown: string, heading: string): string {
  const start = markdown.indexOf(`\n## ${heading}\n`);
  expect(start, heading).toBeGreaterThanOrEqual(0);
  const end = markdown.indexOf("\n## ", start + 1);
  return markdown.slice(start, end === -1 ? undefined : end);
}

/** Shot-list rows: `| # | Time | Seconds | On screen | Narration | Operator runs |`. */
function shotRows(markdown: string): string[][] {
  return [...markdown.matchAll(/^\| \d+ \| \d:\d\d–\d:\d\d \|.*\|$/gm)].map((m) =>
    m[0]
      .slice(1, -1)
      .split(" | ")
      .map((c) => c.trim()),
  );
}

function flag(line: string, name: string): string | undefined {
  return new RegExp(`${name} "?([^" ]+)"?`).exec(line)?.[1];
}

function run(line: string, env: Record<string, string>) {
  return spawnSync("bash", ["-c", line], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: 60_000,
  });
}

const lines = shellLines(DOC);
const pending = lines.filter((l) => PENDING.test(l));
const setup = lines.filter((l): l is string => l === "OUT=$(mktemp -d)");
const runnable = lines.filter((l) => !pending.includes(l) && !setup.includes(l));

const readmeLines = shellLines(section(README, "Getting started"));
const readmePending = readmeLines.filter((l) => PENDING.test(l));
const readmeRunnable = readmeLines.filter(
  (l) => !readmePending.includes(l) && !l.startsWith("pnpm install "),
);

describe("demo storyboard commands", () => {
  const out = mkdtempSync(join(tmpdir(), "myco-storyboard-"));
  afterAll(() => rmSync(out, { recursive: true, force: true }));

  it("marks every command as runnable (with an exit code) or pending a known PR", () => {
    expect(setup).toHaveLength(1);
    expect(runnable.length).toBeGreaterThanOrEqual(5);
    expect(pending.length).toBeGreaterThanOrEqual(1);
    for (const line of [...pending, ...readmePending]) {
      const pr = PENDING.exec(line)?.[1] ?? "";
      expect(PENDING_PRS, line).toContain(pr);
    }
    for (const line of runnable) expect(line, line).toMatch(/ # exit \d+$/);
    // Flags that exist only on the pending branches never appear in a runnable line.
    for (const line of [...runnable, ...readmeRunnable])
      expect(line).not.toMatch(/myco-watch|myco init/);
  });

  it("never tells the operator to run a relative bin/myco (it targets the Myco checkout)", () => {
    for (const [name, text] of [
      ["storyboard", DOC],
      ["README", README],
    ] as const) {
      const relative = [...text.matchAll(/(^|[^\w/.-])(\.\/)?bin\/myco\b/gm)].map((m) => m[0]);
      expect(relative, name).toEqual([]);
    }
    for (const line of [...pending, ...readmePending].filter((l) => /myco init/.test(l)))
      expect(line).toMatch(/^\/path\/to\/Myco\/bin\/myco init --dry-run --project \S+ /);
  });

  it("the shot list has 8 contiguous beats, each with all six cells, summing to 90 s", () => {
    const rows = shotRows(DOC);
    expect(rows).toHaveLength(8);
    let clock = 0;
    const mmss = (t: string) => Number(t.split(":")[0]) * 60 + Number(t.split(":")[1]);
    rows.forEach((row, i) => {
      expect(row, row.join(" | ")).toHaveLength(6);
      for (const cell of row) expect(cell, row.join(" | ")).not.toBe("");
      expect(row[0]).toBe(String(i + 1));
      const [from, to] = (row[1] ?? "").split("–");
      expect(mmss(from ?? ""), row[1]).toBe(clock);
      expect(mmss(to ?? "") - clock, row[1]).toBe(Number(row[2]));
      clock = mmss(to ?? "");
    });
    expect(clock).toBe(90);
    const total = /^Total: ([\d + ]+) = 90 seconds\.$/m.exec(DOC)?.[1];
    expect(total).toBe(rows.map((r) => r[2]).join(" + "));
  });

  it("runs every main-today command with its stated exit code and the quoted output", () => {
    let stdout = "";
    for (const line of runnable) {
      const expected = Number(/ # exit (\d+)$/.exec(line)?.[1]);
      const result = run(line, { OUT: out });
      expect(result.status, `${line}\n${result.stderr}`).toBe(expected);
      stdout += result.stdout;
    }
    const quoted = [
      "refuted (not accepted): ORACLE_FAIL, CLAIM_RECORDED",
      "not persisted: bug: login page crashes on save, BUG: token expires too early",
      "step 2: TARGET_MISMATCH: cell C4 (record EMP-0003, column qty) does not hold the requested value",
      "verified (accepted): ORACLE_PASS, CLAIM_RECORDED",
      'correction: {"kind":"target_value_mismatch","step":2,"cell":"C4","record":"EMP-0003","column":"qty","expected":"4242","observed":"4224"}',
    ];
    for (const text of quoted) {
      expect(stdout).toContain(text);
      expect(DOC).toContain(text);
    }

    // Every `check` line names a run the demo actually logged for that task.
    for (const line of runnable.filter((l) => / check /.test(l))) {
      const root = (flag(line, "--evidence-root") ?? "").replace("$OUT", out);
      const log = join(root, "..", "gate-decisions.jsonl");
      expect(existsSync(log), line).toBe(true);
      const pairs = readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l).request as { taskId: string; runId: string })
        .map((r) => `${r.taskId}/${r.runId}`);
      expect(pairs, line).toContain(`${flag(line, "--task")}/${flag(line, "--run")}`);
    }

    // Beat 2 shows the run's whole timeline: one numbered call per decision the demo logged
    // for demo-df-s02 (the watch view reads this same log), with its verdict and first code.
    const beat2 = shotRows(DOC)[1]?.[3] ?? "";
    expect(beat2).toContain("run `demo-df-s02`");
    const decisions = readFileSync(join(out, "todo", "gate-decisions.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map(
        (l) =>
          JSON.parse(l) as { verdict: string; reasonCodes: string[]; request: { runId: string } },
      )
      .filter((d) => d.request.runId === "demo-df-s02");
    expect(decisions.length).toBeGreaterThanOrEqual(2);
    decisions.forEach((d, i) => {
      const call = new RegExp(`Call ${i + 1}[^.]*\`${d.verdict}\`[^.]*\`${d.reasonCodes[0]}\``);
      expect(beat2, `call ${i + 1}: ${d.verdict} ${d.reasonCodes[0]}`).toMatch(call);
    });
    expect(beat2).not.toContain(`Call ${decisions.length + 1}`);
    expect(beat2).toContain(`${["one", "two", "three", "four"][decisions.length - 1]} entries`);
  }, 120_000);

  it("runs the README's main-today demo line and backs its stated outcome", () => {
    expect(readmeRunnable).toEqual([
      expect.stringMatching(/^pnpm myco-gate demo --transport mock /),
    ]);
    const line = (readmeRunnable[0] ?? "").replace(/\s+#.*$/, "");
    const result = run(line, {});
    expect(result.status, `${line}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("DEMO: PASS");
    expect(README).toContain("The demo exits 0 and prints `DEMO: PASS`");
  }, 60_000);
});
