import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  appendLedger,
  assessPreflight,
  cleanupSelection,
  createApi,
  guard,
  parseOffers,
  redact,
  stats,
} from "../../scripts/orgo/core.ts";
import { loadKey, main, parseArgs, renderResults } from "../../scripts/orgo/run.ts";

// Fixtures are assembled at runtime so no literal looks like a real credential to secret scanners.
const prefixShape = ["sk", "_"].join("");
const key = `${prefixShape}${"live"}_0123456789abcdefABCDEF0123456789`;
const testKey = `${prefixShape}${"test"}_AAAAAAAAAAAAAAAAAAAAAAAA`;

describe("redact", () => {
  it("removes the key, sk_ keys, bearer and token-shaped strings", () => {
    const text = [
      `key ${key}`,
      "Authorization: Bearer abcDEF0123456789abcDEF0123456789",
      '{"vnc_password":"hunter2hunter2","token":"eyJhbGciOi.payload.sig"}',
      "https://www.orgo.ai/view?token=abcDEF0123456789abcDEF",
      "wss://host.example/ws/websockify",
      "Cookie: session=AbCdEf0123456789AbCdEf0123456789",
      testKey,
      "plain base64 dGhpcyBpcyBhIHNlY3JldCB0b2tlbiB2YWx1ZSAxMjM0NTY3ODkw",
      "short a1b2c3d4e5f6a7b8c9d0e1f2a3b4",
    ].join("\n");
    const out = redact(text, key);
    for (const secret of [
      key,
      "sk_live",
      "sk_test",
      "abcDEF0123456789",
      "hunter2",
      "eyJhbGciOi",
      "AbCdEf0123456789",
      "dGhpcyBpcyBh",
      "a1b2c3d4e5f6a7b8c9d0e1f2a3b4",
    ]) {
      expect(out).not.toContain(secret);
    }
    expect(out).not.toMatch(new RegExp(prefixShape));
  });

  it("keeps error codes and docs links, shortens uuids", () => {
    const out = redact(
      '{"code":"HOURLY_QUOTE_REQUIRED","docs_url":"https://docs.orgo.ai/api-reference/computers/fork","id":"7f3a9c21-5e8b-4d0a-b6c4-1e2f3a4b5c6d"}',
      key,
    );
    expect(out).toContain("HOURLY_QUOTE_REQUIRED");
    expect(out).toContain("https://docs.orgo.ai/api-reference/computers/fork");
    expect(out).toContain('"7f3a9c21"');
    expect(out).not.toContain("5e8b");
  });

  it("never leaks the key through API errors or bodies", async () => {
    const api = createApi(
      key,
      (async () => new Response(`echo ${key}`, { status: 500 })) as typeof fetch,
    );
    const reply = await api("GET", "/api/credits");
    expect(reply.body).not.toContain(key);
    const failing = createApi(key, (async () => {
      throw new Error(`boom ${key}`);
    }) as typeof fetch);
    await expect(failing("GET", "/api/credits")).rejects.toThrow(/before a response/);
    await expect(failing("GET", "/api/credits")).rejects.not.toThrow(key);
  });
});

describe("spend guard", () => {
  it("allows spend under the stop rule and refuses at $1.20", () => {
    expect(() => guard(300, 200, 0, 1)).not.toThrow();
    expect(() => guard(300, 181, 1, 1)).not.toThrow();
    expect(() => guard(300, 180, 1, 1)).toThrow(/stop rule/);
    expect(() => guard(300, 100, 0, 1)).toThrow(/stop rule/);
  });
  it("refuses more than two computers and unknown credit", () => {
    expect(() => guard(300, 290, 2, 1)).toThrow(/limit is two/);
    expect(() => guard(300, 290, 1, 1)).not.toThrow();
    expect(() => guard(300, Number.NaN, 0, 1)).toThrow(/credit/);
    expect(() => guard(300, 20, 0, 1)).toThrow(/credit/);
  });
});

describe("cleanup selection", () => {
  it("selects only myco-discovery-* names", () => {
    const picked = cleanupSelection([
      { id: "1", name: "myco-discovery-base", status: "running" },
      { id: "2", name: "myco-discovery-base (fork)", status: "running" },
      { id: "3", name: "someone-elses-computer", status: "running" },
      { id: "4", name: "my-myco-discovery-x", status: "running" },
    ]);
    expect(picked.map((c) => c.id)).toEqual(["1", "2"]);
  });
});

describe("stats", () => {
  it("reports N, min, median, nearest-rank p95 and max", () => {
    expect(stats([])).toEqual({ n: 0, min: null, median: null, p95: null, max: null });
    expect(stats([5, 1, 3, 2, 4])).toEqual({ n: 5, min: 1, median: 3, p95: 5, max: 5 });
    expect(stats([4, 1, 2, 3])).toMatchObject({ median: 2.5, p95: 4 });
    const twenty = Array.from({ length: 20 }, (_, i) => i + 1);
    expect(stats(twenty).p95).toBe(19);
  });
});

