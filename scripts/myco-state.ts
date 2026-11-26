/**
 * `myco-state`: read-only structured app state as an MCP server (capability track I).
 *
 *   MYCO_STATE_RUN_ID=<run> MYCO_STATE_UNO_PIPE=<pipe> pnpm myco-state mcp
 *
 * The harness sets the binding; see docs/state/tools.md. All logic lives in src/state/cli.ts.
 *
 * stdin is re-framed by the same `boundFrames` the gate uses (#520, H-01): a JSON-RPC frame
 * over `MAX_FRAME_BYTES` is dropped as it streams and answered with -32600, so one oversized
 * frame cannot exhaust the server's memory. It is a pure byte-framing module (no oracle,
 * registry or verdict code), imported here at the script layer so `src/state/` itself still
 * imports nothing from `src/gate/`.
 */
import { boundFrames, MAX_FRAME_BYTES } from "../src/gate/stdio-frame.ts";
import { main } from "../src/state/cli.ts";

process.exitCode = await main(process.argv.slice(2), {
  stdin: boundFrames(process.stdin, {
    onOversized: () =>
      process.stderr.write(
        `myco-state: dropped a JSON-RPC frame over ${MAX_FRAME_BYTES} bytes (answered -32600)\n`,
      ),
  }),
  stdout: process.stdout,
  stderr: process.stderr,
  env: process.env,
});
