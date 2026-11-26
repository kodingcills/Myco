/**
 * `myco-handoff`: resolve a paused agent's handoff from the operator's terminal (track N).
 *
 *   pnpm myco-handoff list    --connection ~/.myco/handoff/<run>.json
 *   pnpm myco-handoff resolve ho-1 approve --connection ~/.myco/handoff/<run>.json
 *
 * See docs/handoff/protocol.md. All logic lives in src/handoff/cli.ts.
 */
import { main } from "../src/handoff/cli.ts";

process.exitCode = await main(process.argv.slice(2), {
  stdout: process.stdout,
  stderr: process.stderr,
});
