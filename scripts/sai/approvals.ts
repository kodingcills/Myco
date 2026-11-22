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
  /^(?:(?:cmd(?:\.exe)?\s+\/c\s+)?start\s+(?:""\s+)?|start-process\s+)?["']?notepad(?:\.exe)?["']?\s*$/i;

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
  if (approval.isLinkOnly === true || approval.approvalUrl !== undefined) {
    const file = approvalFile(policy.nextFileNumber(), policy.dir);
    const url = approval.approvalUrl ?? "";
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(
      file,
      `${url}\n# type=${approval.approvalType ?? "unknown"} title=${approval.title ?? ""}\n# private: never commit, never open for the user\n`,
      { mode: 0o600 },
    );
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
    return {
      action: "abort",
      reason: `exec approval outside allow-list: ${approval.command.slice(0, 120)}`,
    };
  }
  return {
    action: "abort",
    reason: `non-exec approval (${approval.approvalType ?? "unknown"}) is never auto-approved`,
  };
}

const DENY_TOKENS =
  /\b(invoke-webrequest|invoke-restmethod|iwr|irm|iex|invoke-expression|curl|wget|start-bitstransfer|new-service|set-service|sc\.exe|schtasks|reg|reg\.exe|set-itemproperty|remove-item|del|rd|rmdir|format-volume|netsh|net|stop-computer|restart-computer|shutdown|add-type|downloadstring|encodedcommand|certutil|bitsadmin|mshta|rundll32|regsvr32|taskkill|stop-process|kill)\b|-enc\b/i;

/**
 * Amended policy (see PROTOCOL.md amendment 1): approve an exec command only when it is the exact
 * no-argument Notepad launch, or when it touches no network/registry/service/delete verb and every
 * absolute Windows path in it lies under the task's sandbox directory, with at least one such path.
 */
export function sandboxScopedPolicy(
  sandboxRoot: string,
  nextFileNumber: () => number,
  dir = APPROVAL_DIR,
): ApprovalPolicy {
  const root = sandboxRoot.toLowerCase().replace(/\//g, "\\");
  return {
    allowCommand: (command) => {
      const trimmed = command.trim();
      if (NOTEPAD_NO_ARGS.test(trimmed)) return "exact no-argument Notepad launch";
      if (DENY_TOKENS.test(trimmed)) return null;
      const paths = trimmed.match(/[A-Za-z]:\\[^\s"'|;)<>]*/g) ?? [];
      if (paths.length === 0) return null;
      const inside = paths.every((p) => p.toLowerCase().replace(/\//g, "\\").startsWith(root));
      return inside ? "harmless command confined to this task's sandbox directory" : null;
    },
    nextFileNumber,
    dir,
  };
}
