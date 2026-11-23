/**
 * `myco-run`'s contract (MVD-001 acceptance 1, 3, 4, 5).
 *
 * Three kinds of claim, each pinned by a test that fails when the claim breaks:
 *  - the summary names the claim, the observed persisted state and the verdict
 *    (acceptance 3), and a refuted run names the items the store lost;
 *  - the artifacts on disk are validated before success is reported, so a
 *    corrupted artifact exits non-zero instead of printing "verified"
 *    (acceptance 3);
 *  - the CLI is drivable with no TTY and no prompt, from argv alone, with
 *    explicit exit codes and a single JSON object under `--json` (acceptance 4's
 *    contract for an agent-less / non-interactive invocation).
 *
 * Each test that names a field deletes or corrupts the thing it asserts, so the
 * test cannot pass by accident on an unchanged implementation.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resultRecordSchema } from "../../schemas/result-record.ts";
import { validateSchema } from "../../schemas/validate.ts";
import type { LiveRunResult } from "../../src/discovery/live-runner.ts";
import {
  EXIT_ABORTED,
  EXIT_INVALID_ARTIFACTS,
  EXIT_USAGE,
  exitCodeFor,
  type RunEconomics,
  runTaskOnce,
} from "../../src/discovery/myco-run.ts";
import { validateRunDir } from "../../src/discovery/run-artifacts.ts";
import { renderRunSummary, summarize } from "../../src/discovery/run-summary.ts";

const root = join(import.meta.dirname, "..", "..");

function dir(): string {
  return mkdtempSync(join(tmpdir(), "myco-run-"));
}

/** Run the CLI with no controlling terminal: stdin is a closed pipe, not a TTY. */
function cli(args: readonly string[]) {
  return spawnSync("pnpm", ["exec", "tsx", "scripts/myco-run.ts", ...args], {
    cwd: root,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 120_000,
  });
}

const parsed = (value: unknown): RunRecordShape => {
  if (typeof value !== "object" || value === null) throw new Error("not an object");
  return value as RunRecordShape;
};

interface RunRecordShape {
  runId: string;
  verdict: { status: string };
  economics?: RunEconomics;
}

describe("myco-run mock task (acceptance 3)", () => {
  it("names the claim, the persisted state and the verdict for DF-S01", async () => {
    const out = dir();
    const outcome = await runTaskOnce({ task: "df-s01", transport: "mock", outDir: out });
    const summary = summarize(outcome, validateRunDir(outcome.runDir), 0);
    const text = renderRunSummary(summary);

    expect(outcome.result.status).toBe("verified");
    // The three named things, in the summary's own labels.
    expect(text).toContain('UI status line: "saved 4 item(s)"');
    expect(text).toContain('agent claim:    "All 4 items added and saved."');
    expect(text).toContain("2. Observed persisted state");
    expect(text).toContain("VERIFIED");

    // Mutation check: with the observed state stripped, the summary no longer
    // names the persisted items, and this assertion is what catches it.
    const noisy = {
      ...summary,
      observed: { ...summary.observed, persisted: [] as readonly string[] },
    };
    const stripped = renderRunSummary(noisy);
    for (const item of outcome.task.items) expect(text).toContain(`present  ${item}`);
    // The intent list still names the items; the observed section does not. That
    // is exactly the distinction a reader needs, so it is what is asserted.
    expect(stripped).not.toContain("present  update the release notes");
  });

  it("refutes DF-S02 and names the two missing items", async () => {
    const out = dir();
    const outcome = await runTaskOnce({ task: "df-s02", transport: "mock", outDir: out });
    const summary = summarize(outcome, validateRunDir(outcome.runDir), 0);
    const text = renderRunSummary(summary);
    expect(summary.verdict.status).toBe("refuted");
    expect(summary.observed.missing).toEqual([
      "bug: login page crashes on save",
      "BUG: token expires too early",
    ]);
    expect(summary.verdict.falseSuccess).toBe(true);
    for (const item of summary.observed.missing) expect(text).toContain(`MISSING  ${item}`);
    expect(text).toContain("REFUTED");
    expect(text).toContain("FALSE SUCCESS");
  });

  it("records the economics with mock provenance and an explicit model-cost gap", async () => {
    const out = dir();
    const outcome = await runTaskOnce({ task: "df-s01", transport: "mock", outDir: out });
    expect(outcome.economics.provenance).toBe("mock");
    expect(outcome.economics.wallClockBasis).toBe("mock-contract-double");
    expect(outcome.economics.wallClockMs).toBeGreaterThanOrEqual(0);
    expect(outcome.economics.modelCost.status).toBe("not-measured");
    // The field reaches the artifact, not only the in-memory result.
    const record = parsed(JSON.parse(readFileSync(join(outcome.runDir, "result.json"), "utf8")));
    expect(record.economics?.wallClockMs).toBe(outcome.economics.wallClockMs);
    expect(record.economics?.provenance).toBe("mock");
    expect(renderRunSummary(summarize(outcome, validateRunDir(outcome.runDir), 0))).toContain(
      "mock-contract-double",
    );
  });

  it("writes the claim events beside the persisted read", async () => {
    const out = dir();
    const outcome = await runTaskOnce({ task: "df-s02", transport: "mock", outDir: out });
    const events = readFileSync(join(outcome.runDir, "trace.jsonl"), "utf8")
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line: string): unknown => JSON.parse(line))
      .filter(
        (event): event is { type: string; source: string; value: string } =>
          typeof event === "object" && event !== null && "type" in event && event.type === "claim",
      );
    expect(events.map((event) => event.source).sort()).toEqual(["agent", "app-ui"]);
    expect(events.find((event) => event.source === "app-ui")?.value).toBe("saved 4 item(s)");
  });
});

