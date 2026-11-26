/**
 * Track J: the Linux routes' own checks, hermetically (fake python, fake soffice, fake
 * actuator; no LibreOffice). A route's success is read from what it produced, never assumed.
 */
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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
    // The policy resolves symlinks in the workspace's own path (macOS: /var -> /private/var).
    expect(args).toContain(`--doc ${realpathSync(scope.document)} `);
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
    const doc = realpathSync(scope.document);
    expect(calls).toEqual([
      { doc, cell: "B2", value: "v", save: true },
      { doc, cell: "B2", value: "v", save: false },
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

  it("the program's environment is exactly PATH, HOME and LANG (no harness variable)", () => {
    // Names only (never values): the fake soffice writes its environment's variable names
    // as the "CSV". `/bin/sh` itself adds its own bookkeeping names, which differ by
    // platform (dash: PWD; macOS bash: PWD, SHLVL, _), so those are set aside; everything
    // else must be exactly the three the route passes. A harness variable never arrives.
    const soffice = fakeBin(
      "soffice-env",
      'mkdir -p "$5"; /usr/bin/env | cut -d= -f1 | sort > "$5/doc.csv"',
    );
    const SHELL_ADDED = new Set(["PWD", "OLDPWD", "SHLVL", "_"]);
    process.env.MYCO_TEST_HARNESS_SENTINEL = "1";
    try {
      const result = exportWith(soffice);
      expect(result).toMatchObject({ ok: true, route: "script" });
      const names = (result.output ?? "").split("\n").filter((n) => n !== "");
      expect(names).not.toContain("MYCO_TEST_HARNESS_SENTINEL");
      expect(names.filter((n) => !SHELL_ADDED.has(n))).toEqual(["HOME", "LANG", "PATH"]);
    } finally {
      delete process.env.MYCO_TEST_HARNESS_SENTINEL;
    }
  });

  it("only stdout comes back from a shell.run program; stderr never does", () => {
    const bin = join(root, "fakebin");
    mkdirSync(bin);
    writeFileSync(join(bin, "cat"), "#!/bin/sh\necho STDOUT-OK\necho STDERR-MARKER-9 >&2\n");
    chmodSync(join(bin, "cat"), 0o755);
    writeFileSync(join(scope.scratch, "x.txt"), "x\n");
    const saved = process.env.PATH;
    process.env.PATH = `${bin}:${saved ?? "/usr/bin:/bin"}`;
    try {
      const router = createActionRouter({
        policy: workspacePolicy(scope),
        executors: [shellScriptRoute({ scope })],
      });
      const result = router.act({ kind: "shell.run", command: "cat scratch/x.txt" });
      expect(result).toMatchObject({ ok: true, route: "script", output: "STDOUT-OK\n" });
      expect(JSON.stringify([result, router.log()])).not.toContain("STDERR-MARKER-9");
    } finally {
      process.env.PATH = saved;
    }
  });

  it("soffice receives the resolved absolute document, never the agent's spelling", () => {
    const log = join(root, "soffice-args.txt");
    const soffice = fakeBin(
      "soffice-args",
      `echo "$@" > ${log}; mkdir -p "$5"; echo a > "$5/doc.csv"`,
    );
    const router = createActionRouter({
      policy: workspacePolicy(scope),
      executors: [shellScriptRoute({ scope, soffice })],
    });
    expect(
      router.act({
        kind: "shell.run",
        command: "soffice --headless --convert-to csv --outdir scratch/o ./doc/../doc/doc.xlsx",
      }),
    ).toMatchObject({ ok: true, output: "converted" });
    const ws = realpathSync(scope.workspace);
    // The outdir soffice sees is a fresh directory the route made under the approved one.
    const parts = readFileSync(log, "utf8").trim().split(" ");
    expect(parts.slice(0, 4).join(" ")).toBe("--headless --convert-to csv --outdir");
    expect(parts[4]?.startsWith(`${ws}/scratch/o/.myco-convert-`)).toBe(true);
    expect(parts[5]).toBe(`${ws}/doc/doc.xlsx`);
    expect(parts).toHaveLength(6);
    expect(readFileSync(join(ws, "scratch", "o", "doc.csv"), "utf8")).toBe("a\n");
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

  // F2 (round 1 verdict on #544): each produced-file guard, alone. Every case below gets past
  // the other two guards, so removing the one it names makes it pass.
  describe("each produced-file guard refuses on its own", () => {
    const escaped = (body: string) => {
      const router = createActionRouter({
        policy: workspacePolicy(scope),
        executors: [shellScriptRoute({ scope, soffice: fakeBin("soffice-guard", body) })],
      });
      const result = router.act({ kind: "doc.export-csv" });
      return { result, code: router.log()[0]?.attempts[0]?.code, log: router.log() };
    };

    it("a hard link to an outside file (one regular file, inside, but two names: nlink)", () => {
      const outside = join(root, "outside-hard.csv");
      writeFileSync(outside, "MARKER-HARDLINK\n");
      const { result, code, log } = escaped(`mkdir -p "$5"; ln ${outside} "$5/doc.csv"`);
      expect(result).toMatchObject({ ok: false, code: "ALL_ROUTES_FAILED" });
      expect(code).toBe("ROUTE_OUTPUT_ESCAPED");
      expect(JSON.stringify([result, log])).not.toContain("MARKER-HARDLINK");
      // Never moved into the workspace either.
      expect(readdirSync(join(scope.scratch, "export-1"))).toEqual([]);
      expect(lstatSync(outside).nlink).toBe(1);
    });

    it("a symlink to a file inside the fresh directory (one name, inside, not a file: isFile)", () => {
      const { result, code, log } = escaped(
        'mkdir -p "$5"; printf "MARKER-INNER-LINK\\n" > "$5/real.csv"; ln -s real.csv "$5/doc.csv"',
      );
      expect(result).toMatchObject({ ok: false, code: "ALL_ROUTES_FAILED" });
      expect(code).toBe("ROUTE_OUTPUT_ESCAPED");
      expect(JSON.stringify([result, log])).not.toContain("MARKER-INNER-LINK");
      expect(readdirSync(join(scope.scratch, "export-1"))).toEqual([]);
    });

    it("the fresh directory swapped for a link out (a regular file, one name, outside: inside)", () => {
      const away = join(root, "away");
      mkdirSync(away);
      writeFileSync(join(away, "doc.csv"), "MARKER-AWAY\n");
      const { result, code, log } = escaped(`mv "$5" "$5.moved"; ln -s ${away} "$5"`);
      expect(result).toMatchObject({ ok: false, code: "ALL_ROUTES_FAILED" });
      expect(code).toBe("ROUTE_OUTPUT_ESCAPED");
      expect(JSON.stringify([result, log])).not.toContain("MARKER-AWAY");
      // The outside file stays where it was; nothing named doc.csv lands in the workspace.
      expect(readFileSync(join(away, "doc.csv"), "utf8")).toBe("MARKER-AWAY\n");
      expect(readdirSync(join(scope.scratch, "export-1"))).not.toContain("doc.csv");
    });

    it("a directory at the output name is refused", () => {
      const { result, code } = escaped('mkdir -p "$5/doc.csv"');
      expect(result).toMatchObject({ ok: false, code: "ALL_ROUTES_FAILED" });
      expect(code).toBe("ROUTE_OUTPUT_ESCAPED");
    });
  });

  it.each([
    ["the resolved spelling (the route's cwd)", () => '"$PWD"'],
    ["the given spelling", () => `"${scope.workspace}"`],
  ])("an exported CSV whose cells carry the workspace path (%s) is ROUTE_OUTPUT_LEAK", (_w, at) => {
    const router = createActionRouter({
      policy: workspacePolicy(scope),
      executors: [
        shellScriptRoute({
          scope,
          soffice: fakeBin(
            "soffice-leak",
            `mkdir -p "$5"; printf "p\\n%s\\n" ${at()} > "$5/doc.csv"`,
          ),
        }),
      ],
    });
    const result = router.act({ kind: "doc.export-csv" });
    expect(result).toMatchObject({ ok: false, code: "ALL_ROUTES_FAILED" });
    expect(router.log()[0]?.attempts[0]?.code).toBe("ROUTE_OUTPUT_LEAK");
    const seen = JSON.stringify([result, router.log()]);
    expect(seen).not.toContain(realpathSync(scope.workspace));
    expect(seen).not.toContain(scope.workspace);
  });

  // Defensive checks the policy makes unreachable through the router, driven directly.
  describe("direct executor calls: checks the policy normally makes unreachable", () => {
    const direct = (soffice: string, outdir: string, argOutdir: string) => {
      const ws = realpathSync(scope.workspace);
      const doc = join(ws, "doc", "doc.xlsx");
      return shellScriptRoute({ scope, soffice }).run(
        { kind: "doc.export-csv" },
        {
          request: { route: "script", kind: "doc.export-csv", reads: [], writes: [] },
          reads: [doc],
          writes: [outdir],
          argv: ["soffice", "--headless", "--convert-to", "csv", "--outdir", argOutdir, doc],
        },
      );
    };

    it("an argv outdir that is not the approved write is refused before soffice runs", () => {
      const ws = realpathSync(scope.workspace);
      const ran = join(root, "ran");
      const soffice = fakeBin("soffice-ran", `touch ${ran}; mkdir -p "$5"; echo a > "$5/doc.csv"`);
      expect(direct(soffice, join(ws, "scratch", "o"), join(ws, "scratch", "p"))).toEqual({
        ok: false,
        code: "ROUTE_FAILED",
      });
      expect(() => lstatSync(ran)).toThrow();
    });

    it("an approved outdir that no longer resolves to itself is ROUTE_OUTPUT_ESCAPED", () => {
      const ws = realpathSync(scope.workspace);
      const away = join(root, "away-dir");
      mkdirSync(away);
      const swapped = join(ws, "scratch", "swapped");
      symlinkSync(away, swapped);
      // Refused before soffice runs: nothing is ever created through the swapped link.
      const ran = join(root, "ran-swapped");
      const soffice = fakeBin("soffice-swap", `touch ${ran}; mkdir -p "$5"; echo a > "$5/doc.csv"`);
      expect(direct(soffice, swapped, swapped)).toEqual({
        ok: false,
        code: "ROUTE_OUTPUT_ESCAPED",
      });
      expect(() => lstatSync(ran)).toThrow();
      expect(readdirSync(away)).toEqual([]);
    });
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
  // D2 (round 3 verdict on #539): soffice opens `<outdir>/<doc>.csv` through a symlink
  // already planted at that name. The fake below writes with a shell redirect, which follows
  // links exactly as soffice does.
  describe("a symlink planted at the output name is never written through", () => {
    const VICTIM = "VICTIM-ORIGINAL\n";
    const writer = () =>
      fakeBin("soffice-writes", 'mkdir -p "$5"; printf "a,b\\n1,2\\n" > "$5/doc.csv"');

    it.each([
      [
        "shell.run soffice --outdir scratch",
        "scratch",
        {
          kind: "shell.run",
          command: "soffice --headless --convert-to csv --outdir scratch doc/doc.xlsx",
        },
      ],
      ["doc.export-csv", "scratch/export-1", { kind: "doc.export-csv" }],
    ] as const)("%s", (_what, outRel, action) => {
      const victim = join(root, "victim.csv");
      writeFileSync(victim, VICTIM);
      mkdirSync(join(scope.workspace, outRel), { recursive: true });
      const planted = join(scope.workspace, outRel, "doc.csv");
      symlinkSync(victim, planted);
      const result = createActionRouter({
        policy: workspacePolicy(scope),
        executors: [shellScriptRoute({ scope, soffice: writer() })],
      }).act(action);
      expect(readFileSync(victim, "utf8")).toBe(VICTIM);
      expect(result).toMatchObject({ ok: true, route: "script" });
      // The export replaced the planted link with a regular file inside the workspace.
      expect(lstatSync(planted).isSymbolicLink()).toBe(false);
      expect(readFileSync(planted, "utf8")).toBe("a,b\n1,2\n");
      // No conversion directory is left behind.
      expect(
        readdirSync(join(scope.workspace, outRel)).filter((n) => n.startsWith(".myco-")),
      ).toEqual([]);
    });
  });
});
