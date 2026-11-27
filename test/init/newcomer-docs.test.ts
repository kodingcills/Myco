/**
 * Newcomer path, static drift (TIF-265 track D). Runs on every PR, no clone, no process:
 * what README.md, docs/product/setup.md and docs/product/linux-path.md tell a newcomer to
 * type must agree with what `myco init` accepts and does, with each other, and with the
 * `newcomer path (ubuntu-latest)` CI job that runs those commands for real
 * (newcomer-path.test.ts).
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { DEMO_TASK } from "../../src/linux/run.ts";
import { InitUsageError, LINUX_INSTALL, parseInitArgs } from "../../src/setup/init.ts";
import {
  documentedSteps,
  initArgv,
  jobBlock,
  markedBlock,
  markerNames,
  missingFrom,
  normalise,
  stepHeaders,
  stripComment,
  substitute,
} from "./newcomer-lib.ts";

const REPO = resolve(import.meta.dirname, "..", "..");
const read = (p: string) => readFileSync(join(REPO, p), "utf8");
const README = read("README.md");
const SETUP = read("docs/product/setup.md");
const LINUX = read("docs/product/linux-path.md");
const CI = read(".github/workflows/ci.yml");
const INIT_SRC = read("src/setup/init.ts");
const JOB = "newcomer path (ubuntu-latest)";

/** Every block the live run executes, and the document it lives in. */
const BLOCKS = [
  { doc: "docs/product/linux-path.md", text: LINUX, name: "clone" },
  { doc: "docs/product/setup.md", text: SETUP, name: "setup" },
  { doc: "README.md", text: README, name: "readme-quickstart" },
  { doc: "docs/product/setup.md", text: SETUP, name: "linux" },
] as const;

const P = { myco: "/m", project: "/p" };

describe("newcomer-lib", () => {
  const doc = [
    "intro",
    "<!-- newcomer-path: demo -->",
    "```sh",
    "pnpm install --frozen-lockfile   # once (see #513)",
    "",
    "# a whole-line comment",
    "/path/to/Myco/bin/myco init --dry-run",
    "```",
  ].join("\n");

  it("extracts the marked block's commands, comments and blank lines dropped", () => {
    expect(markedBlock(doc, "demo")).toEqual([
      "pnpm install --frozen-lockfile",
      "/path/to/Myco/bin/myco init --dry-run",
    ]);
    expect(markerNames(doc)).toEqual(["demo"]);
  });

  it("fails on a missing, duplicated, detached, empty or unclosed block", () => {
    expect(() => markedBlock(doc, "other")).toThrow(/found 0/);
    expect(() => markedBlock(`${doc}\n${doc}`, "demo")).toThrow(/found 2/);
    expect(() => markedBlock(doc.replace("-->\n```sh", "-->\n\n```sh"), "demo")).toThrow(
      /followed directly/,
    );
    expect(() => markedBlock("<!-- newcomer-path: e -->\n```sh\n# only\n```", "e")).toThrow(
      /no command/,
    );
    expect(() => markedBlock(doc.slice(0, doc.lastIndexOf("```")), "demo")).toThrow(/not closed/);
  });

  it("fills only the documented placeholders; any other /path/to/ is drift", () => {
    expect(substitute("/path/to/Myco/bin/myco init --project /path/to/your/project", P)).toBe(
      "/m/bin/myco init --project /p",
    );
    expect(() => substitute("cd /path/to/evidence", P)).toThrow(/undocumented placeholder/);
  });

  it("finds init's argv, compares commands and reads step headers and rows", () => {
    expect(initArgv("/m/bin/myco init --dry-run")).toEqual(["--dry-run"]);
    expect(initArgv("pnpm myco init --task x")).toEqual(["--task", "x"]);
    expect(initArgv("pnpm install")).toBeNull();
    expect(stripComment("a b   # c # d")).toBe("a b");
    expect(normalise(" a   b ")).toBe("a b");
    expect(missingFrom(["a  b", "c"], ["a b"])).toEqual(["c"]);
    expect(stepHeaders("x\n[1/4] gate launcher\n[2/4] two (planned)\n")).toEqual([
      { n: 1, total: 4, title: "gate launcher" },
      { n: 2, total: 4, title: "two (planned)" },
    ]);
    expect(documentedSteps("| Step |\n| 1. gate launcher | x |\n")).toEqual([
      { n: 1, title: "gate launcher" },
    ]);
  });

  it("cuts one job out of a workflow", () => {
    const wf = "jobs:\n  a:\n    name: A\n    run: x\n  b:\n    name: B\n    run: y\n";
    expect(jobBlock(wf, "A")).toBe("  a:\n    name: A\n    run: x");
    expect(jobBlock(wf, "B")).toBe("  b:\n    name: B\n    run: y\n");
    expect(() => jobBlock(wf, "C")).toThrow(/no job/);
  });
});

