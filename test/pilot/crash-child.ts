/**
 * Test helper (not a test): run the pilot dry run and SIGKILL this process inside the N-th
 * trial's agent step, leaving an open attempt and a stale lock, as a real crash would.
 *
 *   npx tsx test/pilot/crash-child.ts <outDir> <n>
 */
import { fakeDriver } from "../../src/pilot/dry-run.ts";
import { dryRun } from "./helpers.ts";

const [dir, nth] = process.argv.slice(2);
let n = 0;
await dryRun(dir as string, {
  driver: fakeDriver({
    beforeAgent: () => {
      if (++n === Number(nth)) process.kill(process.pid, "SIGKILL");
    },
  }),
});
