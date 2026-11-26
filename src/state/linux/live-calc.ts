/**
 * A live headless Calc session for one trial on the Linux path (capability track I).
 *
 * The existing Linux actuator (`src/linux/actuator.ts`) opens, types, saves and closes in
 * one shot, so there is no live app to read between steps. A structured-state trial needs
 * the app to stay up: this module starts ONE soffice per trial, with a throwaway profile,
 * the trial's document loaded, and a UNO pipe whose name the harness derives from the run
 * id plus randomness. Two kinds of UNO client then connect to it:
 *
 *  - the `myco-state` server's reader (`calc_state.py`, read-only), given the pipe name by
 *    the harness through `MYCO_STATE_UNO_PIPE`;
 *  - the arm's acting channel (`calc_live_act.py`): here, the $0 scripted agent's hands.
 *
 * After the agent stops, `stop()` ends soffice; the gate then reads the bytes the harness
 * captured from disk, never this session.
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DOC_UID, linuxUnoBackend } from "./uno.ts";

export const LIVE_ACT_SCRIPT = resolve(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "scripts",
  "linux",
  "calc_live_act.py",
);

/** A fresh pipe name for `runId`'s session: never a path, never reused. */
export function statePipeFor(runId: string): string {
  const tag = createHash("sha256").update(runId).digest("hex").slice(0, 16);
  return `myco-state-${tag}-${randomBytes(6).toString("hex")}`;
}

export interface LiveCalcOptions {
  /** The trial's working document (the agent's own copy, never the pristine fixture). */
  readonly docPath: string;
  readonly runId: string;
  readonly soffice?: string;
  readonly python?: string;
  /** How long to wait for the document to be readable, ms. */
  readonly readyTimeoutMs?: number;
}

export interface ActReport {
  readonly ok: boolean;
  readonly after?: string;
  readonly error?: string;
}

export interface LiveCalc {
  readonly pipe: string;
  /**
   * The trial document's RuntimeUID, read once it loaded. The harness binds the state server
   * to it (`MYCO_STATE_DOC_UID`), so a document opened in its place is never read.
   */
  readonly docUid: string;
  /** Type `value` into `cell` of the first sheet through Calc's input path. */
  type(cell: string, value: string): ActReport;
  /** Store the document to its own location. */
  save(): ActReport;
  /** End soffice and remove the throwaway profile. Idempotent. */
  stop(): Promise<void>;
}

export async function startLiveCalc(options: LiveCalcOptions): Promise<LiveCalc> {
  const pipe = statePipeFor(options.runId);
  const python = options.python ?? process.env.MYCO_PYTHON ?? "python3";
  const work = mkdtempSync(join(tmpdir(), "myco-live-calc-"));
  const child: ChildProcess = spawn(
    options.soffice ?? process.env.MYCO_SOFFICE ?? "soffice",
    [
      "--headless",
      "--invisible",
      "--norestore",
      "--nologo",
      `-env:UserInstallation=${pathToFileURL(join(work, "profile")).href}`,
      `--accept=pipe,name=${pipe};urp;`,
      options.docPath,
    ],
    { stdio: "ignore" },
  );
  let stopped = false;
  const exited = new Promise<void>((done) => child.once("exit", () => done()));
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    // Close without storing and terminate through UNO, so soffice removes its lock file;
    // a signal is only the fallback (a killed soffice leaves `.~lock.<name>#` behind, and the
    // next session would then open the document read-only).
    if (child.exitCode === null) act(["--timeout", "5", "quit"]);
    const term = setTimeout(() => child.kill("SIGTERM"), 5_000);
    const kill = setTimeout(() => child.kill("SIGKILL"), 15_000);
    if (child.exitCode === null && child.signalCode === null) await exited;
    clearTimeout(term);
    clearTimeout(kill);
    rmSync(join(dirname(options.docPath), `.~lock.${basename(options.docPath)}#`), {
      force: true,
    });
    rmSync(work, { recursive: true, force: true });
  };
  function act(args: readonly string[]): ActReport {
    const result = spawnSync(python, [LIVE_ACT_SCRIPT, "--pipe", pipe, ...args], {
      encoding: "utf8",
      timeout: 60_000,
    });
    try {
      return JSON.parse((result.stdout ?? "").trim().split("\n").pop() ?? "") as ActReport;
    } catch {
      return { ok: false, error: `actor failed (exit ${String(result.status)})` };
    }
  }

  // Ready when exactly one spreadsheet is loaded (its RuntimeUID is then the binding) and the
  // reader, bound to that uid, can read it.
  const deadline = Date.now() + (options.readyTimeoutMs ?? 60_000);
  let docUid = "";
  for (;;) {
    const bound = act(["--timeout", "5", "uid"]) as ActReport & { uid?: unknown };
    if (bound.ok && typeof bound.uid === "string" && DOC_UID.test(bound.uid)) {
      const reader = linuxUnoBackend({ pipe, docUid: bound.uid, python, timeoutMs: 5_000 });
      if ((await reader.documentStatus()).ok) {
        docUid = bound.uid;
        break;
      }
    }
    if (Date.now() > deadline || child.exitCode !== null) {
      await stop();
      throw new Error("live Calc did not load the trial document in time");
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return {
    pipe,
    docUid,
    type: (cell, value) => act(["type", "--cell", cell, "--value", value]),
    save: () => act(["save"]),
    stop,
  };
}
