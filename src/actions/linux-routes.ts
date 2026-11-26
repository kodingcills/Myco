/**
 * Track J - the three routes on the Linux path (headless LibreOffice, no VM).
 *
 * - `api`    : `scripts/linux/calc_uno_api.py`, the UNO object model (cell API + store).
 * - `script` : one policy-approved argv, run with `spawnSync` and `shell: false`, working
 *              directory the trial workspace, a minimal environment, and a throwaway HOME
 *              outside the workspace (so soffice's profile never lands in it).
 * - `gui`    : the existing Linux actuator (`src/linux/actuator.ts`), which types through
 *              Calc's input path, the stand-in for a GUI channel on this path.
 *
 * Each route acts only on the resolved paths the policy approved (`ApprovedRequest`), never
 * on its own spelling of them, and reports what it did as a trace. None of them decides
 * whether the task is done.
 */

import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { type Actuator, pythonBinary, pythonUnoAvailable } from "../linux/actuator.ts";
import { sofficeBinary, sofficeVersion } from "../linux/soffice.ts";
import type { WorkspaceScope } from "./policy.ts";
import type { ActionRequest, ApprovedRequest, RouteExecutor, RouteRun } from "./router.ts";

export const UNO_API_SCRIPT = resolve(
  import.meta.dirname,
  "..",
  "..",
  "scripts",
  "linux",
  "calc_uno_api.py",
);

export interface LinuxRouteOptions {
  readonly scope: WorkspaceScope;
  /** soffice binary; defaults to `$MYCO_SOFFICE` or `soffice`. */
  readonly soffice?: string;
  /** Python with UNO; defaults to `$MYCO_PYTHON` or `python3`. */
  readonly python?: string;
  readonly timeoutMs?: number;
}

