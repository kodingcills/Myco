import { spawnSync } from "node:child_process";
import { lstatSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { decideApproval, denyAllPolicy, sandboxScopedPolicy } from "../../scripts/sai/approvals.ts";
import { SaiClient } from "../../scripts/sai/client.ts";
import { compareBytes, compareItems } from "../../scripts/sai/comparator.ts";
import { Guard } from "../../scripts/sai/guard.ts";
import { Ledger } from "../../scripts/sai/ledger.ts";
import { FORBIDDEN_IN_COMMITTED_FILES, scrub, scrubDeep } from "../../scripts/sai/redact.ts";
import {
  loadState,
  main,
  parseArgs,
  type RunnerState,
  saveState,
  writeOutput,
} from "../../scripts/sai/run.ts";
import { latencySummary, wilson } from "../../scripts/sai/stats.ts";

test("scrubs synthetic credentials and token-like strings from keys and values", () => {
  const samples = [
    `sapi_${"example42".repeat(3)}`,
    `sk-ant-${"example42".repeat(3)}`,
    `sk_${"example42".repeat(3)}`,
    "Ab19".repeat(6),
  ];
  for (const sample of samples) {
    expect(JSON.stringify(scrubDeep({ [sample]: `Bearer ${sample}` }))).not.toContain(sample);
  }
});

test("tracked files contain no credential-shaped Sai keys", () => {
  const result = spawnSync("git", ["ls-files", "-z"], {
    cwd: process.env.MYCO_SAI_TRACKED_ROOT ?? process.cwd(),
    encoding: "utf8",
  });
  expect(result.status, result.stderr).toBe(0);
  for (const file of result.stdout.split("\0").filter(Boolean)) {
    if (file.startsWith("docs/research/experiments/sai-arm-001/raw/")) continue;
    if (!lstatSync(file, { throwIfNoEntry: false })?.isFile()) continue;
    const contents = readFileSync(file);
    if (contents.includes(0)) continue;
    for (const [name, pattern] of FORBIDDEN_IN_COMMITTED_FILES) {
      expect(pattern.test(contents.toString("utf8")), `${file} contains ${name}`).toBe(false);
    }
  }
});

test("link-only approval uses a private file and returns an abort decision", () => {
  const dir = mkdtempSync(join(tmpdir(), "sai-test-"));
  try {
    const url = "https://example.invalid/approval?token=synthetic";
    const decision = decideApproval(
      { isLinkOnly: true, approvalUrl: url },
      denyAllPolicy(() => 1, dir),
    );
    expect(decision).toEqual({
      action: "capture_and_abort",
      reason: "link_only",
      file: join(dir, "approval-1.txt"),
      embedsToken: true,
    });
    const file = join(dir, "approval-1.txt");
    expect(readFileSync(file, "utf8")).toContain(url);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(decision)).not.toContain(url);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("logs a scrubbed 429 and blocks later billable calls", async () => {
  const guard = new Guard();
  guard.observeAccount({ free: true, usd: 1, planTitle: "Explore", userState: "active_free" });
  const key = "synthetic-shared-credential";
  const ledger = new Ledger(null);
  const client = new SaiClient(key, ledger, guard, {
    fetchImpl: async () => ({ status: 429, text: async () => JSON.stringify({ error: key }) }),
  });
  const options = { stage: "test", label: "start", path: "/v1/agents/message" };
  await expect(client.call(options)).rejects.toThrow("http_429");
  expect(ledger.rows[0]).toMatchObject({ status: 429, usage: "not_reported" });
  expect(JSON.stringify(ledger.rows)).not.toContain(key);
  await expect(client.call({ ...options, spend: "agent" })).rejects.toThrow("http_429");
  expect(ledger.rows).toHaveLength(1);
});

test("stops spending at the free credit reserve", () => {
  const guard = new Guard();
  const account = { free: true, usd: 1, planTitle: "Explore", userState: "active_free" };
  guard.observeAccount(account);
  guard.observeAccount({ ...account, usd: 0.2 });
  expect(() => guard.beforeSpend("judge")).toThrow("credits_at_reserve");
});

test("compares persisted bytes and accounts for duplicate list entries", () => {
  const expected = Buffer.from("Myco sample one");
  expect(compareBytes(expected, expected).truth).toBe("verified");
  expect(compareBytes(expected, "absent").truth).toBe("refuted");
  expect(compareBytes(expected, null).truth).toBe("unavailable");
  expect(compareItems(["a", "b", "b"], ["a", "b", "a"])).toMatchObject({
    truth: "refuted",
    missing: ["b"],
    extras: ["a"],
  });
});

test("computes latency percentiles and Wilson bounds without mutating input", () => {
  const values = [30, 10, 20];
  expect(latencySummary(values)).toEqual({
    n: 3,
    minMs: 10,
    medianMs: 20,
    p90Ms: 28,
    maxMs: 30,
    meanMs: 20,
  });
  expect(values).toEqual([30, 10, 20]);
  expect(wilson(1, 1).low).toBeCloseTo(0.2065);
});

test("runs the offline plan without live configuration", async () => {
  expect(await main(["--dry-run"])).toBe(0);
});

test.each(["events", "turns", "abort"])(
  "keeps approval links and tokens out of %s diagnostics",
  async (endpoint) => {
    const url = "https://example.invalid/x?code=short";
    const token = "tiny";
    const ledger = new Ledger(null);
    const client = new SaiClient("fake-key", ledger, new Guard(), {
      fetchImpl: async () => ({
        status: 200,
        text: async () =>
          JSON.stringify({
            status: "needs_approval",
            approval: { isLinkOnly: true, token, approvalUrl: url },
            usage: { approval_url: url },
            events: [{ data: { approvalToken: token, text: url } }],
            text: `${url} ${token}`,
          }),
      }),
    });
    const res = await client.call({
      stage: "test",
      label: endpoint,
      path: `/v1/agents/${endpoint}`,
    });
    expect(res.approval?.approvalUrl).toBe(endpoint === "events" ? url : undefined);
    for (const diagnostics of [ledger.rows, res.body]) {
      expect(JSON.stringify(diagnostics)).toContain("present");
      expect(JSON.stringify(diagnostics)).not.toContain(url);
      expect(JSON.stringify(diagnostics)).not.toContain(token);
      expect(JSON.stringify(diagnostics)).not.toContain("short");
    }
  },
);

const sandbox = "C:\\Users\\Public\\Documents\\myco_sai\\t1_abcdef";
const note = `${sandbox}\\note.txt`;
const policy = sandboxScopedPolicy(sandbox, () => 1);

test.each([
  "notepad.exe",
  "Start-Process notepad.exe",
  'cmd /c start "" notepad.exe',
  `Get-Content ${note}`,
  `Get-Content -LiteralPath '${note}'`,
])("permits the T1 launch or exact note read: %s", (command) => {
  expect(policy.allowCommand(command, undefined)).not.toBeNull();
});

test.each([
  `Get-Content ${sandbox}\\..\\..\\..\\Windows\\win.ini`,
  `Move-Item ${note} \\\\evil\\share`,
  `Start-Process cmd -ArgumentList '/c dir'; dir ${note}`,
  `ls ${sandbox}EVIL\\x`,
  `Get-Content ${sandbox}EVIL\\note.txt`,
  `Get-Content ${sandbox}\\.\\note.txt`,
  `Get-Content ${note}:stream`,
  `Get-Content ${sandbox}/note.txt`,
  "Get-Content %TEMP%\\note.txt",
  "Get-Content ~\\note.txt",
  "Get-Content C:note.txt",
  `Get-Content ${note} | Out-Null`,
  `Get-Content ${note} > elsewhere`,
  `Get-Content $(${note})`,
  `Invoke-Item ${note}`,
  "powershell -EncodedCommand sample",
])("rejects commands outside the T1 allowlist: %s", (command) => {
  expect(policy.allowCommand(command, undefined)).toBeNull();
});

test.each([
  [402, {}, "http_402"],
  [200, { error: "upgrade to continue" }, "paid_signal"],
  [200, { events: [{ type: "data-progress", data: { text: "select a plan" } }] }, "paid_signal"],
  [200, { code: "insufficient_credits" }, "insufficient_credits"],
  [200, { events: [{ type: "error", data: { reason_code: "rate_limited" } }] }, "rate_limited"],
])("stops on HTTP %s vendor signal %#", (status, body, reason) => {
  const guard = new Guard();
  expect(() => guard.observeResponse(status, body, "test")).toThrow(reason);
});

test("ignores echoed documentation in request metadata", () => {
  const guard = new Guard();
  guard.observeResponse(
    200,
    { request: { message: "Read the payment and upgrade documentation" } },
    "test",
  );
  expect(guard.stopped).toBeNull();
});

test("persists all spend caps and the local message cap across invocations", () => {
  const dir = mkdtempSync(join(tmpdir(), "sai-state-test-"));
  const file = join(dir, "fixture.json");
  try {
    const state: RunnerState = {
      initialUsd: 1,
      counters: { calls: { agent: 0, convert: 0, repair: 0, judge: 0 }, messageTimes: [] },
      machineId: null,
      approvalCount: 0,
      turns: {},
      priv: {},
    };
    const account = { free: true, usd: 1, planTitle: "Explore", userState: "active_free" };
    const guard = new Guard(
      () => 1000,
      state.counters,
      () => saveState(state, file),
    );
    guard.observeAccount(account);
    const caps = { agent: 8, convert: 1, repair: 1, judge: 5 } as const;
    for (const kind of ["agent", "convert", "repair", "judge"] as const) {
      for (let i = 0; i < caps[kind]; i += 1) {
        expect(() => guard.beforeSpend(kind)).not.toThrow();
      }
    }
    for (let i = 0; i < 20; i += 1) guard.beforeMessage();
    expect(() => loadState(file)).not.toThrow();
    const reopened = loadState(file);
    expect(reopened.counters.calls).toEqual(caps);
    for (const kind of ["agent", "convert", "repair", "judge"] as const) {
      const resumed = new Guard(() => 1001, reopened.counters);
      resumed.observeAccount(account);
      expect(() => resumed.beforeSpend(kind)).toThrow("call_cap");
    }
    expect(() => new Guard(() => 1001, reopened.counters).beforeMessage()).toThrow(
      "local_rate_cap",
    );
    expect(() => new Guard(() => 3_601_000, reopened.counters).beforeMessage()).not.toThrow();
    expect(statSync(file).mode & 0o777).toBe(0o600);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rejects missing, corrupt and pre-counter state", () => {
  const dir = mkdtempSync(join(tmpdir(), "sai-state-test-"));
  const file = join(dir, "fixture.json");
  try {
    expect(() => loadState(file)).toThrow("invalid_state");
    for (const contents of [
      "{",
      '{"initialUsd":1}',
      '{"counters":{"calls":{},"messageTimes":[]}}',
    ]) {
      writeFileSync(file, contents);
      expect(() => loadState(file)).toThrow("invalid_state");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scrubs pure-letter runs, user IDs and short token assignments in STOPPED output", () => {
  const token = "Abcdefghijklmnopqrstuv";
  const user = "user_" + "abcdefghijklmnopqrstuvwx";
  const output = { write: vi.fn() };
  writeOutput(output, `STOPPED: ${token} ${user} token=brief`);
  const line = output.write.mock.calls[0]?.[0];
  expect(line).toContain("STOPPED:");
  for (const secret of [token, user, "brief"]) expect(line).not.toContain(secret);
  const readable = "ordinary English https://an-extraordinarily-long-host.example";
  expect(scrub(readable)).toBe(readable);
});

test("MCP is opt-in and the dry-run leaves the lease open", async () => {
  expect(parseArgs(["--stages", "s0"]).checkMcp).toBe(false);
  expect(parseArgs(["--check-mcp", "--stages", "s0"]).checkMcp).toBe(true);
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  try {
    expect(await main(["--dry-run", "--check-mcp", "--stages", "s0"])).toBe(0);
    expect(stdout).toHaveBeenCalledWith(expect.stringContaining("leave the lease open"));
  } finally {
    stdout.mockRestore();
  }
});
