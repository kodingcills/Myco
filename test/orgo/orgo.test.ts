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
  object,
  parseOffers,
  probeLimits,
  redact,
  stats,
} from "../../scripts/orgo/core.ts";
import { fakeOrgo, type Scenario } from "../../scripts/orgo/fake.ts";
import {
  allow,
  DeadlineError,
  fetchHistory,
  liveApproved,
  loadKey,
  main,
  parseArgs,
  renderResults,
  until,
} from "../../scripts/orgo/run.ts";

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
    expect(() => guard(300, 290, 2, 1)).toThrow(/limit is 2/);
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
  it("admits the Free probe only with the exact offer, enough credit and empty inventory", () => {
    const eligible = {
      tier: "Free",
      mode: "hourly",
      balanceCents: 25,
      offers: [medium],
      inventoryCount: 0,
    };
    expect(assessPreflight(eligible)).toMatchObject({ ok: true, profile: "probe" });
    expect(assessPreflight({ ...eligible, tier: "unknown", mode: "free" }).ok).toBe(true);
    for (const change of [
      { offers: [] },
      { offers: [medium, medium] },
      { offers: [{ ...medium, name: "Large" }] },
      { offers: [{ ...medium, cpu: 1 }] },
      { offers: [{ ...medium, ramGb: 4 }] },
      { offers: [{ ...medium, usdPerHour: 0.054 }] },
      { inventoryCount: 1 },
      { inventoryCount: null },
      { balanceCents: 24 },
      { balanceCents: null },
      { balanceCents: Number.NaN },
    ])
      expect(assessPreflight({ ...eligible, ...change }).ok).toBe(false);
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
  async function dry(scenario: Scenario) {
    const dir = await mkdtemp(join(tmpdir(), "orgo-dry-test-"));
    const raw = await main(["run", "--dry-run", "--scenario", scenario, "--out", dir]);
    return { raw, dir, ledger: await readFile(join(dir, "ledger.jsonl"), "utf8") };
  }

  it.each([
    ["free", 403, "HOURLY_LIMIT"],
    ["free-quote", 409, "HOURLY_QUOTE_REQUIRED"],
  ] as const)("runs the %s probe through cleanup", async (scenario, status, code) => {
    const { raw, ledger } = await dry(scenario);
    expect(raw.errors).toEqual([]);
    expect(raw.preflight).toMatchObject({ ok: true, profile: "probe" });
    expect(raw.experiments.E0?.observations[0]).toEqual({ sizeObtained: { cpu: 2, ramGb: 8 } });
    for (const experiment of [raw.experiments.E2, raw.experiments.E3]) {
      expect(experiment).toMatchObject({ planned: 1, n: 0, rejected: [{ status, code }] });
      expect(experiment?.rejected).toHaveLength(1);
    }
    expect(raw.experiments.E0?.metrics.createToRunningMs?.p95).toBeNull();
    expect(ledger).toContain("HOURLY_USE_STOP");
    expect(ledger).not.toContain("E4 resume");
    expect(raw.experiments.E5?.observations).toEqual([
      { status: 409, code: "NOT_FORKABLE", body: '{"error":"Not running","code":"NOT_FORKABLE"}' },
      {
        cloneStatus: 400,
        cloneCode: "NOT_CLONABLE",
        body: '{"error":"No host on record","code":"NOT_CLONABLE"}',
      },
    ]);
    expect(raw.cleanup.finalCount).toBe(0);
  });

  it.each(["fork", "clone"] as const)(
    "deletes an unexpected %s before any further work",
    async (action) => {
      const fake = fakeOrgo({ scenario: `free-${action}-open` });
      const dir = await mkdtemp(join(tmpdir(), "orgo-unexpected-"));
      const raw = await main(["--dry-run", "--out", dir], { fake: () => fake });
      expect(raw.errors).toEqual([`Unexpected probe ${action} success; ending the run`]);
      expect(raw.cleanup.finalCount).toBe(0);
      expect(fake.computers.size).toBe(0);
      const index = fake.calls.findIndex((call) => call.endsWith(`/${action}`));
      expect(fake.calls[index + 1]).toMatch(/^DELETE \/api\/computers\/00000002-/);
      expect(fake.calls.slice(index + 1).filter((call) => call.startsWith("POST "))).toEqual([]);
    },
  );

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

  it("renders the historical gate without suggesting a probe ran", async () => {
    const raw = JSON.parse(
      await readFile("docs/research/experiments/orgo-arm-001/raw.json", "utf8"),
    );
    const md = await renderResults(raw);
    expect(md).toContain("precondition failed");
    expect(md).toContain("No computer created");
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

describe("cleanup scope (P1-1)", () => {
  it("selects auto-named forks that are created or absent at preflight, regardless of name", () => {
    const computers = [
      { id: "a", name: "myco-discovery-base", status: "running" },
      { id: "b", name: "agent-1 (fork)", status: "running" },
      { id: "c", name: "someone-elses", status: "running" },
    ];
    expect(cleanupSelection(computers).map((c) => c.id)).toEqual(["a"]);
    expect(cleanupSelection(computers, { created: ["b"] }).map((c) => c.id)).toEqual(["a", "b"]);
    expect(cleanupSelection(computers, { baseline: ["c"] }).map((c) => c.id)).toEqual(["a", "b"]);
    expect(cleanupSelection(computers, { created: ["a", "b"], baseline: ["c"] })).toHaveLength(2);
  });

  it("deletes the fork and source when the run throws mid-E2", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orgo-dry-test-"));
    const raw = await main([
      "run",
      "--dry-run",
      "--scenario",
      "paid-open",
      "--fail-mid-e2",
      "--out",
      dir,
    ]);
    expect(raw.errors.join(" ")).toMatch(/before a response/);
    expect(raw.cleanup.finalCount).toBe(0);
    expect(raw.cleanup.deleted.length).toBeGreaterThanOrEqual(2);
  });
});

describe("E5 guards and documented codes (P1-2)", () => {
  it("records NOT_FORKABLE and NOT_CLONABLE for a stopped source after allow()", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orgo-dry-test-"));
    const raw = await main(["run", "--dry-run", "--scenario", "paid-open", "--out", dir]);
    const e5 = raw.experiments.E5?.observations ?? [];
    expect(e5[0]).toMatchObject({ status: 409, code: "NOT_FORKABLE" });
    expect(e5[1]).toMatchObject({ cloneStatus: 400, cloneCode: "NOT_CLONABLE" });
  });

  it("never POSTs the E5 fork or clone once spend is at the stop rule", async () => {
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
    expect(raw.errors.join(" ")).toMatch(/stop rule/);
    const ledger = await readFile(join(dir, "ledger.jsonl"), "utf8");
    expect(ledger).not.toContain("E5 fork");
    expect(ledger).not.toContain("E5 clone");
    expect(raw.cleanup.finalCount).toBe(0);
  });
});

describe("run bound (P2-1)", () => {
  it("until throws once the deadline has passed", async () => {
    const ctx = { sleep: async () => undefined, deadlineAt: performance.now() - 1 };
    await expect(
      until(
        ctx,
        "x",
        () => false,
        60_000,
        async () => ({ status: 200, ms: 0, data: {}, body: "" }),
      ),
    ).rejects.toThrow(DeadlineError);
  });

  it("stops before the first create when the bound is already reached, then cleans up", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orgo-dry-test-"));
    const raw = await main([
      "run",
      "--dry-run",
      "--scenario",
      "paid-open",
      "--deadline-ms",
      "0",
      "--out",
      dir,
    ]);
    expect(raw.errors.join(" ")).toMatch(/run bound/);
    expect(raw.cleanup.finalCount).toBe(0);
    expect(await readFile(join(dir, "ledger.jsonl"), "utf8")).not.toContain("E0 create");
  });
});

describe("report wording (P2-2) and history (P2-3)", () => {
  it("is marked not cleared and drops the unsourced claims", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orgo-dry-test-"));
    const raw = await main(["run", "--dry-run", "--scenario", "free", "--out", dir]);
    const md = await renderResults(raw);
    expect(md).toContain("NOT CLEARED FOR LIVE USE");
    expect(md).not.toContain("retrieved at run time");
    expect(md).not.toContain("21-25");
    expect(md).not.toContain("~21 s warm");
    expect(md).not.toMatch(/cold boot/);
    expect(md).toContain("2 vCPU, 8 GB (create response)");
    expect(md).toContain("p95 is omitted for N=1");
    expect(md).not.toContain("Eligible for Small");
  });

  it("reads billing history over REST, never through npx", async () => {
    const fake = fakeOrgo({ scenario: "free" });
    const rows = await fetchHistory(createApi("k", fake.request));
    expect(rows).toEqual([expect.objectContaining({ type: "initial_grant" })]);
    expect(fake.calls).toContain("GET /api/credits/transactions");
    const failing = createApi(
      "k",
      (async () => new Response("nope", { status: 500 })) as typeof fetch,
    );
    expect(await fetchHistory(failing)).toBeNull();
  });
});

