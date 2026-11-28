import { spawn } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The `df005` contract gates are Python programs, so vitest cannot discover them
 * directly. Without this wrapper they ran nowhere: `pnpm test` is vitest plus
 * schema-validate, and `test/df005-runner.selftest.sh` is referenced from no
 * workflow and no script.
 *
 * That gap is not academic. `df005-postcreate-gate.py` is the only test that
 * catches a `cleanup` that returns early and leaks the session, and it did not
 * run on the commit that introduced exactly that regression.
 *
 * Spawned asynchronously on purpose: the offline gate takes ~2 minutes, and a
 * `spawnSync` that long starves vitest's worker RPC, which then dies with
 * "Timeout calling onTaskUpdate" and reports an unhandled error instead of the
 * gate's real verdict.
 */

const root = join(import.meta.dirname, "..");

type GateResult = { status: number | null; output: string };

function run(script: string): Promise<GateResult> {
  const { promise, resolve } = Promise.withResolvers<GateResult>();
  const child = spawn("python3", [join(root, "test", script)], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (b) => {
    output += String(b);
  });
  child.stderr.on("data", (b) => {
    output += String(b);
  });
  child.on("close", (status) => resolve({ output, status }));
  return promise;
}

/**
 * Run a gate and require that it did work before it said PASSED.
 *
 * Asserting only `PASSED` + exit 0 made this wrapper trust its subject's own
 * self-report: replacing both gate files with `print('PASSED: 0 failure(s)')`
 * left two green tests over two no-op scripts.
 *
 * Each `expect(...)` in a gate prints one `ok`/`FAIL` line, so counting them
 * requires the gate to have run assertions. `minAssertions` is a floor, not an
 * exact number, so adding assertions does not require touching this file; the
 * real counts are 24 and 153, so both floors sit below with room.
 *
 * **What this does NOT do.** A gate that prints a hundred plausible `ok` lines
 * and exits 0 defeats it - a verifier demonstrated exactly that in three lines.
 * This is a higher bar, not independent evidence; any gate that can print is
 * still trusted for the content of what it prints. Proving more would need the
 * wrapper to own the assertion list, diff against a committed transcript, or
 * require the gate to demonstrate it touched the runner. The goal here is
 * narrow: make an emptied or stubbed gate fail loudly rather than pass quietly.
 */
async function gate(script: string, minAssertions: number): Promise<GateResult> {
  const r = await run(script);
  const assertions = (r.output.match(/^\s+(ok|FAIL)\s/gm) ?? []).length;
  expect(
    assertions,
    `${script} printed ${assertions} assertion lines; a gate that reports PASSED ` +
      `without running its assertions is indistinguishable from an emptied file`,
  ).toBeGreaterThanOrEqual(minAssertions);
  expect(r.output).toContain("PASSED");
  expect(r.status).toBe(0);
  return r;
}

describe("df005 contract gates", () => {
  it("cleanup frees the session with both tools, and refuses to leak", async () => {
    await gate("df005-postcreate-gate.py", 10);
  }, 120_000);

  it("the offline runner reports deferral rather than failure", async () => {
    await gate("df005-runner-offline.py", 100);
  }, 300_000);
});
