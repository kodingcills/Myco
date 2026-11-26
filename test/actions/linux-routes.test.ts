/**
 * Track J: the Linux routes' own checks, hermetically (fake python, fake soffice, fake
 * actuator; no LibreOffice). A route's success is read from what it produced, never assumed.
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { actuatorGuiRoute, shellScriptRoute, unoApiRoute } from "../../src/actions/linux-routes.ts";
import { type WorkspaceScope, workspacePolicy } from "../../src/actions/policy.ts";
import { createActionRouter } from "../../src/actions/router.ts";
import type { Actuator } from "../../src/linux/actuator.ts";

let root: string;
let scope: WorkspaceScope;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "myco-routes-"));
  const ws = join(root, "trials", "run-a");
  mkdirSync(join(ws, "doc"), { recursive: true });
  mkdirSync(join(ws, "scratch"));
  writeFileSync(join(ws, "doc", "doc.xlsx"), "x");
  scope = { workspace: ws, document: join(ws, "doc", "doc.xlsx"), scratch: join(ws, "scratch") };
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** An executable shell script standing in for python or soffice. */
function fakeBin(name: string, body: string): string {
  const path = join(root, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

const SET = { kind: "calc.set-cell", cell: "B2", value: "v" } as const;

describe("api route", () => {
  const act = (python: string) =>
    createActionRouter({
      policy: workspacePolicy(scope),
      executors: [unoApiRoute({ scope, python, probe: () => true })],
    }).act(SET);

  it("ok only when the script reports ok AND exits 0", () => {
    expect(act(fakeBin("py-ok", `echo '{"ok": true}'`))).toMatchObject({ ok: true, route: "api" });
  });

  it.each([
    ["reports ok: false", `echo '{"ok": false}'`],
    ["reports ok but exits 1", `echo '{"ok": true}'; exit 1`],
    ["reports ok as a string", `echo '{"ok": "true"}'`],
    ["prints no report", "exit 0"],
    ["prints garbage", "echo done"],
  ])("a script that %s is a failed route", (_what, body) => {
    expect(act(fakeBin("py", body))).toEqual({ ok: false, code: "ALL_ROUTES_FAILED", route: null });
  });

  it("is passed the policy-resolved document and --no-save when asked", () => {
    const log = join(root, "args.txt");
    const py = fakeBin("py-args", `echo "$@" > ${log}; echo '{"ok": true}'`);
    createActionRouter({
      policy: workspacePolicy(scope),
      executors: [unoApiRoute({ scope, python: py, probe: () => true })],
    }).act({ ...SET, save: false });
    const args = readFileSync(log, "utf8");
    expect(args).toContain(`--doc ${scope.document} `);
    expect(args).toContain("--cell B2 --value v");
    expect(args.trim().endsWith("--no-save")).toBe(true);
  });
});

describe("gui route", () => {
  it("returns the actuator's failure, and passes the resolved document and save flag", () => {
    const calls: unknown[] = [];
    const actuator = (ok: boolean): Actuator => ({
      act: (doc, cell, value, save) => {
        calls.push({ doc, cell, value, save });
        return { ok };
      },
    });
    const router = (ok: boolean) =>
      createActionRouter({
        policy: workspacePolicy(scope),
        executors: [actuatorGuiRoute({ scope, actuator: actuator(ok) })],
      });
    expect(router(true).act(SET)).toMatchObject({ ok: true, route: "gui" });
    expect(router(false).act({ ...SET, save: false })).toMatchObject({
      ok: false,
      code: "ALL_ROUTES_FAILED",
    });
    expect(calls).toEqual([
      { doc: scope.document, cell: "B2", value: "v", save: true },
      { doc: scope.document, cell: "B2", value: "v", save: false },
    ]);
  });
});

describe("script route", () => {
  const exportWith = (soffice: string) =>
    createActionRouter({
      policy: workspacePolicy(scope),
      executors: [shellScriptRoute({ scope, soffice })],
    }).act({ kind: "doc.export-csv" });

  // Args: --headless --convert-to csv --outdir OUT DOC
  it("returns the CSV soffice produced in the approved output directory", () => {
    const soffice = fakeBin(
      "soffice-ok",
      'mkdir -p "$5"; printf "id,name\\nE1,$HOME\\n" > "$5/doc.csv"',
    );
    const result = exportWith(soffice);
    expect(result).toMatchObject({ ok: true, route: "script" });
    // HOME is a throwaway directory outside the workspace, never the workspace itself.
    const home = (result.output ?? "").split("\n")[1]?.split(",")[1] ?? "";
    expect(home).toMatch(/myco-fastpath-home-/);
    expect(home.startsWith(scope.workspace)).toBe(false);
  });

  it("soffice exiting 0 without producing the file is a failed route", () => {
    expect(exportWith(fakeBin("soffice-none", "exit 0"))).toMatchObject({
      ok: false,
      code: "ALL_ROUTES_FAILED",
    });
  });

  it("a non-zero exit is a failed route", () => {
    expect(
      exportWith(fakeBin("soffice-err", 'mkdir -p "$5"; echo x > "$5/doc.csv"; exit 3')),
    ).toMatchObject({ ok: false });
  });

  it("a produced file that resolves outside the output directory is refused", () => {
    const outside = join(root, "outside.csv");
    writeFileSync(outside, "MARKER-OUTSIDE\n");
    const router = createActionRouter({
      policy: workspacePolicy(scope),
      executors: [
        shellScriptRoute({
          scope,
          soffice: fakeBin("soffice-link", `mkdir -p "$5"; ln -s ${outside} "$5/doc.csv"`),
        }),
      ],
    });
    const result = router.act({ kind: "doc.export-csv" });
    expect(result).toMatchObject({ ok: false, code: "ALL_ROUTES_FAILED" });
    expect(router.log()[0]?.attempts[0]?.code).toBe("ROUTE_OUTPUT_ESCAPED");
    expect(JSON.stringify(result)).not.toContain("MARKER-OUTSIDE");
  });

  it("runs in the workspace with no shell: the checked argv, verbatim", () => {
    writeFileSync(join(scope.scratch, "a b.txt"), "spaced\n");
    const router = createActionRouter({
      policy: workspacePolicy(scope),
      executors: [shellScriptRoute({ scope })],
    });
    expect(router.act({ kind: "shell.run", command: "cat 'scratch/a b.txt'" }).output).toBe(
      "spaced\n",
    );
  });
});
