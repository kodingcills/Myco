/**
 * A fake Calc guest for the hcu+shell arm: a GUI channel, a read-only guest shell over a
 * virtual filesystem, and an independent judge that reads the same persisted state.
 *
 * Not canned strings: the GUI edits a cell model, Ctrl+S opens LibreOffice's "Keep Current
 * Format" dialog (the C1 failure mode, `docs/m1-scorecard.md` row 7), Enter commits the save
 * and Escape cancels it. The shell reads the persisted bytes the save produced, and the
 * judge reads them separately, so a test can tell "saved" from "typed and abandoned".
 *
 * The virtual filesystem also holds a ground-truth file under a denied directory, so tests
 * can show the arm never reaches it, and an optional "link" that resolves into it, so tests
 * can show the post-resolution check catching an escape the pre-check cannot see.
 */
import { createHash } from "node:crypto";
import {
  createShellPolicy,
  type GuestShell,
  type ShellPolicy,
} from "../../../src/baseline/hcu-shell/shell-tool.ts";
import type { HcuGui, PreparedHcuShell } from "../../../src/baseline/hcu-shell/trial.ts";
import type { Action, Observation } from "../../../src/baseline/index.ts";

export const DOC_DIR = "c:/myco/work";
export const DOC = `${DOC_DIR}/task.xlsx`;
export const SCRATCH = "c:/myco/scratch";
export const JUDGE_DIR = "c:/myco-host/judge";
export const GROUND_TRUTH_FILE = `${JUDGE_DIR}/expected.json`;
export const LINK = `${DOC_DIR}/notes.txt`;

export function cellPoint(cellRef: string): { x: number; y: number } {
  const match = /^([A-Z])(\d+)$/.exec(cellRef);
  if (!match) throw new Error(`fake supports single-letter columns, got ${cellRef}`);
  const col = (match[1] ?? "A").charCodeAt(0) - 65;
  return { x: 60 + 100 * col, y: 40 + 20 * (Number(match[2]) - 1) };
}

function cellAt(x: number, y: number): string {
  const col = Math.round((x - 60) / 100);
  const row = Math.round((y - 40) / 20) + 1;
  return `${String.fromCharCode(65 + col)}${row}`;
}

export interface FakeCalcOptions {
  cellRef: string;
  previousValue: string;
  expected: string;
  /** Make `LINK` resolve into the ground-truth file (a symlink/junction escape). */
  linkEscapes?: boolean;
  /** Make every shell call throw (the guest cannot audit). */
  shellFails?: boolean;
  /** HCU not ready. */
  driverDown?: boolean;
}

export interface FakeCalc {
  prepared: PreparedHcuShell;
  policy: ShellPolicy;
  /** What the guest shell actually executed. */
  shellLog: string[];
  persisted(): Record<string, string>;
}

export function fakeCalc(options: FakeCalcOptions): FakeCalc {
  const persisted: Record<string, string> = { [options.cellRef]: options.previousValue };
  const cells: Record<string, string> = { ...persisted };
  let dirty = false;
  let dialog = false;
  const shellLog: string[] = [];
  const csv = () =>
    Object.entries(persisted)
      .sort()
      .map(([ref, value]) => `${ref},${value}`)
      .join("\n");
  const files = (): Record<string, string> => ({
    [DOC]: `xlsx:${csv()}`,
    [LINK]: "todo: edit the cell",
    [GROUND_TRUTH_FILE]: JSON.stringify({ cellRef: options.cellRef, expected: options.expected }),
  });

  const gui: HcuGui = {
    async screenshot() {
      const digest = createHash("sha256")
        .update(JSON.stringify({ cells, dialog }))
        .digest("base64");
      return { mimeType: "image/png", data: digest.replace(/=+$/, "") };
    },
    async execute(action: Action) {
      const args = action.arguments as Record<string, unknown>;
      if (action.tool === "click") {
        // selecting a cell has no state effect here
      } else if (action.tool === "type_text" && !dialog) {
        cells[cellAt(Number(args.x), Number(args.y))] = String(args.text);
        dirty = true;
      } else if (action.tool === "press_key") {
        const key = String(args.key).toLowerCase();
        if (key === "ctrl+s" && dirty) dialog = true;
        else if (key === "enter" && dialog) {
          Object.assign(persisted, cells);
          dirty = false;
          dialog = false;
        } else if (key === "escape") dialog = false;
      }
      return { outcome: "delivered", deliveryMode: "background", escalated: false, verified: true };
    },
  };

  const shell: GuestShell = {
    async run(request) {
      shellLog.push(`${request.shell} ${request.path}`);
      if (options.shellFails) throw new Error("guest agent dropped the connection");
      const fs = files();
      const resolved =
        options.linkEscapes && request.path === LINK ? GROUND_TRUTH_FILE : request.path;
      const read = [{ operation: "read" as const, path: resolved }];
      switch (request.shell) {
        case "ls": {
          const names = Object.keys(fs)
            .filter((path) => path.startsWith(`${resolved}/`))
            .map((path) => path.slice(resolved.length + 1));
          return { output: names.join("\n"), accesses: read };
        }
        case "cat": {
          const body = fs[resolved];
          if (body === undefined) return { output: "cat: no such file", accesses: read };
          return { output: body, accesses: read };
        }
        case "sha256": {
          const body = fs[resolved] ?? "";
          return {
            output: createHash("sha256").update(body).digest("hex"),
            accesses: read,
          };
        }
        case "convert-csv":
          return {
            output: csv(),
            accesses: [...read, { operation: "write" as const, path: `${SCRATCH}/task.csv` }],
          };
      }
    },
  };

  const policy = createShellPolicy({
    style: "windows",
    documentPath: DOC,
    documentDir: DOC_DIR,
    scratchDir: SCRATCH,
    groundTruthDirs: [JUDGE_DIR],
  });

  const prepared: PreparedHcuShell = {
    driver: options.driverDown
      ? {
          hostVersion: "1",
          guestVersion: "1",
          pipeReachable: false,
          sessionIdentityMatches: true,
          diagnostic: "pipe-unreachable",
        }
      : { hostVersion: "1", guestVersion: "1", pipeReachable: true, sessionIdentityMatches: true },
    snapshot: "hcu-shell-base",
    resetMs: 21_000,
    fixtureSha256: createHash("sha256").update(options.previousValue).digest("hex"),
    acPower: true,
    caffeinate: true,
    loadAvg1: 1.5,
    shellPolicy: policy,
    connectGui: async () => gui,
    shell,
    closeTransport: async () => {},
    async judge(): Promise<Observation> {
      // Independent of the shell: reads the persisted model directly.
      if (dialog) return { kind: "dialog" };
      if (dirty) return { kind: "modified" };
      return {
        kind: "persisted",
        actual: persisted[options.cellRef] ?? "",
        expected: options.expected,
      };
    },
    audit: async () => persisted[options.cellRef] === options.expected,
  };
  return { prepared, policy, shellLog, persisted: () => ({ ...persisted }) };
}
