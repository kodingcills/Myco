/**
 * Test helper for `test/watch/pilot-run.test.ts`: poll one run directory with the watch view's
 * reader and print the view as JSON. Run in a child process with a timeout, so a reader that
 * opened a FIFO planted at an oracle-input or vault path would block and be killed (the test
 * then fails) instead of hanging the test worker.
 *
 *   tsx test/watch/poll-run-dir.ts <runDir>
 */
import { pilotRunSource } from "../../src/watch/run-dir.ts";

const dir = process.argv[2];
if (dir === undefined) {
  process.stderr.write("usage: poll-run-dir.ts <runDir>\n");
  process.exit(2);
}
process.stdout.write(`${JSON.stringify(pilotRunSource(dir).poll())}\n`);
