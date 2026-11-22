/**
 * Approval handling. Link-only approvals are captured to a private file OUTSIDE the repo and the task
 * is aborted; they are never opened, answered or bypassed. Ordinary approvals are answered only when
 * the action matches an explicit, narrow allow-list for the task being run; everything else aborts.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface Approval {
  approvalId?: string;
  title?: string;
  description?: string;
  approvalType?: string;
  isLinkOnly?: boolean;
  approvalUrl?: string;
  command?: string;
  cwd?: string;
  questions?: unknown;
}

export type ApprovalDecision =
  | { action: "capture_and_abort"; reason: "link_only"; file: string; embedsToken: boolean }
  | { action: "approve"; response: "yes"; reason: string }
  | { action: "abort"; reason: string };

export const APPROVAL_DIR = "/private/tmp/sai-setup";

export function approvalFile(n: number, dir = APPROVAL_DIR): string {
  return `${dir}/approval-${n}.txt`;
}

/**
 * Heuristic only, recorded as an observation: does the URL carry a query value other than the
 * documented `from=api`? (The documented shape embeds the user id and approval id in the path.)
 */
export function approvalUrlEmbedsToken(url: string): boolean {
  try {
    const u = new URL(url);
    for (const [key] of u.searchParams) if (key !== "from") return true;
    return false;
  } catch {
    return true;
  }
}

export interface ApprovalPolicy {
  /** Return an explanation when the command is clearly harmless and inside this task's sandbox. */
  allowCommand: (command: string, cwd: string | undefined) => string | null;
  /** Counter for the approval file name; starts at the next free number. */
  nextFileNumber: () => number;
  dir?: string;
}

const NOTEPAD_NO_ARGS =
  /^(?:(?:cmd(?:\.exe)? +\/c +)?start +(?:"" +)?|start-process +)?(?:notepad(?:\.exe)?|"notepad(?:\.exe)?"|'notepad(?:\.exe)?')$/i;

/** T1 policy: exact no-argument Notepad launch only. */
export function notepadOnlyPolicy(
  nextFileNumber: () => number,
  dir = APPROVAL_DIR,
): ApprovalPolicy {
  return {
    allowCommand: (command) =>
      NOTEPAD_NO_ARGS.test(command.trim()) ? "exact no-argument Notepad launch" : null,
    nextFileNumber,
    dir,
  };
}

/** Policy for tasks that must not need any command approval: everything aborts. */
export function denyAllPolicy(nextFileNumber: () => number, dir = APPROVAL_DIR): ApprovalPolicy {
  return { allowCommand: () => null, nextFileNumber, dir };
}

export function decideApproval(approval: Approval, policy: ApprovalPolicy): ApprovalDecision {
  let url = approval.approvalUrl;
  if (!url) {
    const candidates = [
      approval.description,
      approval.title,
      (approval as Record<string, unknown>).message,
      (approval as Record<string, unknown>).error,
      (approval as Record<string, unknown>).errorText,
      (approval as Record<string, unknown>).text,
    ];
    for (const c of candidates) {
      if (typeof c === "string") {
        const match = c.match(/https?:\/\/[^\s"'<>]+/i);
        if (match) {
          url = match[0];
          break;
        }
      }
    }
  }
  if (approval.isLinkOnly === true || url !== undefined) {
    const file = approvalFile(policy.nextFileNumber(), policy.dir);
    url ??= "";
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, url, { mode: 0o600, flag: "wx" });
    return {
      action: "capture_and_abort",
      reason: "link_only",
      file,
      embedsToken: url === "" ? false : approvalUrlEmbedsToken(url),
    };
  }
  if (approval.approvalType === "exec" && typeof approval.command === "string") {
    const why = policy.allowCommand(approval.command, approval.cwd);
    if (why) return { action: "approve", response: "yes", reason: why };
    return { action: "abort", reason: "exec approval outside allow-list" };
  }
  return { action: "abort", reason: "non-exec approval is never auto-approved" };
}

/** T1 requests a GUI save. Allow the no-argument launch and an exact read of its saved note. */
export function sandboxScopedPolicy(
  sandboxRoot: string,
  nextFileNumber: () => number,
  dir = APPROVAL_DIR,
): ApprovalPolicy {
  const root = sandboxRoot.toLowerCase();
  const note = "note.txt";
  return {
    allowCommand: (command) => {
      const trimmed = command.trim();
      if (NOTEPAD_NO_ARGS.test(trimmed)) return "exact no-argument Notepad launch";
      const read = /^get-content +(?:-literalpath +)?(?:'([^']+)'|"([^"]+)"|([^ ]+))$/i.exec(
        trimmed,
      );
      const path = (read?.[1] ?? read?.[2] ?? read?.[3])?.toLowerCase();
      const prefix = `${root}\\`;
      if (path?.startsWith(prefix) && path.slice(prefix.length) === note) {
        return "read the T1 note";
      }
      return null;
    },
    nextFileNumber,
    dir,
  };
}
