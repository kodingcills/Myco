/**
 * `myco-gate`: Myco's completion gate, as a CLI and as an MCP server (TIF-265).
 *
 *   pnpm myco-gate check --evidence-root runs/gate --task df-s01 --run r1
 *   pnpm myco-gate mcp   --evidence-root runs/gate          # stdio MCP server for Claude Code
 *   pnpm myco-gate demo  --transport mock                    # end-to-end, no VM, no model
 *
 * See docs/gate/api.md. All logic lives in src/gate/cli.ts.
 */
import { main } from "../src/gate/cli.ts";

process.exitCode = await main(process.argv.slice(2), {
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
});
