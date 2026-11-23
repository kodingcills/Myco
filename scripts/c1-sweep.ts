// biome-ignore-all lint/suspicious/noConsole: CLI progress and fatal diagnostics go to the operator log.
import { execFileSync, spawn } from "node:child_process";
import os from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { independentC1Judge } from "../src/baseline/c1-judge.ts";
import type { PreparedC1, RESET_SNAPSHOT } from "../src/baseline/c1-trial.ts";
import { mcpStdio } from "../src/baseline/mcp-stdio.ts";
import { createPlanner } from "../src/baseline/planner.ts";
import { runC1Sweep } from "../src/baseline/sweep.ts";
import manifest from "../src/baseline/sweep-v3.json" with { type: "json" };
import { cleanupTrialGuest } from "../src/integration/guest-health.ts";
import { WindowsFixtureConverter } from "../src/integration/windows-fixture.ts";
import { generateFixture } from "../src/tasks/fixture.ts";
import { groundTruth } from "../src/tasks/intent.ts";
import { AgentClient, SshTunnel } from "../src/win/agent-client.ts";
import { persistedDiagnostic, probeC1Driver } from "./c1-driver-preflight.ts";
import { parseSpendCeiling } from "./spend-ceiling.ts";

async function main() {
  if (!process.argv.includes("--coordinator-go")) throw new Error("Coordinator GO required");
  const directory = process.argv[2] || "/tmp/baseline/c1";
  console.log(`=== Starting C1 Screenshot Baseline Sweep in ${directory} ===`);

  let activeTunnel: SshTunnel | undefined;

  /**
   * Per-command budget for a guest round trip, matching the preflight's.
   *
   * These calls had NO timeout: execFileSync waits forever, so a wedged guest
   * hangs the sweep instead of failing it, and the arm reports nothing at all.
   * On 2026-11-22 a guest round trip measured 6-11s under sweep load, which is
   * why an unbounded call is a real hazard rather than a theoretical one. This
   * is a liveness budget, not a performance target: a slow guest costs seconds,
   * a dead one fails.
   */
  const GUEST_TIMEOUT_MS = 45_000;

  async function prepare(
    target: (typeof manifest.rows)[number],
    snapshot: typeof RESET_SNAPSHOT,
  ): Promise<PreparedC1> {
    console.log(
      `\n--- Preparing Trial ${target.index} (fixtureSeed: ${target.params.fixtureSeed}) ---`,
    );

    // 1. Health & power checks
    // Recorded, not enforced: power source is evidence, not a precondition
    // (Tiffany: never gate VM work on charger state).
    const acPower = execFileSync("pmset", ["-g", "batt"]).toString().includes("AC Power");
    let caffeinate = false;
    try {
      caffeinate = execFileSync("pgrep", ["caffeinate"]).toString().trim().length > 0;
    } catch {
      caffeinate = false;
    }
    const loadAvg1 = os.loadavg()[0] ?? 0;

    // 2. Cold reset VM to snapshot
    console.log(`[${target.index}] Resetting VM to ${snapshot}...`);
    const t0 = performance.now();
    execFileSync("bash", ["scripts/reset-trial-vm.sh", snapshot], { stdio: "inherit" });
    const resetMs = Math.round(performance.now() - t0);
    console.log(`[${target.index}] Reset complete in ${resetMs}ms`);

    // 3. Verify cua-driver status
    let pipeReachable = false;
    for (let i = 0; i < 6; i++) {
      await sleep(2000);
      try {
        const statusCheck = execFileSync(
          join(os.homedir(), "VMs/myco-win11/scripts/vssh"),
          ["C:\\myco\\bin\\cua-driver.exe status"],
          { encoding: "utf8", timeout: GUEST_TIMEOUT_MS },
        );
        if (statusCheck.includes("Cua Driver daemon is running")) {
          pipeReachable = true;
          break;
        }
      } catch {}
    }
    console.log(`[${target.index}] Cua driver pipe reachable: ${pipeReachable}`);

    // 4. Start myco-agent in Session 1
    console.log(`[${target.index}] Starting myco-agent in Session 1...`);
    execFileSync(
      join(os.homedir(), "VMs/myco-win11/scripts/vssh"),
      [
        "& powershell -NoProfile -ExecutionPolicy Bypass -File 'C:\\myco\\bin\\run-interactive.ps1' -Exe 'C:\\Program Files\\LibreOffice\\program\\python.exe' -ArgList '-m myco_agent --host 127.0.0.1 --port 8765 --token-file C:\\ProgramData\\Myco\\agent.token --backend windows' -Name 'myco-agent' -WorkDir 'C:\\Program Files\\Myco\\agent'",
      ],
      { stdio: "ignore", timeout: GUEST_TIMEOUT_MS },
    );
    let token = "";
    for (let i = 0; i < 10; i++) {
      await sleep(1000);
      try {
        token = execFileSync(
          join(os.homedir(), "VMs/myco-win11/scripts/vssh"),
          ["Get-Content C:\\ProgramData\\Myco\\agent.token"],
          { encoding: "utf8", timeout: GUEST_TIMEOUT_MS },
        ).trim();
        if (token.length > 20) break;
      } catch {}
    }
    if (!token) throw new Error("myco-agent token could not be read");

    // 5. Connect AgentClient over tunnel
    if (activeTunnel) {
      try {
        activeTunnel.stop();
      } catch {}
      activeTunnel = undefined;
    }
    console.log(`[${target.index}] Opening SSH tunnel for myco-agent...`);
    activeTunnel = new SshTunnel();
    await activeTunnel.start();
    const client = AgentClient.overTunnel(activeTunnel, { token });
    let pingOk = false;
    for (let i = 0; i < 15; i++) {
      try {
        const pong = await client.ping();
        console.log(`[${target.index}] myco-agent ping verified:`, pong.backend);
        pingOk = true;
        break;
      } catch {
        await sleep(1000);
      }
    }
    if (!pingOk) throw new Error("myco-agent did not answer ping");

    // 6. Convert fixture
    // Everything from here mutates the guest: convert writes nonce dirs and step
    // 7 launches Calc. A throw in between (no xlsx path, no Calc window, UNO
    // timeout) used to leave both behind - the same leak class fixed in
    // c1-trial.ts. Reaped on the way out so a failed prepare cannot contaminate
    // the trials that follow it.
    const runRoot = `C:\\myco\\runs\\${target.index}`;
    let converterRef: WindowsFixtureConverter | undefined;
    try {
      console.log(`[${target.index}] Converting fixture for seed: ${target.params.fixtureSeed}...`);
      const fixture = generateFixture(target.params.fixtureSeed);
      const converter = new WindowsFixtureConverter({
        client,
        guestDir: runRoot,
        timeoutMs: 90_000,
      });
      converterRef = converter;
      await converter.convert(Buffer.from(fixture.csv, "utf8"));
      const xlsxPath = converter.lastXlsxPath;
      if (!xlsxPath) throw new Error("fixture convert produced no path");
      console.log(`[${target.index}] Fixture converted: ${xlsxPath}`);

      // 7. Launch Calc on fixture with UNO accept socket 2002
      console.log(`[${target.index}] Launching Calc on fixture with UNO accept socket 2002...`);
      const unoSocket = "2002";
      await client.launch([
        "C:\\Program Files\\LibreOffice\\program\\soffice.exe",
        `--accept=socket,host=127.0.0.1,port=${unoSocket};urp;`,
        "--norestore",
        "--nologo",
        xlsxPath,
      ]);

      // 8. Find Calc window in Cua
      console.log(`[${target.index}] Finding Calc window in Cua...`);
      let windowInfo: { pid: number; window_id: number } | undefined;
      for (let attempt = 0; attempt < 30; attempt++) {
        await sleep(1000);
        try {
          const resJson = execFileSync(
            join(os.homedir(), "VMs/myco-win11/scripts/vssh"),
            ["C:\\myco\\bin\\cua-driver.exe call list_windows '{}'"],
            { input: "", encoding: "utf8", timeout: GUEST_TIMEOUT_MS },
          );
          const parsed = JSON.parse(resJson);
          const win = parsed.windows?.find(
            (w: { app_name?: string; title?: string; pid: number; window_id: number }) =>
              w.app_name?.toLowerCase().includes("soffice") ||
              w.app_name?.toLowerCase().includes("calc") ||
              w.title?.toLowerCase().includes("calc"),
          );
          if (win) {
            windowInfo = { pid: win.pid, window_id: win.window_id };
            console.log(
              `[${target.index}] Found Calc window: pid=${win.pid}, window_id=${win.window_id}`,
            );
            break;
          }
        } catch {}
      }
      if (!windowInfo) throw new Error("Calc window not found after launch");

      // 9. Wait for UNO readiness
      console.log(`[${target.index}] Polling UNO socket readiness...`);
      const gt = groundTruth(target.params);
      const unoDeadline = Date.now() + 60_000;
      let unoReady = false;
      while (Date.now() < unoDeadline) {
        try {
          await client.unoEval({
            call: "get_string",
            cell: gt.cellRef,
            socket: unoSocket,
          });
          console.log(`[${target.index}] UNO socket ready (initial ${gt.cellRef} readable)`);
          unoReady = true;
          break;
        } catch {
          await sleep(500);
        }
      }
      if (!unoReady) throw new Error("UNO socket timed out before becoming ready");

      // 10. Wire connect, closeTransport, judge, audit
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
              { input: "", encoding: "utf8", timeout: GUEST_TIMEOUT_MS },
            );
            const parsed = JSON.parse(resJson);
            const win = parsed.windows?.find(
              (w: { app_name?: string; title?: string; pid: number; window_id: number }) =>
                w.app_name?.toLowerCase().includes("soffice") ||
                w.app_name?.toLowerCase().includes("calc") ||
                w.title?.toLowerCase().includes("calc") ||
                w.pid === windowInfo?.pid,
            );
            if (!win) return "closed";
            const dialog = parsed.windows?.find(
              (w: { app_name?: string; title?: string; pid: number; window_id: number }) =>
                (w.pid === windowInfo?.pid || w.app_name === win.app_name) &&
                (w.title?.toLowerCase().includes("save") ||
                  w.title?.toLowerCase().includes("confirm") ||
                  w.title?.toLowerCase().includes("error")),
            );
            if (dialog) return "dialog";
            return "open";
          } catch {
            return "unavailable";
          }
        },
      });

      const { driver, diagnostic } = probeC1Driver(windowInfo.pid, pipeReachable);
      console.log(`C1 driver preflight: ${diagnostic}`);
      return {
        // Carry the cause into the row: a driver-unreachable verdict must name
        // its reason, or a too-tight timeout and a dead driver are the same
        // artifact. See DriverPrecondition.diagnostic.
        //
        // `classifySession` returns the sentinel `match` on success, and `match`
        // is not a cause. Persisting it would put `diagnostic: "match"` on every
        // healthy row and contradict the field's contract, so success records
        // nothing.
        driver: { ...driver, ...persistedDiagnostic(diagnostic) },
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
    } catch (error) {
      // Reap before propagating: a prepare that dies half-way otherwise hands
      // the next slot a live soffice and a stale nonce dir.
      if (converterRef || runRoot) {
        try {
          const tail = (path: string | null | undefined) =>
            path ? path.split(/[\\/]/).pop() : undefined;
          const cleanup = await cleanupTrialGuest({
            client,
            runRoot,
            runDirName: tail(converterRef?.lastRunDir),
            profileDirName: tail(converterRef?.lastProfileDir),
          });
          console.log(
            `[${target.index}] Reaped after failed prepare: killed=${JSON.stringify(cleanup.killed)} removed=${JSON.stringify(cleanup.removed)} residue=${JSON.stringify(cleanup.residue)}`,
          );
        } catch (reapError) {
          console.error(
            `[${target.index}] Reap failed:`,
            reapError instanceof Error ? reapError.message : reapError,
          );
        }
      }
      throw error;
    }
  }

  try {
    const planner = createPlanner(fetch, { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY });
    console.log("--> Planner type: Paid Claude Sonnet (claude-sonnet-5-5) [fail-closed]");

    // Prior spend and the remaining budget come from the environment, because
    // the ceiling is a property of the PROJECT, not of this directory's ledger.
    // Both are required together: a remaining budget without a stated prior spend
    // would be un-auditable, and prior spend without a remaining budget would let
    // the caller inherit a default that cannot be spent. Fail closed if either is
    // missing rather than defaulting to zero, which is how a fresh directory
    // silently got a full allowance it had already spent part of (arm-003d).
    const { priorSpendMicros, remainingMicros } = parseSpendCeiling(process.env);

    const report = await runC1Sweep({
      coordinatorGo: process.argv.includes("--coordinator-go"),
      directory,
      priorSpendMicros,
      armLimitMicros: remainingMicros,
      planner,
      prepare,
    });

    console.log("\n=== C1 SWEEP COMPLETE ===");
    console.log(JSON.stringify(report, null, 2));
  } finally {
    if (activeTunnel) {
      try {
        activeTunnel.stop();
      } catch {}
      activeTunnel = undefined;
    }
  }
}

main().catch((err) => {
  console.error("FATAL C1 SWEEP ERROR:", err);
  process.exit(1);
});
