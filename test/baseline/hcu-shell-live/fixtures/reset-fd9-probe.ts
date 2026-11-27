/**
 * Test fixture for `live-vm.test.ts` (round-2 verifier D4): runs the live environment's real
 * reset spawner (`spawnReset`, FD 9 passed through) on a STUB reset script given as argv[2],
 * and prints the result as JSON. Started by the test as
 * `bash -c 'exec 9>LOCK; exec node --import tsx reset-fd9-probe.ts STUB'`, the documented
 * launch shape. It never runs the real reset script and never touches a VM.
 */
import { spawnReset } from "../../../../src/baseline/hcu-shell-live/live-vm.ts";

const stub = process.argv[2];
if (stub === undefined) throw new Error("usage: reset-fd9-probe.ts <stub-script>");
const r = await spawnReset("bash", [stub, "trial-base-v3"], 30_000, () => undefined);
process.stdout.write(`${JSON.stringify(r)}\n`);
