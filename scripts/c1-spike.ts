import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { connectC1 } from "../src/baseline/c1.ts";
import { independentC1Judge } from "../src/baseline/c1-judge.ts";
import { type PreparedC1, RESET_SNAPSHOT, runC1Trial } from "../src/baseline/c1-trial.ts";
import { mcpStdio } from "../src/baseline/mcp-stdio.ts";
import { createPlanner } from "../src/baseline/planner.ts";
import manifest from "../src/baseline/sweep-v3.json" with { type: "json" };
import { WindowsFixtureConverter } from "../src/integration/windows-fixture.ts";
import { generateFixture } from "../src/tasks/fixture.ts";
import { groundTruth } from "../src/tasks/intent.ts";
import { AgentClient, SshTunnel } from "../src/win/agent-client.ts";

async function main() {
  const directory = process.argv[2] || "/tmp/baseline/c1-spike";
  console.log(`=== Phase 1a Live Spike: 1-trial test on Index 0 in ${directory} ===`);
  const target = manifest.rows[0];
  console.log("Target:", JSON.stringify(target));

  // 1. Reset VM to cua-c1-base
  console.log("--> Cold resetting VM to cua-c1-base...");
  const t0 = performance.now();
  execFileSync("bash", ["scripts/reset-trial-vm.sh", RESET_SNAPSHOT], { stdio: "inherit" });
  const resetMs = Math.round(performance.now() - t0);
  console.log(`--> Reset complete in ${resetMs}ms`);

  // 2. Health & power checks
  const acPower = execFileSync("pmset", ["-g", "batt"]).toString().includes("AC Power");
  let caffeinate = false;
  try {
    caffeinate = execFileSync("pgrep", ["caffeinate"]).toString().trim().length > 0;
  } catch {
    caffeinate = false;
  }
  const loadAvg1 = os.loadavg()[0];
  console.log({ acPower, caffeinate, loadAvg1 });

  // 3. Verify cua-driver status
  let pipeReachable = false;
  for (let i = 0; i < 6; i++) {
    await sleep(2000);
    try {
      const statusCheck = execFileSync(
        join(os.homedir(), "VMs/myco-win11/scripts/vssh"),
        ["C:\\myco\\bin\\cua-driver.exe status"],
        { encoding: "utf8" }
      );
      if (statusCheck.includes("Cua Driver daemon is running")) {
        pipeReachable = true;
        break;
      }
    } catch {}
  }
  console.log(`--> Cua driver pipe reachable: ${pipeReachable}`);

  // 4. Start myco-agent in Session 1
  console.log("--> Starting myco-agent in Session 1...");
  execFileSync(
    join(os.homedir(), "VMs/myco-win11/scripts/vssh"),
    [
      "& powershell -NoProfile -ExecutionPolicy Bypass -File 'C:\\myco\\bin\\run-interactive.ps1' -Exe 'C:\\Program Files\\LibreOffice\\program\\python.exe' -ArgList '-m myco_agent --host 127.0.0.1 --port 8765 --token-file C:\\ProgramData\\Myco\\agent.token --backend windows' -Name 'myco-agent' -WorkDir 'C:\\Program Files\\Myco\\agent'",
    ],
    { stdio: "ignore" }
  );
  let token = "";
  for (let i = 0; i < 10; i++) {
    await sleep(1000);
    try {
      token = execFileSync(
        join(os.homedir(), "VMs/myco-win11/scripts/vssh"),
        ["Get-Content C:\\ProgramData\\Myco\\agent.token"],
        { encoding: "utf8" }
      ).trim();
      if (token.length > 20) break;
    } catch {}
  }
  if (!token) throw new Error("myco-agent token could not be read");

  // 5. Connect AgentClient over tunnel
  console.log("--> Opening SSH tunnel for myco-agent...");
  const tunnel = new SshTunnel();
  await tunnel.start();
  let client: AgentClient;
  try {
    client = AgentClient.overTunnel(tunnel, { token });
    let pingOk = false;
    for (let i = 0; i < 15; i++) {
      try {
        const pong = await client.ping();
        console.log("--> myco-agent ping verified:", JSON.stringify(pong));
        pingOk = true;
        break;
      } catch {
        await sleep(1000);
      }
    }
    if (!pingOk) throw new Error("myco-agent did not answer ping");

  // 6. Convert fixture
  console.log("--> Converting fixture for seed:", target.params.fixtureSeed);
  const fixture = generateFixture(target.params.fixtureSeed);
  const converter = new WindowsFixtureConverter({
    client,
    guestDir: `C:\\myco\\runs\\${target.index}`,
    timeoutMs: 90_000,
  });
  await converter.convert(Buffer.from(fixture.csv, "utf8"));
  const xlsxPath = converter.lastXlsxPath;
  if (!xlsxPath) throw new Error("fixture convert produced no path");
  console.log("--> Fixture converted at:", xlsxPath);

  // 7. Launch Calc on fixture with UNO accept socket 2002
  console.log("--> Launching Calc on fixture with UNO accept socket 2002...");
  const unoSocket = "2002";
  await client.launch([
    "C:\\Program Files\\LibreOffice\\program\\soffice.exe",
    `--accept=socket,host=127.0.0.1,port=${unoSocket};urp;`,
    "--norestore",
    "--nologo",
    xlsxPath,
  ]);

  // 8. Find Calc window in Cua
  console.log("--> Finding Calc window in Cua...");
  let windowInfo: { pid: number; window_id: number } | undefined;
  for (let attempt = 0; attempt < 30; attempt++) {
    await sleep(1000);
    try {
      const resJson = execFileSync(
        join(os.homedir(), "VMs/myco-win11/scripts/vssh"),
        ["C:\\myco\\bin\\cua-driver.exe call list_windows '{}'"],
        { input: "", encoding: "utf8" }
      );
      const parsed = JSON.parse(resJson);
      const win = parsed.windows?.find((w: any) =>
        w.app_name?.toLowerCase().includes("soffice") ||
        w.app_name?.toLowerCase().includes("calc") ||
        w.title?.toLowerCase().includes("calc")
      );
      if (win) {
        windowInfo = { pid: win.pid, window_id: win.window_id };
        console.log("--> Found Calc window:", JSON.stringify(win));
        break;
      }
    } catch {}
  }
  if (!windowInfo) throw new Error("Calc window not found after launch");

  // 9. Wait for UNO readiness
  console.log("--> Polling UNO socket readiness...");
  const gt = groundTruth(target.params);
  const unoDeadline = Date.now() + 60_000;
  while (Date.now() < unoDeadline) {
    try {
      await client.unoEval({
        call: "get_string",
        cell: gt.cellRef,
        socket: unoSocket,
      });
      console.log("--> UNO socket ready! Cell", gt.cellRef, "initial value read successfully.");
      break;
    } catch {
      await sleep(500);
    }
  }

  // 10. Prepare C1
  let mcpProc: ReturnType<typeof spawn> | undefined;
  const connect = async () => {
    mcpProc = spawn("ssh", [
      "-F",
      join(os.homedir(), "VMs/myco-win11/ssh_config"),
      "-o",
      "LogLevel=ERROR",
      "myco-win11",
      "C:\\myco\\bin\\cua-driver.exe mcp --socket \\\\.\\pipe\\cua-driver",
    ]);
    return mcpStdio(mcpProc.stdin!, mcpProc.stdout!);
  };
  const closeTransport = async () => {
    if (mcpProc) {
      mcpProc.kill();
      mcpProc = undefined;
    }
  };

  const judgeAudit = independentC1Judge({
    client,
    socket: unoSocket,
    xlsxPath,
    params: target.params,
    documentState: async () => {
      try {
        const resJson = execFileSync(
          join(os.homedir(), "VMs/myco-win11/scripts/vssh"),
          ["C:\\myco\\bin\\cua-driver.exe call list_windows '{}'"],
          { input: "", encoding: "utf8" }
        );
        const parsed = JSON.parse(resJson);
        const win = parsed.windows?.find((w: any) =>
          w.app_name?.toLowerCase().includes("soffice") ||
          w.app_name?.toLowerCase().includes("calc") ||
          w.title?.toLowerCase().includes("calc") ||
          w.pid === windowInfo?.pid
        );
        if (!win) return "closed";
        const dialog = parsed.windows?.find((w: any) =>
          (w.pid === windowInfo?.pid || w.app_name === win.app_name) &&
          (w.title?.toLowerCase().includes("save") ||
            w.title?.toLowerCase().includes("confirm") ||
            w.title?.toLowerCase().includes("error"))
        );
        if (dialog) return "dialog";
        return "open";
      } catch {
        return "unavailable";
      }
    },
  });

  const prepared: PreparedC1 = {
    driver: {
      hostVersion: "0.56.4",
      guestVersion: "0.56.4",
      pipeReachable,
      sessionIdentityMatches: true,
    },
    resetMs,
    acPower,
    caffeinate,
    loadAvg1,
    window: windowInfo,
    connect,
    closeTransport,
    judge: judgeAudit.judge,
    audit: judgeAudit.audit,
  };

  console.log("--> Prepared C1 ready. Running trial 0...");
  const planner = createPlanner();
  console.log("--> Planner type:", planner.paid ? "Paid Sonnet" : "Ollama (qwen3.8-uncensored)");

  const row = await runC1Trial(
    {
      index: target.index,
      params: target.params,
      cellRef: gt.cellRef,
      expected: gt.expectedValue,
      previousValue: gt.previousValue,
    },
    prepared,
    planner
  );

    tunnel.stop();

    console.log("=== Trial 0 Result ===");
    console.log(JSON.stringify(row, null, 2));

    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "0.json"), JSON.stringify(row, null, 2) + "\n");
    console.log(`Saved spike result to ${join(directory, "0.json")}`);
  } finally {
    try {
      tunnel.stop();
    } catch {}
  }
}

main().catch((err) => {
  console.error("FATAL SPIKE ERROR:", err);
  process.exit(1);
});