describe("ledger", () => {
  it("appends redacted JSONL rows", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orgo-ledger-"));
    const path = join(dir, "ledger.jsonl");
    const row = {
      operation: "create",
      timestamp: "2026-01-01T00:00:00.000Z",
      computer: "abcd1234",
      status: 409,
      code: "HOURLY_QUOTE_REQUIRED",
      latencyMs: 12,
      body: `bad ${key}`,
      beforeCents: 300,
      immediateCents: 298,
      delayedCents: 297,
      spendCents: 3,
    };
    await appendLedger(path, row, key);
    await appendLedger(path, { ...row, operation: "fork" }, key);
    const lines = (await readFile(path, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines.join("")).not.toContain(key);
    expect(JSON.parse(lines[1] ?? "{}")).toMatchObject({ operation: "fork", spendCents: 3 });
  });
});

describe("preflight", () => {
  const medium = { name: "Medium", cpu: 2, ramGb: 8, diskGb: 40, usdPerHour: 0.055 };
  it("gates a Free account that offers only Medium", () => {
    const result = assessPreflight({
      tier: "free",
      mode: "free",
      balanceCents: 300,
      offers: [medium],
      inventoryCount: 0,
    });
    expect(result.ok).toBe(false);
    expect(result.reasons.join(" ")).toMatch(/Free account/);
    expect(result.reasons.join(" ")).toMatch(/no Small/);
  });
  it("passes a paid account offering Small with an empty inventory", () => {
    const small = { ...medium, name: "Small", cpu: 0.5, ramGb: 4 };
    expect(
      assessPreflight({
        tier: "starter",
        mode: "hourly",
        balanceCents: 300,
        offers: [small, medium],
        inventoryCount: 0,
      }).ok,
    ).toBe(true);
    expect(
      assessPreflight({
        tier: "starter",
        mode: "hourly",
        balanceCents: 300,
        offers: [small],
        inventoryCount: 1,
      }).ok,
    ).toBe(false);
  });
  it("parses the offers shape", () => {
    expect(
      parseOffers({
        entries: [
          {
            sku: { name: "Medium", specification: { cpu: 2, ramGb: 8, diskGb: 40 } },
            offer: { price: { activeMicrosPerHour: 55000 } },
          },
        ],
      }),
    ).toEqual([medium]);
  });
});

describe("dry run (fake service, no network)", () => {
  async function dry(scenario: "free" | "paid-gated" | "paid-open") {
    const dir = await mkdtemp(join(tmpdir(), "orgo-dry-test-"));
    const raw = await main(["run", "--dry-run", "--scenario", scenario, "--out", dir]);
    return { raw, dir, ledger: await readFile(join(dir, "ledger.jsonl"), "utf8") };
  }

  it("stops before any POST on a free account", async () => {
    const { raw, ledger } = await dry("free");
    expect(raw.preflight.ok).toBe(false);
    expect(raw.experiments).toEqual({});
    expect(ledger).not.toContain("create");
  });

  it("records the fork gate and cleans up", async () => {
    const { raw } = await dry("paid-gated");
    expect(raw.preflight.ok).toBe(true);
    expect(raw.experiments.E2?.rejected[0]).toMatchObject({
      status: 409,
      code: "HOURLY_QUOTE_REQUIRED",
    });
    expect(raw.experiments.E2?.n).toBe(0);
    expect(
      raw.experiments.E4?.observations.some((o) => JSON.stringify(o).includes("HOURLY_USE_STOP")),
    ).toBe(true);
    expect(raw.cleanup.finalCount).toBe(0);
  });

  it("runs the whole set against the open fake and leaves no computers", async () => {
    const { raw, dir } = await dry("paid-open");
    expect(raw.experiments.E2?.n).toBe(5);
    expect(raw.experiments.E3?.n).toBe(5);
    expect(raw.cleanup.finalCount).toBe(0);
    expect(raw.spend.ledgerCents).toBeGreaterThan(0);
    const md = await readFile(join(dir, "RESULTS.md"), "utf8");
    expect(md).toContain("| sourcePauseMaxGapMs | 5 |");
    expect(md).not.toMatch(/sk_/);
  });

  it("stops allocating at the $1.20 threshold, still cleans up", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orgo-dry-test-"));
    const raw = await main([
      "run",
      "--dry-run",
      "--scenario",
      "paid-open",
      "--charge-cents",
      "50",
      "--out",
      dir,
    ]);
    expect(raw.spend.ledgerCents).toBeGreaterThanOrEqual(120);
    expect(raw.experiments.E2?.n).toBeLessThan(5);
    expect(raw.cleanup.finalCount).toBe(0);
    const ledger = (await readFile(join(dir, "ledger.jsonl"), "utf8")).split("\n");
    const forks = ledger.filter((line) => line.includes('"operation":"E2 fork'));
    expect(forks.length).toBeLessThan(5);
  });

  it("renders a gated report", async () => {
    const { raw } = await dry("free");
    const md = await renderResults(raw);
    expect(md).toContain("precondition failed");
    expect(md).toContain("not measured (gated)");
  });
});

describe("cli plumbing", () => {
  it("parses arguments and loads the key without echoing it", async () => {
    expect(parseArgs(["cleanup", "--dry-run"])).toMatchObject({ command: "cleanup", dryRun: true });
    expect(parseArgs(["--dry-run", "--out", "x", "preflight"]).command).toBe("preflight");
    const dir = await mkdtemp(join(tmpdir(), "orgo-key-"));
    const path = join(dir, "orgo.env");
    await writeFile(path, `ORGO_API_KEY="${key}"\n`, { mode: 0o600 });
    expect(await loadKey(path)).toBe(key);
    await writeFile(path, "OTHER=1\n");
    await expect(loadKey(path)).rejects.toThrow(/missing/);
  });
});