describe("strict arguments (P2-4) and live approval", () => {
  it("rejects unknown or malformed scenario values and options", () => {
    expect(() => parseArgs(["--scenario", "fre"])).toThrow(/Unknown scenario/);
    expect(() => parseArgs(["--scenario"])).toThrow(/needs a value/);
    expect(() => parseArgs(["--scenario", "--dry-run"])).toThrow(/needs a value/);
    expect(() => parseArgs(["--bogus"])).toThrow(/Unknown option/);
    expect(() => parseArgs(["--charge-cents", "abc"])).toThrow(/number/);
    expect(() => parseArgs(["launch"])).toThrow(/Unknown command/);
    expect(parseArgs(["--scenario", "paid-gated", "--dry-run"]).scenario).toBe("paid-gated");
  });

  it("requires an explicit approval switch for live experiments", () => {
    expect(liveApproved({})).toBe(false);
    expect(liveApproved({ ORGO_LIVE_APPROVED: "1" })).toBe(false);
    expect(liveApproved({ ORGO_LIVE_APPROVED: "yes" })).toBe(true);
  });
});

describe("probe spend and inventory guard", () => {
  it("allow refuses at 15c and grants the one-copy exception only from a valid inventory", async () => {
    let balance = 285;
    let count = 1;
    const ctx = {
      probe: true,
      startCents: 300,
      lastCents: 300,
      lowestCents: 300,
      deadlineAt: performance.now() + 10_000,
      workspaceId: "workspace",
      api: async (_method: string, path: string) => ({
        status: 200,
        ms: 0,
        body: "",
        data: path.endsWith("credits")
          ? { balanceCents: balance }
          : {
              desktops: Array.from({ length: count }, (_, i) => ({ id: String(i) })),
            },
      }),
    };
    await expect(allow(ctx, 1, true)).rejects.toThrow(/15c stop rule/);
    await expect(allow(ctx, 0)).rejects.toThrow(/15c stop rule/);
    balance = 286;
    ctx.lowestCents = 300;
    await expect(allow(ctx, 1)).rejects.toThrow(/Computer limit is 1/);
    await expect(allow(ctx, 1, true)).resolves.toBeUndefined();
    count = 2;
    await expect(allow(ctx, 1, true)).rejects.toThrow(/Computer limit is 1/);
    expect(() => guard(300, 285, 0, 1, probeLimits)).toThrow(/15c stop rule/);
  });

  it.each([
    { phase: "E2 fork", after: "plant read", blocked: "fork", allowed: 0 },
    { phase: "E3 clone", after: "1 fork", blocked: "clone", allowed: 0 },
    { phase: "E4 stop", after: "1 clone", blocked: "stop", allowed: 0 },
    { phase: "E4 start", after: "1 stop", blocked: "start", allowed: 0 },
    { phase: "E4 suspend", after: "replant read", blocked: "suspend", allowed: 0 },
    { phase: "E4 resume", after: "1 suspend", blocked: "resume", allowed: 0 },
    { phase: "E5 fork", after: "2 stop", blocked: "fork", allowed: 1 },
    { phase: "E5 clone", after: "2 fork", blocked: "clone", allowed: 1 },
  ])("refuses $phase after spend crosses to exactly 15c", async ({ after, blocked, allowed }) => {
    const fake = fakeOrgo({ scenario: "free" });
    const counts = new Map<string, number>();
    let crossed = false;
    const request: typeof fetch = async (input, init) => {
      const response = await fake.request(input, init);
      const call = fake.calls.at(-1) ?? "";
      const action = call.split("/").at(-1) ?? "";
      if (call.startsWith("POST ")) {
        if (action === "bash" && String(init?.body).includes("MYCO_STATE_MARKER")) {
          counts.set("plants", (counts.get("plants") ?? 0) + 1);
        }
        const occurrence = (counts.get(action) ?? 0) + 1;
        counts.set(action, occurrence);
        const isStateRead =
          action === "bash" &&
          typeof init?.body === "string" &&
          JSON.parse(init.body).command === "python3 /root/myco-state.py read";
        if (
          after === `${occurrence} ${action}` ||
          (isStateRead &&
            (after === "plant read" || (after === "replant read" && counts.get("plants") === 2)))
        ) {
          crossed = true;
        }
        if (action === "suspend" && after === "1 suspend")
          return new Response('{"success":true}', { status: 200 });
      }
      if (crossed && call === "GET /api/credits")
        return new Response('{"balanceCents":285,"tier":"free"}');
      return response;
    };
    const dir = await mkdtemp(join(tmpdir(), "orgo-spend-"));
    const raw = await main(["--dry-run", "--out", dir], {
      fake: () => ({ ...fake, request }),
    });
    expect(crossed).toBe(true);
    expect(raw.errors).toEqual(["Observed spend reached the 15c stop rule"]);
    expect(counts.get(blocked) ?? 0).toBe(allowed);
    expect(raw.cleanup.finalCount).toBe(0);
  });
});

