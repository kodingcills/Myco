import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { decideApproval, denyAllPolicy } from "../../scripts/sai/approvals.ts";
import { SaiClient } from "../../scripts/sai/client.ts";
import { compareBytes, compareItems } from "../../scripts/sai/comparator.ts";
import { Guard } from "../../scripts/sai/guard.ts";
import { Ledger } from "../../scripts/sai/ledger.ts";
import { scrubDeep } from "../../scripts/sai/redact.ts";
import { main } from "../../scripts/sai/run.ts";
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
  const result = spawnSync("git", ["grep", "-IlE", "sapi_[A-Za-z0-9_-]{8,}"], {
    cwd: process.env.MYCO_SAI_TRACKED_ROOT ?? process.cwd(),
    encoding: "utf8",
  });
  expect(result.stderr).toBe("");
  expect(result.status, result.stdout).toBe(1);
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
