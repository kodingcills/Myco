/**
 * `myco-fleet` — the Linux desktop fleet (workstream 2, track U): K disposable desktops in
 * parallel, each trial gated, independently graded and ledgered; trials per hour versus K.
 * $0: scripted agents only. See src/fleet/cli.ts and docs/product/linux-fleet.md.
 */

import { main } from "../src/fleet/cli.ts";

process.exitCode = await main(process.argv.slice(2));