describe("API and live-run gating", () => {
  it("uses exactly the approved method and path set across dry runs", async () => {
    const calls = new Set<string>();
    for (const scenario of ["free", "paid-open"] as const) {
      const fake = fakeOrgo({ scenario });
      const dir = await mkdtemp(join(tmpdir(), "orgo-routes-"));
      const request: typeof fetch = async (input, init) => {
        const reply = await fake.request(input, init);
        return fake.calls.at(-1)?.endsWith("/suspend")
          ? new Response('{"success":true}', { status: 200 })
          : fake.calls.at(-1)?.endsWith("/resume")
            ? new Response('{"success":true}', { status: 200 })
            : reply;
      };
      const raw = await main(["--dry-run", "--out", dir], {
        fake: () => ({ ...fake, request }),
        loadKey: async () => {
          throw new Error("dry run attempted to load a key");
        },
        fetch: async () => {
          throw new Error("dry run attempted network");
        },
      });
      expect(raw.errors).toEqual([]);
      expect(raw.cleanup.finalCount).toBe(0);
      for (const call of fake.calls) calls.add(call.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, ":id"));
    }
    expect([...calls].sort()).toEqual([
      "DELETE /api/computers/:id",
      "GET /api/billing/compute",
      "GET /api/computers/:id",
      "GET /api/credits",
      "GET /api/credits/transactions",
      "GET /api/workspaces",
      "GET /api/workspaces/:id",
      "POST /api/computers",
      ...["bash", "clone", "fork", "resume", "start", "stop", "suspend"].map(
        (action) => `POST /api/computers/:id/${action}`,
      ),
    ]);
    const fake = fakeOrgo({ scenario: "free" });
    const api = createApi(key, fake.request);
    for (const path of [
      "/billing",
      "/api/credits/top-up",
      "/api/billing/portal",
      "/api/billing/plan",
      "/api/billing/quote",
      "/api/computers/x/confirm",
      "/api/../credits",
    ]) {
      await expect(api("POST", path)).rejects.toThrow(/Unexpected API path/);
    }
    await expect(api("GET", "/api/computers/x/fork")).rejects.toThrow(/Unexpected API path/);
    expect(fake.calls).toEqual([]);
  });

  it.each([{}, { ORGO_LIVE_APPROVED: "yes" }, { ORGO_PROBE_APPROVED: "yes" }])(
    "refuses a Free live experiment with incomplete switches %j",
    async (env) => {
      const fake = fakeOrgo({ scenario: "free" });
      const dir = await mkdtemp(join(tmpdir(), "orgo-approval-"));
      const raw = await main(["run", "--out", dir], {
        env,
        loadKey: async () => key,
        fetch: fake.request,
      });
      expect(raw.preflight.ok).toBe(true);
      expect(raw.errors.join()).toContain("Live run refused");
      expect(fake.calls.every((call) => call.startsWith("GET "))).toBe(true);
    },
  );

  it.each([
    ["--scenario", "free"],
    ["--charge-cents", "0"],
    ["--deadline-ms", "1"],
    ["--fail-mid-e2"],
  ])("rejects live-only misuse of %s", (...flags) =>
    expect(() => parseArgs(["run", ...flags])).toThrow(/require --dry-run/),
  );
});

