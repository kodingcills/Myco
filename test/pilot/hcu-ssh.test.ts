/**
 * #733 round 2: the one SSH channel to HCU (shared by the actuator CLI and the pre-agent
 * probe), the attach-form guard, and the probe itself (lead ruling 13:38Z, B1). Fakes only: no
 * SSH, no VM.
 */
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { DEFAULT_HCU_GUEST_COMMAND } from "../../src/baseline/hcu-shell-live/live-vm.ts";
import { isHcuAttachCommand } from "../../src/integrity/surface.ts";
import { ACTUATOR_SERVER_TEMPLATE } from "../../src/pilot/config.ts";
import { HCU_GUEST_COMMAND, HCU_SESSION_SOCKET } from "../../src/pilot/hcu-actuator.ts";
import {
  HCU_PROBE_TIMEOUT_MS,
  HCU_SSH_HOST,
  type HcuSpawn,
  hcuSshArgs,
  openHcuSession,
  probeHcuDesktop,
} from "../../src/pilot/hcu-ssh.ts";
import { realHcuProbe } from "../../src/pilot/vm-capture.ts";
import { fakeHcuSession } from "./fake-hcu.ts";
import { ROOT } from "./helpers.ts";

describe("the attach form (VM-owner finding on #733, lead ruling 14:00Z)", () => {
  it("the actuator's HCU command is the attach form, and the plan carries exactly it", () => {
    expect(HCU_GUEST_COMMAND).toBe(
      `C:\\myco\\bin\\computer-use.exe mcp --attach ${HCU_SESSION_SOCKET}`,
    );
    expect(isHcuAttachCommand(HCU_GUEST_COMMAND)).toBe(true);
    const args = ACTUATOR_SERVER_TEMPLATE.args as readonly string[];
    expect(args[args.indexOf("--hcu-command") + 1]).toBe(HCU_GUEST_COMMAND);
  });

  it("refuses the bare session-0 form and anything chained or extra", () => {
    for (const bad of [
      DEFAULT_HCU_GUEST_COMMAND,
      "C:\\myco\\bin\\computer-use.exe mcp --attach",
      "C:\\myco\\bin\\computer-use.exe serve",
      `${HCU_GUEST_COMMAND} & calc.exe`,
      `${HCU_GUEST_COMMAND}; whoami`,
      `${HCU_GUEST_COMMAND} --verbose`,
      `C:\\myco\\..\\bin\\computer-use.exe mcp --attach ${HCU_SESSION_SOCKET}`,
      `C:\\myco\\bin\\computer-use.exe mcp --attach C:\\myco\\..\\x.sock`,
      `powershell -c C:\\myco\\bin\\computer-use.exe mcp --attach ${HCU_SESSION_SOCKET}`,
      "",
    ])
      expect(isHcuAttachCommand(bad), bad).toBe(false);
  });

  it("the ssh argv: the trial VM's ssh_config and host, then the attach command, nothing else", () => {
    expect(hcuSshArgs(HCU_GUEST_COMMAND, "/home/op")).toEqual([
      "-F",
      "/home/op/VMs/myco-win11/ssh_config",
      "-o",
      "LogLevel=ERROR",
      HCU_SSH_HOST,
      HCU_GUEST_COMMAND,
    ]);
  });

  it("a non-attach command is refused before ssh is spawned", () => {
    const calls: string[] = [];
    const spawn: HcuSpawn = (command) => {
      calls.push(command);
      throw new Error("must not spawn");
    };
    expect(() => openHcuSession(spawn, DEFAULT_HCU_GUEST_COMMAND, "/h")).toThrow(/attach form/);
    expect(calls).toEqual([]);
  });

  it("opens ssh with stderr dropped and closes the child with the session", () => {
    const calls: { command: string; args: readonly string[]; options: SpawnOptions }[] = [];
    const kills: number[] = [];
    const spawn: HcuSpawn = (command, args, options) => {
      calls.push({ command, args, options });
      const child = new EventEmitter() as ChildProcess & EventEmitter;
      Object.assign(child, {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        kill: () => {
          kills.push(1);
          return true;
        },
      });
      return child;
    };
    const s = openHcuSession(spawn, HCU_GUEST_COMMAND, "/h");
    expect(calls.map((c) => [c.command, c.args.at(-1), c.options.stdio])).toEqual([
      ["ssh", HCU_GUEST_COMMAND, ["pipe", "pipe", "ignore"]],
    ]);
    s.close();
    expect(kills).toEqual([1]);
  });
});

