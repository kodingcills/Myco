/**
 * Handoff notifiers (capability track N). Pluggable (`HandoffNotifier`); local only. No network
 * notifier ships here: a webhook or chat notifier would send run data off the host and is a
 * separate, reviewed change.
 *
 *  - `terminalNotifier`: a terminal bell and one line on the operator's stream (stderr in the
 *    CLI), with the resolve command to run.
 *  - `desktopNotifier`: a desktop notification where the platform has one (`osascript` on macOS,
 *    `notify-send` on Linux), via `execFile` with an argv array (no shell). Missing tools and
 *    failures are swallowed: a notification is best effort, the handoff deadline is not.
 *  - `combineNotifiers`: fan out; one failing notifier does not stop the others.
 *
 * Agent-written text (the note) is passed through `terminalSafe` before it reaches a TTY, so an
 * agent cannot smuggle escape sequences into the operator's terminal; the desktop message carries
 * no agent text at all.
 */
import { execFile } from "node:child_process";
import type { Writable } from "node:stream";
import type { HandoffNotice, HandoffNotifier } from "./broker.ts";
import { terminalSafe } from "./protocol.ts";

export function terminalNotifier(stream: Writable): HandoffNotifier {
  return {
    notify(n: HandoffNotice) {
      const who = n.source === "policy" ? `policy ${n.policyId}` : "agent";
      stream.write(
        `\u0007[myco handoff] ${n.handoffId} run ${terminalSafe(n.runId, 64)} task ${terminalSafe(n.taskId, 64)}: ` +
          `${n.reason} (from ${who}) until ${n.deadlineAt}\n` +
          `  note: ${terminalSafe(n.note)}\n` +
          `  resolve: myco-handoff resolve ${n.handoffId} approve|reject|fixed-it --connection <file>\n`,
      );
    },
  };
}

export type ExecFileLike = (
  file: string,
  args: readonly string[],
  callback: (error: Error | null) => void,
) => void;

const realExec: ExecFileLike = (file, args, callback) => {
  execFile(file, [...args], { timeout: 5_000, windowsHide: true }, (error) => callback(error));
};

/** The desktop notification argv for `platform`, or null when it has none here. Exported for tests. */
export function desktopCommand(
  platform: NodeJS.Platform,
  n: HandoffNotice,
): { file: string; args: string[] } | null {
  const message = `${n.handoffId}: ${n.reason} (${n.source}). Resolve with myco-handoff.`;
  if (platform === "darwin")
    return {
      file: "osascript",
      // The message is an argv item read by the script, never spliced into AppleScript source.
      args: [
        "-e",
        "on run argv",
        "-e",
        'display notification (item 1 of argv) with title "Myco handoff"',
        "-e",
        "end run",
        message,
      ],
    };
  if (platform === "linux") return { file: "notify-send", args: ["Myco handoff", message] };
  return null;
}

export function desktopNotifier(
  opts: { platform?: NodeJS.Platform; exec?: ExecFileLike } = {},
): HandoffNotifier {
  const platform = opts.platform ?? process.platform;
  const exec = opts.exec ?? realExec;
  return {
    notify(n: HandoffNotice) {
      const cmd = desktopCommand(platform, n);
      if (!cmd) return;
      return new Promise<void>((resolve) => exec(cmd.file, cmd.args, () => resolve()));
    },
  };
}

export function combineNotifiers(...notifiers: readonly HandoffNotifier[]): HandoffNotifier {
  return {
    async notify(n: HandoffNotice) {
      await Promise.allSettled(notifiers.map(async (x) => x.notify(n)));
    },
  };
}

/** The local default: bell + line on `stream`, plus a desktop notification where available. */
export function defaultNotifier(stream: Writable): HandoffNotifier {
  return combineNotifiers(terminalNotifier(stream), desktopNotifier());
}
