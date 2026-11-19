/**
 * Live-VM trial entrypoint (M1-013 / TIF-17): run one normal and one
 * kill-mid-program corrupted calc-record-edit trial against the real VM.
 *
 * Usage (host, with the ssh tunnel and MYCO_AGENT_TOKEN set):
 *   tsx src/integration/run-live.ts --mode normal   [--seed s] [--runs-dir runs]
 *   tsx src/integration/run-live.ts --mode kill
 *
 * The token is never committed: it is read from MYCO_AGENT_TOKEN (fetched
 * from the guest over vssh by the caller) or from the .myco-token file.
 */

import { mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { generateParameterSets } from "../tasks/intent.ts";
import { AgentClient, SshTunnel } from "../win/agent-client.ts";
import { runTrial } from "./trial.ts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const mode = arg("mode") ?? "normal";
  const runsDir = arg("runs-dir") ?? "runs";
  const seed = arg("seed") ?? "m1-013-live";
  const socket = arg("uno-socket") ?? "2002";

  let token = process.env.MYCO_AGENT_TOKEN;
  if (!token) {
    try {
      token = readFileSync(join(homedir(), ".myco-token"), "utf8").trim();
      if (!token) throw new Error("empty");
    } catch {
      process.stderr.write("MYCO_AGENT_TOKEN is required (or ~/.myco-token from vssh)");
      process.exit(1);
    }
  }
  mkdirSync(runsDir, { recursive: true });

  const tunnel = new SshTunnel();
  await tunnel.start();
  const client = AgentClient.overTunnel(tunnel, { token, timeoutMs: 60_000 });
  const ping = await client.ping();
  process.stderr.write(`agent ping ok: ${ping.agent_version} session ${ping.session_id}\n`);

  // Trial 1 of the parameter set (deterministic from the seed list), with
  // optional overrides for picking a column the trial targets (integration
  // plumbing only — the family generator is untouched).
  const base = generateParameterSets([seed])[0];
  if (!base) throw new Error("no parameter set generated");
  const params = {
    ...base,
    ...(arg("column") ? { column: arg("column") } : {}),
    ...(arg("row-key") ? { rowKey: arg("row-key") } : {}),
    ...(arg("new-value") ? { newValue: arg("new-value") } : {}),
  };

  if (mode === "normal") {
    const report = await runTrial({ client, params, unoSocket: socket, runsDir });
    process.stdout.write(JSON.stringify(report, null, 2));
    await tunnel.stop();
    process.exit(report.verdict.status === "verified" ? 0 : 1);
  }

  if (mode === "kill") {
    // Corrupted trial: kill soffice mid-program. The kill must land after the
    // set step (edit made, not saved) so the trial's ground truth is "not
    // satisfied" — the harness must end refuted/uncertain, never verified,
    // and must not hang. We interpose by monkey-patching nothing: the
    // runTrial flow runs the whole program; instead we start the trial and
    // race a timer that kills soffice.bin in the guest 12 s in (mid-program:
    // after launch+locate, around set/save).
    const killAt = Date.now() + Number(arg("kill-after-ms") ?? 12_000);
    const killer = (async () => {
      await new Promise<void>((r) => setTimeout(r, killAt - Date.now()));
      try {
        await client.kill({ image_name: "soffice.bin" });
        process.stderr.write(
          `[kill-fault] soffice.bin killed at +${Date.now() - (killAt - 12_000)}ms\n`,
        );
      } catch (error) {
        process.stderr.write(`[kill-fault] kill op failed: ${String(error)}\n`);
      }
    })();
    const report = await runTrial({ client, params, unoSocket: socket, runsDir });
    await killer;
    process.stdout.write(JSON.stringify(report, null, 2));
    await tunnel.stop();
    process.exit(report.verdict.status === "verified" ? 1 : 0);
  }

  throw new Error(`unknown mode: ${mode}`);
}

main().catch((error) => {
  process.stderr.write(error);
  process.exit(1);
});
