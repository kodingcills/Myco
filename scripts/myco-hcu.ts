/**
 * `myco-hcu`: the R1 / A/B live agent's actuator, a stdio MCP server for Claude Code (#732).
 *
 *   node --import tsx scripts/myco-hcu.ts mcp \
 *     --hcu-command 'C:\myco\bin\computer-use.exe mcp --attach C:\myco\run\hcu-session.sock'
 *
 * The pilot's launch plan starts it (`ACTUATOR_SERVER_TEMPLATE`, `src/pilot/config.ts`); an
 * operator never runs it by hand. On the first tool call it opens ONE fixed channel
 * (`openHcuSession`, `src/pilot/hcu-ssh.ts`, the same one the VM step's pre-agent probe uses):
 * `ssh` with the trial VM's `ssh_config` (host `myco-win11`) running the HCU command in the
 * guest, then the arm's own HCU client (`connectHcuGui`). The HCU command must be the attach
 * form (`computer-use.exe mcp --attach <session socket>`, the interactive-session HCU of #734);
 * a bare session-0 `mcp` is refused at start (exit 2). Every tool, its budget and its codes are
 * `src/pilot/hcu-actuator.ts`. The agent supplies no part of the SSH command line: the HCU
 * command comes from the reviewed plan. No secret is read here; SSH authenticates with the
 * operator's own SSH setup.
 */
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { connectHcuGui } from "../src/baseline/hcu-shell/hcu-gui.ts";
import { isHcuAttachCommand } from "../src/integrity/surface.ts";
import { createActuator, serveActuatorStdio } from "../src/pilot/hcu-actuator.ts";
import { type HcuSession, openHcuSession } from "../src/pilot/hcu-ssh.ts";

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
if (!isHcuAttachCommand(hcuCommand)) {
  process.stderr.write(
    "myco-hcu: the HCU command must be the attach form: computer-use.exe mcp --attach <socket>\n",
  );
  process.exit(2);
}

let session: HcuSession | null = null;
const actuator = createActuator(async () => {
  session = openHcuSession(spawn, hcuCommand, homedir());
  return connectHcuGui(session.mcp);
});
await serveActuatorStdio(actuator, process.stdin, process.stdout);
(session as HcuSession | null)?.close();
