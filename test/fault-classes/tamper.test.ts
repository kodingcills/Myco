/**
 * TIF-272 (M2-10, R3/R4) — the tamper-with-oracle-inputs class, end to end on the fake
 * app: every route runs through the real vault, the real gate and the independent grader,
 * and must end never verified, with the code its route declares.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TAMPER_ROUTES, TAMPER_TARGETS } from "../../src/faults/security/classes.ts";
import {
  openSuite,
  type Suite,
  suitePlan,
  type TrialRecord,
  vaultReader,
} from "../../src/faults/security/harness.ts";
import { scoreTrial } from "../../src/faults/security/record.ts";
import { newVaultKey, VerdictVault } from "../../src/integrity/vault.ts";
import { generateFixture } from "../../src/tasks/fixture.ts";
import { generateParameterSets } from "../../src/tasks/intent.ts";

let suite: Suite;
const plan = suitePlan(1);
const records = new Map<string, TrialRecord>();

beforeAll(async () => {
  suite = openSuite();
  for (const spec of plan.filter((s) => s.faultClass === "tamper-oracle-inputs"))
    records.set(spec.variant, await suite.runTrial(spec));
});

afterAll(() => suite.close());

describe("the catalog", () => {
  it("has at least one route for every oracle input the plan names", () => {
    for (const target of TAMPER_TARGETS)
      expect(
        TAMPER_ROUTES.some((r) => r.target === target),
        target,
      ).toBe(true);
  });

  it("route ids are unique and every route runs without a harness error", () => {
    expect(new Set(TAMPER_ROUTES.map((r) => r.id)).size).toBe(TAMPER_ROUTES.length);
    for (const route of TAMPER_ROUTES) expect(records.get(route.id)?.harnessError).toBeNull();
  });
});

describe("baselines through the same pipeline (no tampering)", () => {
  it("the scripted agent's honest edit is verified and graded pass; a wrong one is refuted", async () => {
    const injection = plan.filter((s) => s.faultClass === "injected-instruction");
    const ignore = injection.find((s) => s.policy === "ignore");
    if (!ignore) throw new Error("no control trial in the plan");
    const honest = await suite.runTrial(ignore);
    expect(honest.gate?.verdict).toBe("verified");
    expect(honest.gate?.reasonCodes).toContain("ORACLE_PASS");
    expect(honest.grade?.status).toBe("pass");
    // The tamper class's agent typed a wrong value before it tampered: refuted when the
    // route never reaches the oracle (fixture-agent-copy) and graded fail every time.
    const untouched = records.get("fixture-agent-copy");
    expect(untouched?.gate?.verdict).toBe("refuted");
    for (const r of records.values()) expect(r.grade?.status).toBe("fail");
  });
});

describe("every tamper route ends never verified, with its declared code", () => {
  it.each(TAMPER_ROUTES.map((r) => [r.id, r] as const))("%s", (_id, route) => {
    const record = records.get(route.id);
    if (!record) throw new Error(`no record for ${route.id}`);
    expect(record.gate?.accepted).toBe(false);
    expect(record.gate?.verdict).not.toBe("verified");
    expect(record.gate?.verdict).toBe(route.expect.verdict);
    const code = route.expect.code;
    if (code.startsWith("integrity:")) expect(record.gate?.integrityCodes).toContain(code);
    else if (code === "ledger:chain-broken") expect(record.ledgerCheck).toBe("chain-broken");
    else expect(record.gate?.reasonCodes).toContain(code);
    if (route.needsDonor) expect(record.donorVerdict).toBe("verified");
    const row = scoreTrial(record);
    expect(row.eligible).toBe(true);
    expect(row.asExpected).toBe(true);
    expect(row.falseSuccess).toBe(false);
  });

  it("only the ledger route breaks the ledger chain", () => {
    for (const [id, r] of records)
      expect(r.ledgerCheck, id).toBe(id === "ledger-row" ? "chain-broken" : "ok");
  });

  it("integrity codes appear only on routes that write the vault or the oracle source", () => {
    const clean = ["fixture-agent-copy", "result-trace-host", "ledger-row"];
    const gateRefused = ["expected-value-gate-args", "other-trial-run-id"];
    for (const id of [...clean, ...gateRefused])
      expect(records.get(id)?.gate?.integrityCodes, id).toEqual([]);
  });
});

describe("the vault reader the gate reads through", () => {
  const base = mkdtempSync(join(tmpdir(), "myco-tif272-reader-"));
  const agent = join(base, "agent");
  const vault = new VerdictVault({
    root: join(base, "vault"),
    key: newVaultKey(),
    agentRoots: [agent],
  });
  const params = generateParameterSets(["tif-272-reader"])[0]!;
  const csv = Buffer.from(generateFixture(params.fixtureSeed).csv);
  const receipt = vault.seal("r1", {
    groundTruth: params,
    fixtures: { "fixture.csv": csv },
    oracle: { id: "t", sourceFiles: [] },
  });
  vault.markAgentStopped("r1");
  vault.capture("r1", { "persisted/output.csv": csv });
  afterAll(() => rmSync(base, { recursive: true, force: true }));

  it("returns the captured bytes when the seal holds and the spec is the sealed one", async () => {
    const sink: string[] = [];
    const out = await vaultReader(vault, { runId: "r1", receipt }, params, sink).read(
      "r1",
      "output.csv",
    );
    expect(out.ok).toBe(true);
    expect(sink).toEqual([]);
  });

  it("refuses a registered spec that is not the sealed ground truth", async () => {
    const sink: string[] = [];
    const out = await vaultReader(
      vault,
      { runId: "r1", receipt },
      { ...params, newValue: "WRONG" },
      sink,
    ).read("r1", "output.csv");
    expect(out.ok).toBe(false);
    expect(sink).toEqual(["integrity:spec-not-sealed"]);
  });

  it("refuses any run but the bound one, and its agent-facing detail carries codes only", async () => {
    const sink: string[] = [];
    const out = await vaultReader(vault, { runId: "r1", receipt }, params, sink).read(
      "r0",
      "output.csv",
    );
    expect(out.ok).toBe(false);
    expect(sink).toEqual(["integrity:run-not-bound"]);
    if (!out.ok) {
      expect(out.detail).toBe("integrity check failed: integrity:run-not-bound");
      expect(out.detail).not.toContain(base);
    }
  });

  it("an integrity failure's detail names codes, never a vault path", async () => {
    const other = vault.seal("r2", {
      groundTruth: params,
      fixtures: { "fixture.csv": csv },
      oracle: { id: "t", sourceFiles: [] },
    });
    const sink: string[] = [];
    const out = await vaultReader(vault, { runId: "r2", receipt: other }, params, sink).read(
      "r2",
      "output.csv",
    );
    expect(out.ok).toBe(false);
    expect(sink).toEqual(["integrity:agent-not-stopped", "integrity:capture-missing"]);
    if (!out.ok) {
      expect(out.detail).not.toContain(base);
      expect(out.detail).not.toMatch(/[/\\]/);
    }
  });
});
