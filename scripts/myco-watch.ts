/**
 * `myco-watch`: the read-only live watch view (TIF-265 follow-up, scope add A).
 *
 *   pnpm myco-watch --demo calc-multi-step          # mock demo, no VM, no model
 *   pnpm myco-watch --run <runId> --decision-log <gate --audit file> --frames <dir>
 *
 * See docs/gate/watch.md. All logic lives in src/watch/cli.ts.
 */
import { main } from "../src/watch/cli.ts";

process.exitCode = await main(process.argv.slice(2), {
  stdout: process.stdout,
  stderr: process.stderr,
});