describe("artifact validation (acceptance 3)", () => {
  it("accepts a written run, including the economics block the schema declares", async () => {
    const out = dir();
    const outcome = await runTaskOnce({ task: "df-s01", transport: "mock", outDir: out });
    const check = validateRunDir(outcome.runDir);
    expect(check.problems).toEqual([]);
    expect(check.ok).toBe(true);
    const record: unknown = JSON.parse(readFileSync(join(outcome.runDir, "result.json"), "utf8"));
    expect(validateSchema(record, resultRecordSchema)).toEqual([]);
  });

  it("rejects a mock latency labelled as a live one", async () => {
    const out = dir();
    const outcome = await runTaskOnce({ task: "df-s01", transport: "mock", outDir: out });
    const path = join(outcome.runDir, "result.json");
    const record = JSON.parse(readFileSync(path, "utf8")) as {
      economics: { provenance: string; wallClockBasis: string };
    };
    // A mock number relabelled as live is the exact misreading acceptance 5 forbids.
    record.economics.wallClockBasis = "live-guest";
    writeFileSync(path, JSON.stringify(record));
    expect(validateSchema(record, resultRecordSchema)).not.toEqual([]);
    expect(validateRunDir(outcome.runDir).ok).toBe(false);
  });

  it("fails a corrupted result.json that is still readable JSON", async () => {
    const out = dir();
    const outcome = await runTaskOnce({ task: "df-s01", transport: "mock", outDir: out });
    const path = join(outcome.runDir, "result.json");
    writeFileSync(path, JSON.stringify({ runId: "df-s01" }));
    const check = validateRunDir(outcome.runDir);
    expect(check.ok).toBe(false);
    expect(check.problems.some((problem) => problem.file === "result.json")).toBe(true);
  });

  it("fails a trace line that drifts from the event schema", async () => {
    const out = dir();
    const outcome = await runTaskOnce({ task: "df-s01", transport: "mock", outDir: out });
    const path = join(outcome.runDir, "trace.jsonl");
    const text = readFileSync(path, "utf8");
    writeFileSync(path, `${text}${JSON.stringify({ type: "observation" })}\n`);
    const check = validateRunDir(outcome.runDir);
    expect(check.ok).toBe(false);
    expect(check.problems.some((problem) => problem.file.startsWith("trace.jsonl["))).toBe(true);
  });

  it("fails a trace whose runId belongs to a different run", async () => {
    const out = dir();
    const outcome = await runTaskOnce({ task: "df-s01", transport: "mock", outDir: out });
    const path = join(outcome.runDir, "trace.jsonl");
    const lines = readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => line.length > 0);
    const first: unknown = JSON.parse(lines[0] ?? "{}");
    if (typeof first !== "object" || first === null) throw new Error("no run-start");
    lines[0] = JSON.stringify({ ...first, runId: "some-other-run" });
    writeFileSync(path, `${lines.join("\n")}\n`);
    const check = validateRunDir(outcome.runDir);
    expect(check.problems.map((problem) => problem.message).join(" ")).toContain(
      'trace belongs to run "some-other-run"',
    );
  });

  it("makes the exit code depend on the validator, so a bypass cannot reach 0", () => {
    const verdict = { status: "refuted" } as LiveRunResult;
    expect(exitCodeFor(verdict, { ok: true })).toBe(0);
    expect(exitCodeFor(verdict, { ok: false })).toBe(EXIT_INVALID_ARTIFACTS);
    expect(exitCodeFor({ status: "aborted" } as LiveRunResult, { ok: true })).toBe(EXIT_ABORTED);
  });

  it("fails an empty trace", async () => {
    const out = dir();
    const outcome = await runTaskOnce({ task: "df-s01", transport: "mock", outDir: out });
    writeFileSync(join(outcome.runDir, "trace.jsonl"), "");
    const check = validateRunDir(outcome.runDir);
    expect(check.ok).toBe(false);
    expect(check.problems.some((problem) => problem.message.includes("empty trace"))).toBe(true);
  });
});

