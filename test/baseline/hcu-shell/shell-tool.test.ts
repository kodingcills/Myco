/**
 * TIF-268: the hcu+shell arm's shell-tool boundary.
 *
 * Every refusal here is a way an agent with a shell could reach the grader's ground truth
 * (TIF-266, verdict integrity) or make the boundary ambiguous. Each test names the escape.
 */
import { describe, expect, it } from "vitest";
import {
  canonicalPath,
  checkResolvedAccesses,
  checkShellRequest,
  createShellPolicy,
} from "../../../src/baseline/hcu-shell/shell-tool.ts";
import { DOC, DOC_DIR, GROUND_TRUTH_FILE, JUDGE_DIR, SCRATCH } from "./fake-calc.ts";

const policy = createShellPolicy({
  style: "windows",
  documentPath: DOC,
  documentDir: DOC_DIR,
  scratchDir: SCRATCH,
  groundTruthDirs: [JUDGE_DIR],
});

const code = (request: unknown) => {
  const result = checkShellRequest(request, policy);
  return result.ok ? "ok" : result.code;
};

describe("allowed self-checks", () => {
  it.each([
    [{ shell: "ls", path: DOC_DIR }],
    [{ shell: "cat", path: `${DOC_DIR}/notes.txt` }],
    [{ shell: "sha256", path: DOC }],
    [{ shell: "convert-csv", path: DOC }],
    [{ shell: "cat", path: `${SCRATCH}/task.csv` }],
    // Windows spellings of the same path: backslashes and upper case.
    [{ shell: "sha256", path: "C:\\MYCO\\WORK\\TASK.XLSX" }],
  ])("allows %j", (request) => expect(code(request)).toBe("ok"));

  it("hands back the canonical path, so the guest runs exactly what was checked", () => {
    const result = checkShellRequest(
      { shell: "sha256", path: "C:\\MYCO\\WORK\\TASK.XLSX" },
      policy,
    );
    expect(result).toEqual({ ok: true, request: { shell: "sha256", path: DOC } });
  });

  it("does not deny a name that merely contains a ground-truth word", () =>
    expect(code({ shell: "cat", path: `${DOC_DIR}/unexpected-judgement.txt` })).toBe("ok"));
});

describe("ground truth is unreachable", () => {
  it.each([
    ["the judge's directory", { shell: "ls", path: JUDGE_DIR }, "ground-truth"],
    ["the ground-truth file", { shell: "cat", path: GROUND_TRUTH_FILE }, "ground-truth"],
    [
      "the judge's directory, case-folded",
      { shell: "cat", path: "C:/MYCO-HOST/JUDGE/expected.json" },
      "ground-truth",
    ],
    ["a parent of the judge's directory", { shell: "ls", path: "c:/myco-host" }, "ground-truth"],
    [
      "an oracle copy inside a read root",
      { shell: "cat", path: `${SCRATCH}/oracles/calc.ts` },
      "ground-truth",
    ],
    [
      "an expected/ dir inside a read root",
      { shell: "ls", path: `${DOC_DIR}/expected` },
      "ground-truth",
    ],
    [
      "a run ledger inside a read root",
      { shell: "cat", path: `${SCRATCH}/ledger.jsonl` },
      "ground-truth",
    ],
    [
      "the pinned task manifest",
      { shell: "cat", path: `${DOC_DIR}/sweep-v3.json` },
      "ground-truth",
    ],
    ["a run directory", { shell: "ls", path: `${SCRATCH}/myco-runs` }, "ground-truth"],
    ["the secrets directory", { shell: "ls", path: "c:/users/me/.myco" }, "ground-truth"],
  ])("refuses %s", (_name, request, expected) => expect(code(request)).toBe(expected));
});

describe("ambiguous or escaping paths are refused, not resolved", () => {
  it.each([
    ["parent traversal", `${DOC_DIR}/../../myco-host/judge/expected.json`, "dot-segment"],
    ["parent traversal that stays inside", `${DOC_DIR}/../work/task.xlsx`, "dot-segment"],
    ["a dot segment", `${DOC_DIR}/./task.xlsx`, "dot-segment"],
    ["a relative path", "task.xlsx", "relative-path"],
    ["a drive-relative path", "c:task.xlsx", "relative-path"],
    ["a UNC path", "\\\\host\\share\\expected.json", "bad-path"],
    ["a device path", "\\\\?\\C:\\myco\\work\\task.xlsx", "bad-path"],
    ["an alternate data stream", `${DOC}:hidden`, "bad-path"],
    ["a trailing dot (Windows strips it)", `${DOC_DIR}/task.xlsx.`, "bad-path"],
    ["a trailing space", `${DOC_DIR}/task.xlsx `, "bad-path"],
    ["an 8.3 short name", "c:/myco-h~1/judge/expected.json", "bad-path"],
    ["a wildcard", `${DOC_DIR}/*`, "bad-path"],
    ["a variable", "$env:USERPROFILE/x", "bad-path"],
    ["a cmd variable", "%TEMP%/x", "bad-path"],
    ["command chaining", `${DOC}; type c:/myco-host/judge/expected.json`, "bad-path"],
    ["a pipe", `${DOC} | more`, "bad-path"],
    ["command substitution", "c:/myco/work/`whoami`", "bad-path"],
    ["a newline", `${DOC}\ncat x`, "bad-path"],
    ["an empty segment", "c:/myco//work/task.xlsx", "bad-path"],
    ["an empty path", "", "bad-path"],
    ["a non-string path", 7, "bad-path"],
  ])("refuses %s", (_name, path, expected) => expect(code({ shell: "cat", path })).toBe(expected));

  it("refuses anything outside the document and scratch directories", () => {
    expect(code({ shell: "cat", path: "c:/windows/win.ini" })).toBe("outside-roots");
    expect(code({ shell: "ls", path: "c:/myco" })).toBe("outside-roots");
    // A sibling whose name starts with a root's name is not inside it.
    expect(code({ shell: "ls", path: "c:/myco/work-old" })).toBe("outside-roots");
  });
});

