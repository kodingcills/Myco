/**
 * `myco-gate`: Myco's completion gate, as a CLI and as an MCP server (TIF-265).
 *
 *   pnpm myco-gate check --evidence-root runs/gate --task df-s01 --run r1
 *   pnpm myco-gate mcp   --evidence-root runs/gate          # stdio MCP server for Claude Code
 *   pnpm myco-gate demo  --transport mock                    # end-to-end, no VM, no model
 *
 * See docs/gate/api.md. All logic lives in src/gate/cli.ts.
 *
 * In `mcp` mode stdin is re-framed by `boundFrames` (docs/security/gate-api-review.md, H-01):
 * a JSON-RPC frame over `MAX_FRAME_BYTES` is dropped as it streams and answered with
 * `-32600`, so one oversized frame cannot exhaust the gate's memory. Other commands do not
 * read stdin, so it is left untouched for them.
 */
import { main } from "../src/gate/cli.ts";
import { boundFrames, MAX_FRAME_BYTES } from "../src/gate/stdio-frame.ts";

const argv = process.argv.slice(2);
const stdin =
  argv[0] === "mcp"
    ? boundFrames(process.stdin, {
        onOversized: () =>
          process.stderr.write(
            `myco-gate: dropped a JSON-RPC frame over ${MAX_FRAME_BYTES} bytes (answered -32600)\n`,
          ),
      })
    : process.stdin;

process.exitCode = await main(argv, {
  stdin,
  stdout: process.stdout,
  stderr: process.stderr,
});
