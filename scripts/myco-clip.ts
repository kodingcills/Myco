/**
 * `myco-clip`: export a MOCK-watermarked preview GIF of a recorded run's frame span, and refuse
 * to verify a clip without a sidecar (spec #589 build PR B5, issue #666).
 *
 *   pnpm myco-clip export --run <runId> --task <taskId> --from <i> --to <j> \
 *     --decision-log <file> --frames <dir> --out <path.gif>
 *
 * See docs/gate/replay.md. All logic lives in src/watch/clip/cli.ts.
 */
import { clipMain } from "../src/watch/clip/cli.ts";

process.exitCode = clipMain(process.argv.slice(2), {
  stdout: process.stdout,
  stderr: process.stderr,
});
