/**
 * Child process for the policy-config blocking cases (round 2 D3). A FIFO or `/dev/zero` read
 * with a plain `readFileSync` would freeze or exhaust whichever process reads it, so the test
 * runs the loader here and the parent kills this process if it does not answer in time.
 *
 *   tsx test/policy/config-child.ts <fifo|fifo-in-root|dev-zero|swap-to-fifo>
 */
import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readBoundedNoBlock } from "../../src/policy/bounded-read.ts";
import { loadPolicyConfig, MAX_CONFIG_BYTES } from "../../src/policy/config.ts";

const mode = process.argv[2];
const root = mkdtempSync(join(tmpdir(), "myco-policy-child-"));
const agentRoot = join(root, "doc");
mkdirSync(agentRoot);

let out: unknown;
if (mode === "fifo" || mode === "fifo-in-root") {
  const p = join(mode === "fifo" ? root : agentRoot, "policy.json");
  execFileSync("mkfifo", [p]);
  out = loadPolicyConfig(p, { agentRoots: [agentRoot] });
} else if (mode === "dev-zero") {
  out = loadPolicyConfig("/dev/zero", { agentRoots: [agentRoot] });
} else if (mode === "swap-to-fifo") {
  // The pre-check saw a regular file; a FIFO replaces it before the open.
  const p = join(root, "policy.json");
  writeFileSync(p, "{}");
  const pre = lstatSync(p);
  renameSync(p, join(root, "moved.json"));
  execFileSync("mkfifo", [p]);
  out = readBoundedNoBlock(p, MAX_CONFIG_BYTES, pre);
} else {
  out = { error: "unknown mode" };
}
process.stdout.write(`${JSON.stringify(out)}\n`);