describe("request shape", () => {
  it.each([
    ["an unknown op", { shell: "rm", path: DOC }, "unknown-op"],
    ["an exec op", { shell: "exec", path: DOC }, "unknown-op"],
    ["an extra argument", { shell: "cat", path: DOC, args: ["-n"] }, "malformed"],
    ["a missing path", { shell: "ls" }, "malformed"],
    ["a string", "cat c:/myco/work/task.xlsx", "malformed"],
    ["null", null, "malformed"],
    ["an array", ["cat", DOC], "malformed"],
  ])("refuses %s", (_name, request, expected) => expect(code(request)).toBe(expected));

  it("lets convert-csv read only the task document", () => {
    expect(code({ shell: "convert-csv", path: `${DOC_DIR}/other.xlsx` })).toBe("not-the-document");
    expect(code({ shell: "convert-csv", path: `${SCRATCH}/task.csv` })).toBe("not-the-document");
  });
});

describe("resolved accesses are held to the same boundary", () => {
  it("accepts reads inside the roots and writes in scratch", () =>
    expect(
      checkResolvedAccesses(
        [
          { operation: "read", path: DOC },
          { operation: "write", path: `${SCRATCH}/task.csv` },
        ],
        policy,
      ),
    ).toEqual([]));

  it("catches a link that resolved into the judge's directory", () =>
    expect(
      checkResolvedAccesses([{ operation: "read", path: GROUND_TRUTH_FILE }], policy).map(
        (v) => v.code,
      ),
    ).toEqual(["ground-truth"]));

  it("catches a resolved read outside the roots", () =>
    expect(
      checkResolvedAccesses([{ operation: "read", path: "c:/windows/win.ini" }], policy).map(
        (v) => v.code,
      ),
    ).toEqual(["outside-roots"]));

  it("catches a write to the document (a file-I/O shortcut)", () =>
    expect(
      checkResolvedAccesses([{ operation: "write", path: DOC }], policy).map((v) => v.code),
    ).toEqual(["write-outside-scratch"]));

  it("catches an operation it does not know", () =>
    expect(
      checkResolvedAccesses([{ operation: "exec" as unknown as "read", path: DOC }], policy).map(
        (v) => v.code,
      ),
    ).toEqual(["malformed"]));
});

describe("a policy that could not be enforced is refused", () => {
  const base = {
    style: "windows" as const,
    documentPath: DOC,
    documentDir: DOC_DIR,
    scratchDir: SCRATCH,
    groundTruthDirs: [JUDGE_DIR],
  };
  it.each([
    ["ground truth inside the document dir", { groundTruthDirs: [`${DOC_DIR}/answers`] }],
    ["ground truth containing the scratch dir", { groundTruthDirs: ["c:/myco"] }],
    ["the scratch dir equal to ground truth", { scratchDir: JUDGE_DIR }],
    ["no ground-truth directory named", { groundTruthDirs: [] }],
    ["a document outside its directory", { documentPath: "c:/elsewhere/task.xlsx" }],
    ["the document dir itself as the document", { documentPath: DOC_DIR }],
    ["a read root named like grader material", { scratchDir: "c:/myco/runs/scratch" }],
    ["a non-canonical root", { scratchDir: "c:/myco/../scratch" }],
  ])("refuses %s", (_name, override) =>
    expect(() => createShellPolicy({ ...base, ...override })).toThrow(/shell policy/),
  );

  it("supports POSIX guests (the M2-06 Linux path)", () => {
    const posix = createShellPolicy({
      style: "posix",
      documentPath: "/home/agent/work/task.xlsx",
      documentDir: "/home/agent/work",
      scratchDir: "/tmp/agent-scratch",
      groundTruthDirs: ["/srv/judge"],
    });
    expect(
      checkShellRequest({ shell: "cat", path: "/srv/judge/expected.json" }, posix),
    ).toMatchObject({
      ok: false,
      code: "ground-truth",
    });
    expect(
      checkShellRequest({ shell: "convert-csv", path: "/home/agent/work/task.xlsx" }, posix).ok,
    ).toBe(true);
    expect(canonicalPath("C:/x", "posix")).toEqual({ ok: false, code: "relative-path" });
  });
});
