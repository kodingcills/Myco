/**
 * TIF-270 round 3, ruling D1(a), on the operator path the fault suite uses: the harness
 * seals the fixture the guest was given in TIF-266's vault and registers its digest in the
 * gate spec (`gateSpecFor`); the gate reads the sealed bytes through the vault reader. A
 * cell-site injection's honest control is verified on the document the guest got; a fixture
 * swapped after sealing, or a spec digest that does not match the sealed bytes, is refused.
 */
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { type ColumnType, grade } from "../../src/benchmark/grade/grade.ts";
import {
  gateSpecFor,
  injectedFixtureCsv,
  injectionFor,
  SEALED_FIXTURE_FILE,
  SUITE_TASK_ID,
  vaultReader,
} from "../../src/faults/security/harness.ts";
import { buildRegistry, createGate } from "../../src/gate/gate.ts";
import { canonical, newVaultKey, VerdictVault } from "../../src/integrity/vault.ts";
import { FIXTURE_COLUMNS, generateFixture } from "../../src/tasks/fixture.ts";
import { generateParameterSets, groundTruth } from "../../src/tasks/intent.ts";

const sha256 = (b: string | Uint8Array) => createHash("sha256").update(b).digest("hex");
const COLUMN_TYPES: Record<string, ColumnType> = Object.fromEntries(
  FIXTURE_COLUMNS.map((c) => [c.name, c.type]),
);
const params = generateParameterSets(["tif-270-sealed"])[0]!;
const INJECTED = injectedFixtureCsv(params, injectionFor("no-edit", params));
const PRISTINE = generateFixture(params.fixtureSeed).csv;

function honest(fixture: string): string {
  const { location } = groundTruth(params);
  const rows = fixture
    .trimEnd()
    .split("\n")
    .map((l) => l.split(","));
  (rows[location.dataRowIndex + 1] as string[])[location.colIndex] = params.newValue;
  return `${rows.map((r) => r.join(",")).join("\n")}\n`;
}

describe("gateSpecFor: the operator registers the fixture the guest was given", () => {
  it("the seed's own fixture → the seed-only spec (pristine regenerated from fixtureSeed)", () => {
    expect(gateSpecFor(params, PRISTINE)).toEqual(params);
  });
  it("an injected fixture → the spec names the sealed file and its digest", () => {
    expect(INJECTED).not.toBe(PRISTINE);
    expect(gateSpecFor(params, INJECTED)).toEqual({
      ...params,
      fixtureFile: SEALED_FIXTURE_FILE,
      fixtureSha256: sha256(INJECTED),
    });
  });
});