describe("CLI contract for a non-interactive agent (acceptance 4)", () => {
  it("runs a mock task with no TTY and exits 0 with valid artifacts", () => {
    const out = dir();
    const run = cli(["--transport", "mock", "--task", "df-s01", "--out", out]);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("1. Claim");
    expect(run.stdout).toContain("2. Observed persisted state");
    expect(run.stdout).toContain("3. Verdict");
    expect(run.stdout).toContain("VERIFIED");
    expect(run.stdout).toContain("artifacts: VALID");
    expect(readFileSync(join(out, "df-s01", "result.json"), "utf8")).toContain('"economics"');
  });

  it("prints exactly one JSON object under --json and nothing else on stdout", () => {
    const out = dir();
    const run = cli(["--transport", "mock", "--task", "df-s02", "--out", out, "--json"]);
    expect(run.status).toBe(0);
    const value: unknown = JSON.parse(run.stdout);
    expect(value).toMatchObject({ taskId: "df-s02", transport: "mock" });
    const summary = value as {
      verdict: { status: string; falseSuccess: boolean };
      observed: { missing: string[] };
      claim: { uiStatusText: string };
      economy: unknown;
    };
    expect(summary.verdict.status).toBe("refuted");
    expect(summary.verdict.falseSuccess).toBe(true);
    expect(summary.observed.missing).toHaveLength(2);
    expect(summary.claim.uiStatusText).toBe("saved 4 item(s)");
  });

  it("re-validates a corrupted artifact with --validate-only and exits 2", () => {
    const out = dir();
    expect(cli(["--task", "df-s01", "--out", out]).status).toBe(0);
    const clean = cli(["--task", "df-s01", "--out", out, "--validate-only"]);
    expect(clean.status).toBe(0);
    expect(clean.stdout).toContain("ARTIFACTS: VALID");
    // Several task dirs can share one --out; the check must say which it read.
    expect(clean.stdout).toContain("task: df-s01");

    const path = join(out, "df-s01", "result.json");
    const record = JSON.parse(readFileSync(path, "utf8")) as {
      verdict: { status: string };
    };
    record.verdict.status = "probably-fine";
    writeFileSync(path, JSON.stringify(record));
    const corrupt = cli(["--task", "df-s01", "--out", out, "--validate-only"]);
    expect(corrupt.status).toBe(EXIT_INVALID_ARTIFACTS);
    expect(corrupt.stdout).toContain("ARTIFACTS: INVALID");
    expect(corrupt.stdout).toContain("probably-fine");
  });

  it("exits 3 on a usage error and 1 when the live gate is not passed", () => {
    expect(cli(["--task", "df-s01"]).status).toBe(EXIT_USAGE);
    expect(cli(["--task", "df-s01", "--out"]).status).toBe(EXIT_USAGE);
    const ungated = cli(["--transport", "live", "--task", "df-s01", "--out", dir()]);
    expect(ungated.status).toBe(EXIT_ABORTED);
    expect(ungated.stderr).toContain("Coordinator's GO");
  });

  it("refuses a live run when another run holds the host lock", () => {
    const lock = join(dir(), "myco-host.lock");
    writeFileSync(lock, `${process.pid}\n`);
    const gated = cli([
      "--transport",
      "live",
      "--task",
      "df-s01",
      "--out",
      dir(),
      "--gate-passed",
      "--host-lock",
      lock,
    ]);
    expect(gated.status).toBe(EXIT_ABORTED);
    expect(gated.stderr).toContain("host lock");
    // The refused run must not take the lock away from its owner.
    expect(readFileSync(lock, "utf8").trim()).toBe(String(process.pid));
  });
});