function inside(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/** The single document write a set-cell route may make: the trial document, resolved. */
function approvedDocument(approved: ApprovedRequest): string | null {
  return approved.writes.length === 1 ? (approved.writes[0] as string) : null;
}

function setCellPlan(route: "api" | "gui", scope: WorkspaceScope, action: ActionRequest) {
  if (action.kind !== "calc.set-cell") return null;
  return { route, kind: action.kind, reads: [scope.document], writes: [scope.document] };
}

/** The app-API route: UNO cell API + store, through `calc_uno_api.py`. */
export function unoApiRoute(
  options: LinuxRouteOptions & { readonly probe?: () => boolean },
): RouteExecutor {
  const soffice = sofficeBinary(options.soffice ? { binary: options.soffice } : {});
  const python = pythonBinary(options.python ? { python: options.python } : {});
  const timeoutMs = options.timeoutMs ?? 90_000;
  return {
    route: "api",
    available: () =>
      options.probe
        ? options.probe()
        : sofficeVersion({ binary: soffice }) !== null && pythonUnoAvailable({ python }),
    plan: (action) => setCellPlan("api", options.scope, action),
    run(action, approved): RouteRun {
      const doc = approvedDocument(approved);
      if (action.kind !== "calc.set-cell" || doc === null)
        return { ok: false, code: "ROUTE_FAILED" };
      const argv = [
        UNO_API_SCRIPT,
        "--doc",
        doc,
        "--cell",
        action.cell,
        "--value",
        action.value,
        "--soffice",
        soffice,
        "--timeout",
        String(Math.ceil(timeoutMs / 1000)),
      ];
      if (action.save === false) argv.push("--no-save");
      const result = spawnSync(python, argv, { encoding: "utf8", timeout: timeoutMs + 30_000 });
      if (result.error && (result.error as NodeJS.ErrnoException).code === "ETIMEDOUT")
        return { ok: false, code: "ROUTE_TIMEOUT" };
      const last = (result.stdout ?? "").trim().split("\n").pop() ?? "";
      try {
        const report = JSON.parse(last) as { ok?: unknown };
        if (report.ok === true && result.status === 0) return { ok: true };
      } catch {
        // an unreadable report is a failed route
      }
      return { ok: false, code: "ROUTE_FAILED" };
    },
  };
}

/** The GUI route: Calc's input path through the existing actuator. */
export function actuatorGuiRoute(
  options: LinuxRouteOptions & { readonly actuator: Actuator; readonly probe?: () => boolean },
): RouteExecutor {
  return {
    route: "gui",
    available: () => (options.probe ? options.probe() : true),
    plan: (action) => setCellPlan("gui", options.scope, action),
    run(action, approved): RouteRun {
      const doc = approvedDocument(approved);
      if (action.kind !== "calc.set-cell" || doc === null)
        return { ok: false, code: "ROUTE_FAILED" };
      const report = options.actuator.act(doc, action.cell, action.value, action.save !== false);
      return report.ok ? { ok: true } : { ok: false, code: "ROUTE_FAILED" };
    },
  };
}

/**
 * The script route: `doc.export-csv` as a fixed soffice argv, and `shell.run` as the
 * agent's command, which the policy parses (default deny) into the argv this route runs.
 */
export function shellScriptRoute(options: LinuxRouteOptions): RouteExecutor {
  const soffice = sofficeBinary(options.soffice ? { binary: options.soffice } : {});
  const timeoutMs = options.timeoutMs ?? 60_000;
  let exports = 0;
  return {
    route: "script",
    available: () => true,
    plan(action) {
      if (action.kind === "doc.export-csv") {
        exports += 1;
        const outdir = join(options.scope.scratch, `export-${exports}`);
        return {
          route: "script",
          kind: action.kind,
          reads: [],
          writes: [],
          argv: [
            "soffice",
            "--headless",
            "--convert-to",
            "csv",
            "--outdir",
            outdir,
            options.scope.document,
          ],
        };
      }
      if (action.kind === "shell.run")
        return {
          route: "script",
          kind: action.kind,
          reads: [],
          writes: [],
          command: action.command,
        };
      return null;
    },
    run(action, approved): RouteRun {
      const argv = approved.argv;
      if (argv === undefined || argv.length === 0) return { ok: false, code: "ROUTE_FAILED" };
      const [program, ...approvedArgs] = argv as [string, ...string[]];
      const workspace = realpathSync(options.scope.workspace);
      // Nothing this route returns may carry the workspace's host path (either spelling).
      const leaks = (output: string) =>
        output.includes(workspace) || output.includes(options.scope.workspace);
      let args = approvedArgs;
      // soffice: convert into a fresh directory this route creates under the approved output
      // directory, never into the approved directory itself. soffice opens `<outdir>/<doc>.csv`
      // through any symlink already planted at that name; a fresh mkdtemp directory has none.
      let convertDir: string | null = null;
      const outdir = approved.writes[0];
      const source = approved.reads[0];
      if (program === "soffice") {
        if (outdir === undefined || source === undefined || args[4] !== outdir)
          return { ok: false, code: "ROUTE_FAILED" };
        try {
          mkdirSync(outdir, { recursive: true });
          if (realpathSync(outdir) !== outdir) return { ok: false, code: "ROUTE_OUTPUT_ESCAPED" };
          convertDir = mkdtempSync(join(outdir, ".myco-convert-"));
        } catch {
          return { ok: false, code: "ROUTE_FAILED" };
        }
        args = [...args.slice(0, 4), convertDir, ...args.slice(5)];
      }
      const home = mkdtempSync(join(tmpdir(), "myco-fastpath-home-"));
      try {
        const result = spawnSync(program === "soffice" ? soffice : program, args, {
          cwd: workspace,
          encoding: "utf8",
          shell: false,
          timeout: timeoutMs,
          env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, LANG: "C.UTF-8" },
        });
        if (result.error && (result.error as NodeJS.ErrnoException).code === "ETIMEDOUT")
          return { ok: false, code: "ROUTE_TIMEOUT" };
        if (result.status !== 0) return { ok: false, code: "ROUTE_FAILED" };
        if (convertDir === null || outdir === undefined || source === undefined) {
          const stdout = result.stdout ?? "";
          return leaks(stdout)
            ? { ok: false, code: "ROUTE_OUTPUT_LEAK" }
            : { ok: true, output: stdout };
        }
        // soffice exits 0 even when it converts nothing: success is the output file. It must
        // be a regular file with one name, created in the fresh directory (not a link out).
        const name = `${basename(source).replace(/\.[^.]+$/, "")}.csv`;
        const produced = join(convertDir, name);
        if (!existsSync(produced) && !isLink(produced)) return { ok: false, code: "ROUTE_FAILED" };
        const st = lstatSync(produced);
        if (!st.isFile() || st.nlink > 1 || !inside(realpathSync(produced), convertDir))
          return { ok: false, code: "ROUTE_OUTPUT_ESCAPED" };
        const csv = readFileSync(produced, "utf8");
        // Move it into place by rename(2), which replaces a directory entry and never follows
        // a symlink planted at the destination name.
        try {
          renameSync(produced, join(outdir, name));
        } catch {
          return { ok: false, code: "ROUTE_FAILED" };
        }
        if (action.kind !== "doc.export-csv") return { ok: true, output: "converted" };
        return leaks(csv) ? { ok: false, code: "ROUTE_OUTPUT_LEAK" } : { ok: true, output: csv };
      } finally {
        rmSync(home, { recursive: true, force: true });
        if (convertDir !== null) rmSync(convertDir, { recursive: true, force: true });
      }
    },
  };
}