describe("probeHcuDesktop: connect plus ONE successful screenshot (lead ruling 13:38Z, B1)", () => {
  it("resolves when HCU answers, serves GUI and produces a screenshot; the session is closed", async () => {
    const hcu = fakeHcuSession("ok");
    await expect(probeHcuDesktop(hcu.open, 500)).resolves.toBeUndefined();
    expect(hcu.log).toEqual(["hcu-open", "hcu-screenshot", "hcu-close"]);
    expect(hcu.closed()).toBe(1);
  });

  for (const mode of ["unreachable", "no-screenshot", "no-image", "no-gui", "hang"] as const)
    it(`rejects, codes only, when HCU is ${mode}; the session never leaks open`, async () => {
      const hcu = fakeHcuSession(mode);
      const error = await probeHcuDesktop(hcu.open, 100).then(
        () => null,
        (e: unknown) => e as Error,
      );
      expect(error).toBeInstanceOf(Error);
      expect(error?.message).toBe("hcu-unreachable");
      expect(error?.message).not.toContain("secret host detail");
      if (mode !== "unreachable") expect(hcu.closed()).toBe(1);
    });

  it("the screenshot is required, not just the connect (mutant: screenshot dropped)", async () => {
    const hcu = fakeHcuSession("no-screenshot");
    await expect(probeHcuDesktop(hcu.open, 500)).rejects.toThrow("hcu-unreachable");
    expect(hcu.log).toContain("hcu-screenshot");
  });

  it("is bounded (60 s by default)", () => {
    expect(HCU_PROBE_TIMEOUT_MS).toBe(60_000);
  });
});

/**
 * A fake `ssh` whose child speaks HCU's MCP on stdio (newline-delimited JSON-RPC), so the real
 * backend's probe runs end to end: `openHcuSession` -> `mcpStdio` -> `connectHcuGui`.
 */
function fakeSshHcu(screenshot: "ok" | "error") {
  const calls: { command: string; args: readonly string[] }[] = [];
  let killed = 0;
  const spawn: HcuSpawn = (command, args) => {
    calls.push({ command, args });
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    let buf = "";
    stdin.on("data", (d: Buffer) => {
      buf += d.toString("utf8");
      let nl = buf.indexOf("\n");
      while (nl >= 0) {
        const msg = JSON.parse(buf.slice(0, nl)) as { id?: number; method: string };
        buf = buf.slice(nl + 1);
        nl = buf.indexOf("\n");
        if (msg.id === undefined) continue;
        const result =
          msg.method === "initialize"
            ? { protocolVersion: "2025-06-18" }
            : msg.method === "tools/list"
              ? { tools: [{ name: "GUI" }] }
              : screenshot === "ok"
                ? {
                    content: [
                      { type: "text", text: '{"ok":true}' },
                      { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" },
                    ],
                  }
                : { isError: true, content: [{ type: "text", text: '{"ok":false}' }] };
        stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result })}\n`);
      }
    });
    const child = new EventEmitter() as ChildProcess & EventEmitter;
    Object.assign(child, {
      stdin,
      stdout,
      kill: () => {
        killed += 1;
        return true;
      },
    });
    return child;
  };
  return { spawn, calls, killed: () => killed };
}

describe("the real backend's probe (realHcuProbe), end to end through a fake ssh", () => {
  it("runs ssh with the actuator's attach command and resolves on one screenshot; ssh is closed", async () => {
    const ssh = fakeSshHcu("ok");
    await expect(realHcuProbe(ssh.spawn, "/home/op", 2000)).resolves.toBeUndefined();
    expect(ssh.calls).toEqual([
      { command: "ssh", args: hcuSshArgs(HCU_GUEST_COMMAND, "/home/op") },
    ]);
    expect(ssh.killed()).toBe(1);
  });

  it("rejects when the guest HCU cannot screenshot the desktop", async () => {
    const ssh = fakeSshHcu("error");
    await expect(realHcuProbe(ssh.spawn, "/home/op", 2000)).rejects.toThrow("hcu-unreachable");
    expect(ssh.killed()).toBe(1);
  });

  it("realVmBackend wires probeHcu to realHcuProbe (the backend itself is never built in a test)", () => {
    const src = readFileSync(join(ROOT, "src/pilot/vm-capture.ts"), "utf8");
    const backend = src.slice(src.indexOf("export function realVmBackend("));
    expect(backend).toMatch(/probeHcu: \(\) => realHcuProbe\(spawn, homedir\(\)\),/);
  });
});
