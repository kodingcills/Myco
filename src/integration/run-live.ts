/**
 * Live-VM trial entrypoint (M1-013 / TIF-17): run one normal and one
 * kill-mid-program corrupted calc-record-edit trial against the real VM.
 *
 * Usage (host, with the ssh tunnel and MYCO_AGENT_TOKEN set):
 *   tsx src/integration/run-live.ts --mode normal   [--seed s] [--runs-dir runs]
 *   tsx src/integration/run-live.ts --mode kill    [--kill-after-step 3] [--recovery]
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
  const recovery = process.argv.includes("--recovery");
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
    const report = await runTrial({ client, params, unoSocket: socket, runsDir, recovery });
    process.stdout.write(JSON.stringify(report, null, 2));
    await tunnel.stop();
    process.exit(report.verdict.status === "verified" ? 0 : 1);
  }

  if (mode === "kill") {
    // Corrupted trial: kill soffice after the edit lands and before the save.
    // A wall-clock timer cannot do this reliably — launching Calc and making
    // it observable takes ~30 s, so a 12 s timer fires during launch and the
    // trial never executes a step (observed: steps: [], precondition
    // adapter-available failure). The kill is therefore step-triggered.
    const killAfterStep = Number(arg("kill-after-step") ?? 3);
    const report = await runTrial({
      client,
      params,
      unoSocket: socket,
      runsDir,
      killAfterStep,
      recovery,
    });
    process.stdout.write(JSON.stringify(report, null, 2));
    await tunnel.stop();
    process.exit(report.verdict.status === "verified" ? 1 : 0);
  }

  if (mode === "values") {
    // Generator proof (M1-013): type each generated value through the real
    // input path and let the verifier compare the persisted readback exactly.
    // A verified verdict here means the value survived Calc byte-identically;
    // a refuted one names the mismatch in its reason string.
    const limit = Number(arg("limit") ?? 40);
    const sets = generateParameterSets([
      "m1-013-live",
      "seed-b",
      "seed-c",
      "seed-d",
      "seed-e",
      "seed-f",
    ]).slice(0, limit);
    const rows: Array<Record<string, unknown>> = [];
    for (const params of sets) {
      try {
        const report = await runTrial({
          client,
          params,
          unoSocket: socket,
          runsDir: join(runsDir, "values"),
        });
        rows.push({
          column: params.column,
          typed: params.newValue,
          status: report.verdict.status,
          reason: report.verdict.reasons[0] ?? "",
          elapsedMs: report.elapsedMs,
        });
      } catch (error) {
        rows.push({
          column: params.column,
          typed: params.newValue,
          status: "harness-error",
          reason: String(error),
        });
      }
    }
    process.stdout.write(JSON.stringify(rows, null, 2));
    await tunnel.stop();
    const bad = rows.filter((r) => r.status !== "verified");
    process.exit(bad.length === 0 ? 0 : 1);
  }

  throw new Error(`unknown mode: ${mode}`);
}

main().catch((error) => {
  // String(): write() rejects non-string/Buffer, which would mask the real error
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exit(1);
});
