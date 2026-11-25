/**
 * Row-8 H5: run-live's token source. `--token-file` wins and never falls
 * through, then MYCO_AGENT_TOKEN, then ~/.myco-token. Every file is in a temp
 * dir; no test reads a real token file.
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveRunLiveToken } from "../src/integration/run-live-token.ts";

/** Every temp home a test made, removed after it so none is left in $TMPDIR (TIF-229). */
const homes: string[] = [];

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), "myco-run-live-token-"));
  homes.push(home);
  return home;
}

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function put(path: string, text: string): string {
  writeFileSync(path, text);
  chmodSync(path, 0o600);
  return path;
}

describe("resolveRunLiveToken (row-8 H5)", () => {
  it("reads --token-file, trimmed, over the env and the default file", () => {
    const home = tempHome();
    put(join(home, ".myco-token"), "default-value");
    const custom = put(join(home, "private-token"), "custom-value\r\n");
    const got = resolveRunLiveToken(
      ["node", "run-live.ts", "--mode", "normal", "--token-file", custom],
      { MYCO_AGENT_TOKEN: "env-value" },
      home,
    );
    expect(got).toBe("custom-value");
  });

  it("fails on a missing --token-file instead of falling back", () => {
    const home = tempHome();
    put(join(home, ".myco-token"), "default-value");
    const missing = join(home, "nope");
    expect(() =>
      resolveRunLiveToken(["--token-file", missing], { MYCO_AGENT_TOKEN: "env-value" }, home),
    ).toThrow(`cannot read token file ${missing}`);
  });

  it("fails on an empty --token-file", () => {
    const home = tempHome();
    const empty = put(join(home, "empty"), "\r\n");
    expect(() => resolveRunLiveToken(["--token-file", empty], {}, home)).toThrow("is empty");
  });

  it("rejects --token-file with no path", () => {
    expect(() => resolveRunLiveToken(["--token-file"], {}, tempHome())).toThrow(
      "--token-file needs a PATH argument",
    );
    expect(() => resolveRunLiveToken(["--token-file", "--mode", "kill"], {}, tempHome())).toThrow(
      "--token-file needs a PATH argument",
    );
  });

  it("uses MYCO_AGENT_TOKEN when no flag is given (the sweep's path)", () => {
    const home = tempHome();
    put(join(home, ".myco-token"), "default-value");
    expect(resolveRunLiveToken([], { MYCO_AGENT_TOKEN: "env-value" }, home)).toBe("env-value");
  });

  it("falls back to ~/.myco-token, the file the deploy writes", () => {
    const home = tempHome();
    put(join(home, ".myco-token"), "default-value\n");
    expect(resolveRunLiveToken([], { MYCO_AGENT_TOKEN: "" }, home)).toBe("default-value");
  });

  it("names the deploy and --token-file when no token exists", () => {
    const home = tempHome();
    let message = "";
    try {
      resolveRunLiveToken([], {}, home);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain(
      `no agent token: cannot read token file ${join(home, ".myco-token")}`,
    );
    expect(message).toContain("--token-file");
  });
});
