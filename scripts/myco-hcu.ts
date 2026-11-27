/**
 * `myco-hcu`: the R1 / A/B live agent's actuator, a stdio MCP server for Claude Code (#732).
 *
 *   node --import tsx scripts/myco-hcu.ts mcp --hcu-command 'C:\myco\bin\computer-use.exe mcp'
 *
 * The pilot's launch plan starts it (`ACTUATOR_SERVER_TEMPLATE`, `src/pilot/config.ts`); an
 * operator never runs it by hand. On the first tool call it opens ONE fixed channel: `ssh` with
 * the trial VM's `ssh_config` (`~/VMs/myco-win11/ssh_config`, host `myco-win11`, as the
 * `hcu+shell` arm's live VM) running the HCU command in the guest, then the arm's own HCU client
 * (`connectHcuGui`). Every tool, its budget and its codes are `src/pilot/hcu-actuator.ts`. The
 * agent supplies no part of the SSH command line: the HCU command comes from the reviewed plan.
 * No secret is read here; SSH authenticates with the operator's own SSH setup.
 */
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { connectHcuGui } from "../src/baseline/hcu-shell/hcu-gui.ts";
import { mcpStdio } from "../src/baseline/mcp-stdio.ts";
import { createActuator, serveActuatorStdio } from "../src/pilot/hcu-actuator.ts";

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const hcuCommand = flag("--hcu-command");
if (argv[0] !== "mcp" || hcuCommand === undefined || hcuCommand === "") {
  process.stderr.write("usage: myco-hcu mcp --hcu-command <guest command>\n");
  process.exit(2);
}

const sshConfig = join(homedir(), "VMs", "myco-win11", "ssh_config");
let close: (() => void) | null = null;
const actuator = createActuator(async () => {
  const child = spawn("ssh", ["-F", sshConfig, "-o", "LogLevel=ERROR", "myco-win11", hcuCommand], {
    stdio: ["pipe", "pipe", "ignore"],
  });
  const mcp = mcpStdio(child.stdin, child.stdout);
  close = () => {
    mcp.close();
    child.kill();
  };
  return connectHcuGui(mcp);
});
await serveActuatorStdio(actuator, process.stdin, process.stdout);
(close as (() => void) | null)?.();
