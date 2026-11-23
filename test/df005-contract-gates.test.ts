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

function gate(script: string): Promise<{ status: number | null; output: string }> {
  const { promise, resolve } = Promise.withResolvers<{ status: number | null; output: string }>();
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

describe("df005 contract gates", () => {
  it("cleanup frees the session with both tools, and refuses to leak", async () => {
    const r = await gate("df005-postcreate-gate.py");
    // The gate prints `PASSED: N assertion(s)` on success, and names each
    // failed assertion otherwise - so a failure reads as the property, not
    // as "exit 1".
    expect(r.output).toContain("PASSED");
    expect(r.status).toBe(0);
  }, 120_000);

  it("the offline runner reports deferral rather than failure", async () => {
    const r = await gate("df005-runner-offline.py");
    expect(r.output).toContain("PASSED");
    expect(r.status).toBe(0);
  }, 300_000);
});
