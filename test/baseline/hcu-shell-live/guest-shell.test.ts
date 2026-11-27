/**
 * TIF-268: the live guest shell over a fake SSH runner, and what the trial loop makes of it.
 * The PowerShell helper itself cannot run here (no guest); its output contract is pinned.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  guestShellCommand,
  parseGuestShellOutput,
  sshGuestShell,
} from "../../../src/baseline/hcu-shell-live/guest-shell.ts";

const SCRATCH = "C:\\myco\\scratch\\k";
const line = (v: unknown) => `${JSON.stringify(v)}\r\n`;

describe("the command line", () => {
  it("carries the op and base64 paths only: nothing a shell could interpret", () => {
    const cmd = guestShellCommand({ shell: "cat", path: "c:/myco/work/k/a b;$(x).txt" }, SCRATCH);
    expect(cmd).not.toMatch(/[;$()`|&<>"']/);
    const parts = cmd.split(" ");
    const b64 = parts[parts.indexOf("-PathB64") + 1] ?? "";
    expect(Buffer.from(b64, "base64").toString("utf8")).toBe("c:/myco/work/k/a b;$(x).txt");
    expect(parts[parts.indexOf("-Op") + 1]).toBe("cat");
  });
  it("matches the helper's declared parameters", () => {
    const ps1 = readFileSync("scripts/guest/hcu-shell.ps1", "utf8");
    for (const p of ["$Op", "$PathB64", "$ScratchB64"]) expect(ps1).toContain(p);
    expect(ps1).toContain("ValidateSet('ls', 'cat', 'sha256', 'convert-csv')");
    expect(ps1).toContain("GetFinalPathNameByHandleW");
  });
});

describe("strict parsing (anything else is unauditable)", () => {
  const ok = { output: "x", accesses: [{ operation: "read", path: "C:\\myco\\work\\k\\t.xlsx" }] };
  it("accepts exactly the documented shape", () =>
    expect(parseGuestShellOutput(line(ok))).toEqual(ok));
  it.each([
    ["no output", ""],
    ["two lines", line(ok) + line(ok)],
    ["not json", "Get-Item : cannot find path\r\n"],
    ["extra key", line({ ...ok, note: 1 })],
    ["no accesses", line({ output: "x", accesses: [] })],
    ["bad op", line({ output: "x", accesses: [{ operation: "exec", path: "C:\\a" }] })],
    ["empty path", line({ output: "x", accesses: [{ operation: "read", path: "" }] })],
    [
      "extra access key",
      line({ output: "x", accesses: [{ operation: "read", path: "C:\\a", z: 1 }] }),
    ],
    ["array", line([ok])],
  ])("rejects %s", (_name, stdout) => expect(parseGuestShellOutput(stdout)).toBeNull());
});

describe("sshGuestShell", () => {
  it("returns the helper's report", async () => {
    const shell = sshGuestShell(
      async () => ({
        stdout: line({ output: "abc", accesses: [{ operation: "read", path: "C:\\d\\t.xlsx" }] }),
        code: 0,
      }),
      SCRATCH,
    );
    expect(await shell.run({ shell: "sha256", path: "c:/d/t.xlsx" })).toEqual({
      output: "abc",
      accesses: [{ operation: "read", path: "C:\\d\\t.xlsx" }],
    });
  });
  it("throws on a non-zero exit or malformed report, so the loop marks the call unaudited", async () => {
    const good = line({ output: "", accesses: [{ operation: "read", path: "C:\\d" }] });
    await expect(
      sshGuestShell(async () => ({ stdout: good, code: 1 }), SCRATCH).run({
        shell: "ls",
        path: "c:/d",
      }),
    ).rejects.toThrow("guest-shell-failed");
    await expect(
      sshGuestShell(async () => ({ stdout: "oops", code: 0 }), SCRATCH).run({
        shell: "ls",
        path: "c:/d",
      }),
    ).rejects.toThrow("guest-shell-malformed");
  });
});
