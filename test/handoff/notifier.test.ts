/**
 * Track N notifiers: local only, best effort, and agent text never reaches a TTY raw.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import type { HandoffNotice } from "../../src/handoff/broker.ts";
import {
  combineNotifiers,
  desktopCommand,
  desktopNotifier,
  terminalNotifier,
} from "../../src/handoff/notifier.ts";

const notice: HandoffNotice = {
  handoffId: "ho-1",
  runId: "run-1",
  taskId: "df-s01",
  source: "agent",
  policyId: null,
  reason: "blocked",
  note: "dialog \u001b]0;pwned\u0007 won't close",
  deadlineAt: "2026-11-26T15:15:00.000Z",
};

describe("handoff notifiers", () => {
  it("the terminal notifier rings the bell, says how to resolve, and neutralises escapes", () => {
    const out = new PassThrough();
    terminalNotifier(out).notify(notice);
    const text = (out.read() as Buffer).toString();
    expect(
      text.startsWith("\u0007[myco handoff] ho-1 run run-1 task df-s01: blocked (from agent)"),
    ).toBe(true);
    expect(text).toContain("myco-handoff resolve ho-1 approve|reject|fixed-it");
    // Only our own leading BEL; the agent's ESC and BEL became "?".
    const controls = [...text.slice(1)].filter((c) => c !== "\n" && (c.codePointAt(0) ?? 0) < 0x20);
    expect(controls).toEqual([]);
    expect(text).toContain("dialog ?]0;pwned? won't close");
  });

  it("the desktop command passes the message as argv, never as script source, and has no agent text", () => {
    const mac = desktopCommand("darwin", notice);
    expect(mac?.file).toBe("osascript");
    expect(mac?.args.at(-1)).toBe("ho-1: blocked (agent). Resolve with myco-handoff.");
    expect(mac?.args.join(" ")).not.toContain("dialog");
    expect(desktopCommand("linux", notice)).toEqual({
      file: "notify-send",
      args: ["Myco handoff", "ho-1: blocked (agent). Resolve with myco-handoff."],
    });
    expect(desktopCommand("win32", notice)).toBeNull();
  });

  it("a missing desktop tool is swallowed; one failing notifier does not stop the others", async () => {
    const calls: string[] = [];
    const failing = desktopNotifier({
      platform: "linux",
      exec: (file, _args, cb) => {
        calls.push(file);
        cb(new Error("ENOENT"));
      },
    });
    const out = new PassThrough();
    await combineNotifiers(
      failing,
      {
        notify: () => {
          throw new Error("boom");
        },
      },
      terminalNotifier(out),
    ).notify(notice);
    expect(calls).toEqual(["notify-send"]);
    expect((out.read() as Buffer).toString()).toContain("ho-1");
  });

  it("no network notifier ships: the module imports no network client", () => {
    const src = readFileSync(
      join(import.meta.dirname, "..", "..", "src", "handoff", "notifier.ts"),
      "utf8",
    );
    expect(src).not.toMatch(/from "node:(?:http|https|net|dgram|tls)"|fetch\(/);
  });
});
