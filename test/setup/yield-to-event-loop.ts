import { afterEach, beforeEach } from "vitest";

/**
 * Let the worker's event loop run a full iteration before and after every test.
 *
 * Why: a vitest worker reports progress to the main process over an RPC with a
 * fixed 60 s reply timeout (birpc's default; vitest 3.2 has no option for it).
 * The reply arrives over IPC and is only read when the worker's event loop
 * reaches its poll phase. vitest's runner moves from one test to the next on
 * promise continuations alone, so a test file whose tests are synchronous
 * (`spawnSync`, `execFileSync`, ...) never gives the loop a turn for the whole
 * file. When such a file runs past 60 s, the reply is sitting unread in the
 * pipe while the timer fires, and the run fails with
 * `[vitest-worker]: Timeout calling "onTaskUpdate"` even though every test
 * passed. `test/guest-egress.test.ts` (all `spawnSync`) took 61-80 s on
 * `macos-latest` in each failing run.
 *
 * One loop iteration per test bounds the starved stretch by the longest single test
 * instead of the longest file. It changes no test's behaviour and hides no
 * error: an unhandled error still fails the run.
 *
 * `setImmediate` is captured here, before any test file loads, so a test that
 * installs fake timers (and even one that leaves them installed) cannot turn
 * this hook into a hang.
 */
const realSetImmediate = globalThis.setImmediate;

function immediate(): Promise<void> {
  return new Promise((resolve) => {
    realSetImmediate(resolve);
  });
}

/**
 * Two hops, not one. Code resumed from an IPC callback is running in the poll
 * phase, and an immediate queued there fires in the same iteration's check
 * phase, so one hop can return without the loop polling again. An immediate
 * queued during the check phase fires in the next iteration, after its poll
 * phase, so the second hop guarantees the pending reply is read.
 */
async function yieldToEventLoop(): Promise<void> {
  await immediate();
  await immediate();
}

beforeEach(yieldToEventLoop);
afterEach(yieldToEventLoop);