describe("independent review reproductions", () => {
  const newOut = () => mkdtemp(join(tmpdir(), "orgo-review-"));
  const runFake = (dir: string, fake: ReturnType<typeof fakeOrgo>, extra: string[] = []) =>
    main(["run", "--dry-run", "--out", dir, ...extra], { fake: () => fake });
  const recoveryAt = async (dir: string) =>
    JSON.parse(await readFile(join(dir, "recovery.local.json"), "utf8"));

  it("refuses the live-shaped Free run before the delayed 30c debit can be incurred", async () => {
    const fake = fakeOrgo({ scenario: "free" });
    let cleanupStarted = false;
    const request: typeof fetch = async (input, init) => {
      const response = await fake.request(input, init);
      if (init?.method === "DELETE") cleanupStarted = true;
      if (fake.calls.at(-1) === "GET /api/credits") {
        return new Response(
          JSON.stringify({ balanceCents: cleanupStarted ? 270 : 300, tier: "free" }),
        );
      }
      return response;
    };

    // The fake first demonstrates that the 15c observed stop alone misses the delayed debit.
    const simulation = await runFake(await newOut(), { ...fake, request });
    expect(simulation.spend.ledgerCents).toBe(30);
    expect(simulation.cleanup.finalCount).toBe(0);

    fake.calls.length = 0;
    cleanupStarted = false;
    const out = await newOut();
    const blocked = await main(["run", "--out", out], {
      env: { ORGO_LIVE_APPROVED: "yes", ORGO_PROBE_APPROVED: "yes" },
      loadKey: async () => key,
      fetch: request,
    });
    expect(blocked.errors.join()).toMatch(/no verified provider ceiling.*25c cap/);
    expect(blocked.experiments).toEqual({});
    expect(blocked.spend.ledgerCents).toBe(0);
    expect(fake.calls.every((call) => call.startsWith("GET "))).toBe(true);
    await expect(readFile(join(out, "recovery.local.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("refuses the clone when credits return 503 after the first gated fork", async () => {
    const fake = fakeOrgo({ scenario: "free" });
    let forkAttempted = false;
    const request: typeof fetch = async (input, init) => {
      const reply = await fake.request(input, init);
      const call = fake.calls.at(-1) ?? "";
      if (call.endsWith("/fork")) forkAttempted = true;
      return forkAttempted && call === "GET /api/credits"
        ? new Response(null, { status: 503 })
        : reply;
    };
    const raw = await runFake(await newOut(), { ...fake, request });
    expect(forkAttempted).toBe(true);
    expect(fake.calls.some((call) => call.endsWith("/clone"))).toBe(false);
    expect(raw.errors.join()).toContain("Balance returned HTTP 503");
    expect(raw.spend.ledgerCents).toBeNull();
    expect(raw.cleanup.finalCount).toBe(0);
  });

  it("retries an unexpected copy after both the immediate and first cleanup DELETE fail", async () => {
    const fake = fakeOrgo({ scenario: "free-fork-open" });
    let forkId: string | undefined;
    let attempts = 0;
    const request: typeof fetch = async (input, init) => {
      if (
        forkId &&
        init?.method === "DELETE" &&
        String(input).endsWith(forkId) &&
        ++attempts <= 2
      ) {
        throw new Error("dropped DELETE transfer");
      }
      const reply = await fake.request(input, init);
      if (fake.calls.at(-1)?.endsWith("/fork"))
        forkId = String(object(await reply.clone().json()).id);
      return reply;
    };
    const dir = await newOut();
    const raw = await runFake(dir, { ...fake, request });
    expect(attempts).toBe(3);
    expect(raw.cleanup.finalCount).toBe(0);
    expect(fake.computers.size).toBe(0);
    expect((await recoveryAt(dir)).created).toContain(forkId);
  });

  it.each([1, 4, Infinity])(
    "recovers an auto-named fork after a dropped response and %s hidden inventory reads",
    async (hiddenReads) => {
      const fake = fakeOrgo({ scenario: "free-fork-open" });
      let forkId: string | undefined;
      let reads = 0;
      const request: typeof fetch = async (input, init) => {
        const response = await fake.request(input, init);
        const call = fake.calls.at(-1) ?? "";
        if (call.endsWith("/fork")) {
          forkId = String(object(await response.json()).id);
          throw new Error("dropped fork response after allocation");
        }
        if (forkId && call.startsWith("GET /api/workspaces/") && ++reads <= hiddenReads) {
          const workspace = object(await response.json());
          if (!Array.isArray(workspace.desktops)) throw new Error("Missing fake inventory");
          workspace.desktops = workspace.desktops.filter(
            (computer) => object(computer).id !== forkId,
          );
          return new Response(JSON.stringify(workspace));
        }
        return response;
      };
      const dir = await newOut();
      const raw = await runFake(dir, { ...fake, request });
      expect(raw.errors.join()).toMatch(/failed before a response/);
      expect(forkId).toBeDefined();
      const original = await recoveryAt(dir);
      expect(original.baseline).toEqual([]);
      expect(original.created).toHaveLength(Number.isFinite(hiddenReads) ? 2 : 1);
      if (hiddenReads === 1) {
        expect(raw.cleanup.finalCount).toBe(0);
        expect(fake.computers.size).toBe(0);
      } else {
        expect(fake.computers.get(forkId ?? "")?.name).toMatch(/\(fork\)/);
        if (hiddenReads === 4) expect(raw.cleanup.finalCount).toBe(1);
        const evidence = await readFile(join(dir, "raw.json"), "utf8");
        const recovered = await main(["cleanup", "--dry-run", "--out", dir], { fake: () => fake });
        expect(recovered.cleanup.finalCount).toBe(0);
        expect(fake.computers.size).toBe(0);
        expect(await recoveryAt(dir)).toMatchObject({
          baseline: [],
          created: [...new Set([...original.created, forkId])],
        });
        expect(await readFile(join(dir, "raw.json"), "utf8")).toBe(evidence);
      }
    },
  );

  it("protects the original inventory and deletes recorded IDs even when inventory omits them", async () => {
    const fake = fakeOrgo({ scenario: "free-fork-open" });
    const workspaceId = "00000000-0000-4000-8000-000000000001";
    const base = await fake.request("https://www.orgo.ai/api/computers", {
      method: "POST",
      body: JSON.stringify({
        name: "myco-discovery-preexisting",
        os: "linux",
        cpu: 2,
        ram: 8,
        billing_mode: "hourly",
        ends_in_hours: 1,
      }),
    });
    const baseId = String(object(await base.json()).id);
    const fork = await fake.request(`https://www.orgo.ai/api/computers/${baseId}/fork`, {
      method: "POST",
    });
    const forkId = String(object(await fork.json()).id);
    const dir = await newOut();
    const journal = {
      version: 1,
      workspaceId,
      dryRun: true,
      baseline: [baseId],
      created: [forkId],
    };
    await writeFile(join(dir, "recovery.local.json"), JSON.stringify(journal));
    const request: typeof fetch = async (input, init) => {
      if (String(input).includes("/credits")) throw new Error("billing connection unavailable");
      const reply = await fake.request(input, init);
      if (fake.calls.at(-1) === `GET /api/workspaces/${workspaceId}`) {
        return new Response(
          JSON.stringify({ desktops: [{ id: baseId, name: "myco-discovery-preexisting" }] }),
        );
      }
      return reply;
    };
    await main(["cleanup", "--dry-run", "--out", dir], { fake: () => ({ ...fake, request }) });
    expect([...fake.computers.keys()]).toEqual([baseId]);
    expect(await recoveryAt(dir)).toEqual(journal);
  });

  it.each([{ cpu: 2, ram: 8 }, { cpu: 2 }, { cpu: 0.5, ram: 4 }])(
    "requires a complete Medium detail when create omits the size (%j)",
    async (reportedSize) => {
      const fake = fakeOrgo({ scenario: "free" });
      let sizeReported = false;
      const request: typeof fetch = async (input, init) => {
        const response = await fake.request(input, init);
        const call = fake.calls.at(-1) ?? "";
        if (call === "POST /api/computers") {
          const { id } = object(await response.json());
          return new Response(JSON.stringify({ id }), { status: 201 });
        }
        if (!sizeReported && call.startsWith("GET /api/computers/")) {
          sizeReported = true;
          return new Response(JSON.stringify({ status: "running", ...reportedSize }));
        }
        return response;
      };
      const raw = await runFake(await newOut(), { ...fake, request });
      expect(raw.cleanup.finalCount).toBe(0);
      if (reportedSize.ram === 8) {
        expect(raw.errors).toEqual([]);
        expect(raw.experiments.E0?.observations[0]).toMatchObject({
          sizeSource: "computer detail",
        });
      } else {
        expect(raw.errors.join()).toMatch(/Could not confirm Medium/);
        expect(raw.experiments.E1).toBeUndefined();
        expect(fake.calls.some((call) => call.endsWith("/bash"))).toBe(false);
      }
    },
  );

  it.each(["create balance", "E0 running poll", "E5 detail"])(
    "aborts an in-flight %s at the experiment deadline and still cleans up",
    async (target) => {
      const fake = fakeOrgo({ scenario: "free" });
      let stalled: AbortSignal | null | undefined;
      const request: typeof fetch = async (input, init) => {
        const reply = await fake.request(input, init);
        const call = fake.calls.at(-1) ?? "";
        const created = fake.calls.includes("POST /api/computers");
        const poll = call.startsWith("GET /api/computers/");
        if (
          !stalled &&
          created &&
          ((target === "create balance" && call === "GET /api/credits") ||
            (target === "E0 running poll" && poll) ||
            (target === "E5 detail" &&
              poll &&
              fake.calls.some((call) => call.endsWith("/suspend"))))
        ) {
          stalled = init?.signal;
          // Ignore AbortSignal to model a transport with a stalled request/body.
          if (target === "create balance") return new Response(new ReadableStream());
          return new Promise<Response>(() => {});
        }
        return reply;
      };
      const dir = await newOut();
      const raw = await runFake(dir, { ...fake, request }, ["--deadline-ms", "450"]);
      expect(stalled).toMatchObject({ aborted: true });
      expect(raw.errors.join()).toMatch(/run bound/);
      expect(raw.experiments.E5?.n ?? 0).toBe(0);
      expect(raw.cleanup.finalCount).toBe(0);
      expect(fake.computers.size).toBe(0);
      if (target === "create balance") expect((await recoveryAt(dir)).created).toHaveLength(1);
    },
  );

  it("bounds cleanup independently and can retry from the journal after it times out", async () => {
    const fake = fakeOrgo({ scenario: "free" });
    let stalled: AbortSignal | null | undefined;
    const request: typeof fetch = async (input, init) => {
      if (init?.method === "DELETE") {
        stalled = init.signal;
        return new Promise<Response>(() => {});
      }
      return fake.request(input, init);
    };
    const dir = await newOut();
    const raw = await main(["run", "--dry-run", "--out", dir], {
      fake: () => ({ ...fake, request }),
      cleanupDeadlineMs: 50,
    });
    expect(stalled).toMatchObject({ aborted: true });
    expect(raw.errors.join()).toMatch(/could not verify an empty workspace/);
    expect(fake.computers.size).toBe(1);
    const recovered = await main(["cleanup", "--dry-run", "--out", dir], { fake: () => fake });
    expect(recovered.cleanup.finalCount).toBe(0);
    expect(fake.computers.size).toBe(0);
  });
});
