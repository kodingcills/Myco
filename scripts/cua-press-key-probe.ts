// biome-ignore-all lint/suspicious/noConsole: probe output goes to stdout.
/**
 * One-call probe: does Cua REFUSE the Ctrl+S combo, or DELIVER it and the app
 * blocks the save?
 *
 * The question arm-002 left open. Zero `press_key` calls across 422 actions, so
 * the baseline never learned which it was. arm-003c got `cua-action-refused`,
 * but that single string is compatible with both:
 *
 *   (a) Cua refused the key combo itself -> adapter/harness gap, fix it
 *   (b) Cua delivered the key, and the LibreOffice "Non-standard file format"
 *       dialog is what stops the save     -> legitimate baseline outcome, score it
 *
 * ANSWERED 2026-11-23: neither. Background `key_combo` on a SALFRAME window is
 * refused outright with code=background_unavailable, and it is not about the
 * key - `Ctrl+F12` is refused identically. Foreground delivery is accepted and
 * the key genuinely arrives (a Save As dialog appears). See RESULT.md beside
 * this script for the raw responses and the method.
 *
 * The decisive part is the RAW response, not the derived verdict: `effect`,
 * `isError`, and `path` are consumed and flattened by `C1.execute` (c1.ts:91),
 * which returns only `{refused, verified}`. This drives the MCP session directly
 * so nothing is lost.
 *
 * Transport is the harness's own, not a guess: spawn `cua-driver.exe mcp
 * --socket \\.\pipe\cua-driver` over ssh and wrap it with `mcpStdio`, exactly as
 * `scripts/c1-sweep.ts:224` does. An earlier draft invented a `call <tool>` CLI,
 * which does not exist.
 */
import { spawn } from "node:child_process";
import os from "node:os";
import { join } from "node:path";
import { connectC1, type Mcp, pixelAction } from "../src/baseline/c1.ts";
import { mcpStdio } from "../src/baseline/mcp-stdio.ts";

function spawnMcp() {
  const proc = spawn("ssh", [
    "-F",
    join(os.homedir(), "VMs/myco-win11/ssh_config"),
    "-o",
    "LogLevel=ERROR",
    "myco-win11",
    "C:\\myco\\bin\\cua-driver.exe mcp --socket \\\\.\\pipe\\cua-driver",
  ]);
  return { proc, mcp: mcpStdio(proc.stdin!, proc.stdout!) };
}

/** Call a tool and keep the whole response; `connectC1` would flatten it. */
async function rawCall(mcp: Mcp, tool: string, args: Record<string, unknown>): Promise<unknown> {
  return mcp.request("tools/call", { name: tool, arguments: args });
}

async function main(): Promise<void> {
  const pid = Number(process.argv[2]);
  const windowId = Number(process.argv[3]);
  if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(windowId)) {
    console.error("usage: cua-press-key-probe.ts <pid> <window_id>");
    process.exit(2);
  }
  const window = { pid, window_id: windowId };
  const { proc, mcp } = spawnMcp();
  const base = { pid, window_id: windowId };
  try {
    // Initialize through the harness's own handshake, so the session is set up
    // the way a real trial has it. Throws on protocol mismatch, as it should.
    await connectC1(mcp, window);

    // 1. Control click: proves the transport works at all. If the control is
    //    refused, the probe is measuring the transport, not the key.
    console.log("--- control: click");
    console.log(JSON.stringify(await rawCall(mcp, "click", { ...base, x: 160, y: 262 }), null, 2));

    // 2. The question. Ctrl+S is the combo `planner.ts:82` tells the model to
    //    send, in the shape `c1.ts:93` forwards.
    console.log("--- probe: press_key Ctrl+s");
    const saveKey = await rawCall(mcp, "press_key", { ...base, key: "Ctrl+s" });
    console.log(JSON.stringify(saveKey, null, 2));

    // 3. A combo with no app meaning. If Cua refuses BOTH this and Ctrl+S, the
    //    refusal is about keys generally rather than the save specifically.
    console.log("--- probe: press_key Ctrl+F12 (no save meaning)");
    console.log(
      JSON.stringify(await rawCall(mcp, "press_key", { ...base, key: "Ctrl+F12" }), null, 2),
    );

    // 4. Window state after the call. A modal lives in the same window, so this
    //    distinguishes "delivered and ignored" from "delivered and blocked".
    console.log("--- get_window_state after the calls");
    console.log(
      JSON.stringify(await rawCall(mcp, "get_window_state", base), null, 2).slice(0, 2000),
    );

    // The verdict the caller should read, stated once so the raw JSON above is
    // not misread: `pixelAction` is what a real trial applies, so this confirms
    // the probe's own action would have been legal too.
    console.log("--- would a real trial accept this action?");
    console.log(
      JSON.stringify(pixelAction({ tool: "press_key", arguments: { ...base, key: "Ctrl+s" } })),
    );
  } finally {
    mcp.close();
    proc.kill();
  }
}

void main();
