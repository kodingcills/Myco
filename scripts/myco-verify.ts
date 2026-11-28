/**
 * `myco-verify`: re-verify a recorded run from its captured data with the gate's own code,
 * read-only (spec #589 §3, issue #666). Operator CLI only, never an agent tool.
 *
 *   pnpm myco-verify <runId> --task <taskId> --mock-evidence <evidenceRoot> --decision-log <file>
 *
 * See docs/gate/verify-run.md. All logic lives in src/verify-run/cli.ts.
 */
import { verifyMain } from "../src/verify-run/cli.ts";

process.exitCode = await verifyMain(process.argv.slice(2), {
  stdout: process.stdout,
  stderr: process.stderr,
});