describe("newcomer path: the docs agree with init, with each other and with CI", () => {
  it("every marked block exists, has commands and uses only the documented placeholders", () => {
    for (const b of BLOCKS) {
      const commands = markedBlock(b.text, b.name);
      expect(commands.length, `${b.doc} ${b.name}`).toBeGreaterThan(0);
      for (const c of commands) expect(() => substitute(c, P), `${b.doc}: ${c}`).not.toThrow();
    }
    // No marker the live run would silently ignore.
    expect(markerNames(README)).toEqual(["readme-quickstart"]);
    expect(markerNames(SETUP)).toEqual(["setup", "linux"]);
    expect(markerNames(LINUX)).toEqual(["clone"]);
  });

  it("every documented `myco init` line parses as init flags (no usage error)", () => {
    const fromReadme = README.split("\n")
      .filter((l) => l.includes("bin/myco init"))
      .map(stripComment)
      .filter((l) => l.startsWith("/path/to/Myco/bin/myco init"));
    const lines = [...BLOCKS.flatMap((b) => markedBlock(b.text, b.name)), ...fromReadme];
    const inits = lines.map((c) => initArgv(substitute(c, P))).filter((a) => a !== null);
    // setup: 2, readme quickstart: 2, linux: 1, plus the README "Getting started" line.
    expect(inits.length).toBeGreaterThanOrEqual(6);
    for (const argv of inits) {
      let parsed: unknown;
      try {
        parsed = parseInitArgs(argv, P.project);
      } catch (e) {
        if (e instanceof InitUsageError) throw new Error(`${argv.join(" ")}: ${e.message}`);
        throw e;
      }
      expect(parsed, argv.join(" ")).not.toBe("help");
    }
  });

  it("the README quickstart is a subset of setup.md's block", () => {
    expect(
      missingFrom(markedBlock(README, "readme-quickstart"), markedBlock(SETUP, "setup")),
    ).toEqual([]);
  });

  it("the clone block clones this repo and checks the Linux path from the checkout", () => {
    const clone = markedBlock(LINUX, "clone");
    expect(clone[0]).toBe("git clone https://github.com/kodingcills/Myco.git myco");
    expect(clone).toContain("cd myco");
    expect(clone).toContain("pnpm install --frozen-lockfile");
    expect(clone).toContain("pnpm myco-linux --check");
  });

  it("one LibreOffice install line: init, setup.md, linux-path.md and the CI job", () => {
    expect(LINUX_INSTALL).toBe(
      "sudo apt-get install -y --no-install-recommends libreoffice-calc python3-uno",
    );
    expect(SETUP).toContain(`(\`${LINUX_INSTALL}\`)`);
    expect(LINUX.split("\n")).toContain(LINUX_INSTALL);
    const job = jobBlock(CI, JOB);
    const installs = job.split("\n").filter((l) => l.includes("apt-get install"));
    expect(installs.map((l) => l.trim())).toEqual([`run: sudo apt-get update && ${LINUX_INSTALL}`]);
  });

  it("Node and pnpm versions agree: package.json, README, linux-path.md and the CI job", () => {
    const pkg = JSON.parse(read("package.json")) as { engines: { node: string } };
    expect(pkg.engines.node).toBe(">=24");
    expect(README).toContain("Needs Node ≥ 24 and pnpm 10");
    expect(LINUX).toContain("Node 24 or later, pnpm 10.");
    const job = jobBlock(CI, JOB);
    expect(job).toMatch(/^\s+node-version: 24$/m);
    expect(job).toMatch(/^\s+run: npm install -g pnpm@10$/m);
  });

  it("setup.md's step table matches the step headers init prints", () => {
    const rows = documentedSteps(SETUP);
    expect(rows.map((r) => r.n)).toEqual([1, 2, 3, 4]);
    for (const r of rows) {
      // init.ts prints `\n[n/4] <title>...`; the documented title is the header's start.
      expect(INIT_SRC, `step ${r.n}`).toContain(`[${r.n}/4] ${r.title}`);
    }
  });

  it("the shipped Linux task file is the Linux demo task the linux block binds", () => {
    const file = JSON.parse(read("examples/linux-path/tasks.json")) as {
      tasks: { id: string; family: string; stateFile: string; spec: unknown }[];
    };
    expect(file.tasks).toHaveLength(1);
    const [task] = file.tasks;
    expect(task?.family).toBe("calc-record-edit");
    expect(task?.stateFile).toBe("saved.csv");
    expect(task?.spec).toEqual({ ...DEMO_TASK });
    const [linux] = markedBlock(SETUP, "linux");
    const argv = initArgv(substitute(linux as string, P)) as string[];
    const opts = parseInitArgs(argv, P.project);
    expect(opts).not.toBe("help");
    if (opts === "help") return;
    expect(opts.task).toBe(task?.id);
    expect(normalise(argv.join(" "))).toContain(`--tasks ${P.myco}/examples/linux-path/tasks.json`);
  });

  it("the CI job runs the live newcomer test, required (never a silent skip)", () => {
    const job = jobBlock(CI, JOB);
    expect(job).toContain('MYCO_NEWCOMER_PATH_REQUIRED: "1"');
    expect(job).toContain("run: pnpm exec vitest run test/init/newcomer-path.test.ts");
    expect(job).toContain("timeout-minutes:");
  });
});
