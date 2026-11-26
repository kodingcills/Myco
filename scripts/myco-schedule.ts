/**
 * `myco-schedule`: scheduled and triggered runs on a local, loopback-only service (track S).
 *
 *   pnpm myco-schedule serve   --config schedule.json --allow-task fc-v1-001
 *   pnpm myco-schedule trigger --config schedule.json --schedule nightly
 *
 * See docs/schedule/README.md. All logic lives in src/schedule/cli.ts.
 */
import { main } from "../src/schedule/cli.ts";

const stopSignal = new Promise<void>((resolve) => {
  process.once("SIGINT", () => resolve());
  process.once("SIGTERM", () => resolve());
});

process.exitCode = await main(process.argv.slice(2), {
  stdout: process.stdout,
  stderr: process.stderr,
  stopSignal,
});