describe("through the vault", () => {
  const base = mkdtempSync(join(tmpdir(), "myco-tif270-sealed-"));
  const vaultRoot = join(base, "vault");
  const vault = new VerdictVault({
    root: vaultRoot,
    key: newVaultKey(),
    agentRoots: [join(base, "agent")],
  });
  afterAll(() => rmSync(base, { recursive: true, force: true }));

  /** Seal `sealedSpec` + `sealedFixture`, capture `saved`, ask a gate registered with `spec`. */
  async function trial(
    runId: string,
    opts: {
      spec: unknown;
      sealedSpec?: unknown;
      sealedFixture: string;
      saved: string;
      afterSeal?: () => void;
    },
  ) {
    const receipt = vault.seal(runId, {
      groundTruth: opts.sealedSpec ?? opts.spec,
      fixtures: { [SEALED_FIXTURE_FILE]: Buffer.from(opts.sealedFixture) },
      oracle: { id: "t", sourceFiles: [] },
    });
    opts.afterSeal?.();
    vault.markAgentStopped(runId);
    vault.capture(runId, { "persisted/output.csv": Buffer.from(opts.saved) });
    const sink: string[] = [];
    const gate = createGate({
      tasks: buildRegistry([
        { id: SUITE_TASK_ID, family: SUITE_TASK_ID, stateFile: "output.csv", spec: opts.spec },
      ]),
      reader: vaultReader(vault, { runId, receipt }, opts.spec, sink),
      assignment: { taskId: SUITE_TASK_ID, runId },
    });
    return { result: await gate.check({ taskId: SUITE_TASK_ID, runId }), sink };
  }

  it("an honest control on a cell-site injected fixture is verified, and the grader passes it", async () => {
    const saved = honest(INJECTED);
    const { result, sink } = await trial("ok", {
      spec: gateSpecFor(params, INJECTED),
      sealedFixture: INJECTED,
      saved,
    });
    expect(result).toMatchObject({ verdict: "verified", accepted: true });
    expect(result.evidenceRefs.map((r) => r.kind)).toEqual(["persisted-state", "sealed-fixture"]);
    expect(sink).toEqual([]);
    const g = grade({
      fixtureCsv: Buffer.from(INJECTED),
      fixtureSha256: sha256(INJECTED),
      persisted: { format: "csv", bytes: Buffer.from(saved) },
      intent: params,
      columnTypes: COLUMN_TYPES,
    });
    expect(g.status).toBe("pass");
  });

  it("the sealed fixture swapped after sealing is refused (vault integrity), never verified", async () => {
    const { result, sink } = await trial("swapped", {
      spec: gateSpecFor(params, INJECTED),
      sealedFixture: INJECTED,
      saved: honest(PRISTINE),
      afterSeal: () => {
        const path = join(vaultRoot, "swapped", "sealed/fixtures", SEALED_FIXTURE_FILE);
        chmodSync(path, 0o600);
        writeFileSync(path, honest(PRISTINE));
        chmodSync(path, 0o400);
      },
    });
    expect(result).toMatchObject({ verdict: "uncertain", accepted: false });
    expect(result.reasonCodes[0]).toBe("STATE_UNREADABLE");
    expect(sink).toContain("integrity:sealed-file-hash");
  });

  it("the sealed digest rewritten after sealing is refused (vault integrity)", async () => {
    const spec = gateSpecFor(params, INJECTED);
    const { result, sink } = await trial("digest", {
      spec,
      sealedFixture: INJECTED,
      saved: honest(PRISTINE),
      afterSeal: () => {
        const path = join(vaultRoot, "digest", "sealed/ground-truth.json");
        chmodSync(path, 0o600);
        writeFileSync(path, `${canonical({ ...spec, fixtureSha256: sha256(honest(PRISTINE)) })}\n`);
        chmodSync(path, 0o400);
      },
    });
    expect(result.accepted).toBe(false);
    expect(sink).toContain("integrity:sealed-file-hash");
  });

  it("a spec digest that does not match the sealed bytes → FIXTURE_MISMATCH, nothing decided", async () => {
    // The vault holds the seed's pristine fixture, but the spec registered the injected
    // one's digest (the fixture handed to the guest is not the one sealed).
    const { result, sink } = await trial("mismatch", {
      spec: gateSpecFor(params, INJECTED),
      sealedFixture: PRISTINE,
      saved: honest(PRISTINE),
    });
    expect(result).toMatchObject({
      verdict: "uncertain",
      accepted: false,
      reasonCodes: ["FIXTURE_MISMATCH"],
    });
    expect(result.oracle).toBeUndefined();
    expect(sink).toEqual([]);
  });

  it("no injected fixture: the seed-only spec decides from fixtureSeed", async () => {
    const { result } = await trial("seed", {
      spec: gateSpecFor(params, PRISTINE),
      sealedFixture: PRISTINE,
      saved: honest(PRISTINE),
    });
    expect(result).toMatchObject({ verdict: "verified" });
    expect(result.evidenceRefs.map((r) => r.kind)).toEqual(["persisted-state"]);
  });

  // Round-3 nit (V11, follow-up to #485): the gate always calls `read` (which runs the vault's
  // integrity checks) before `readFixture`, so a `readFixture` that skipped them would pass
  // every gate-level test. Pin the reader on its own: it runs the checks itself.
  it("readFixture runs the vault's integrity checks itself, not only through read()", async () => {
    const runId = "fixture-direct";
    const spec = gateSpecFor(params, INJECTED);
    const receipt = vault.seal(runId, {
      groundTruth: spec,
      fixtures: { [SEALED_FIXTURE_FILE]: Buffer.from(INJECTED) },
      oracle: { id: "t", sourceFiles: [] },
    });
    vault.markAgentStopped(runId);
    vault.capture(runId, { "persisted/output.csv": Buffer.from(honest(INJECTED)) });
    const sink: string[] = [];
    const reader = vaultReader(vault, { runId, receipt }, spec, sink);
    const good = await reader.readFixture?.(runId, SEALED_FIXTURE_FILE);
    expect(good?.ok && Buffer.from(good.bytes).toString()).toBe(INJECTED);

    expect(await reader.readFixture?.("other-run", SEALED_FIXTURE_FILE)).toMatchObject({
      ok: false,
    });
    expect(sink).toEqual(["integrity:run-not-bound"]);
    sink.length = 0;

    const path = join(vaultRoot, runId, "sealed/fixtures", SEALED_FIXTURE_FILE);
    chmodSync(path, 0o600);
    writeFileSync(path, PRISTINE);
    chmodSync(path, 0o400);
    const tampered = await reader.readFixture?.(runId, SEALED_FIXTURE_FILE);
    expect(tampered).toMatchObject({ ok: false, cause: "unreadable" });
    expect(sink).toContain("integrity:sealed-file-hash");
  });
});
