/**
 * TIF-266 (M2-03, R4) — verdict-integrity isolation test. Runs in CI, no VM.
 *
 * A simulated agent fails the calc-record-edit task (it types the wrong value), then tries
 * every tampering route to turn that into `verified`. The simulation assumes the worst
 * case: the agent has host file access (as if the tool-surface audit had failed), so each
 * route is a direct file write. The gate must never return `verified`, and each route must
 * be caught by the specific check named in the test (the mutation proofs in the PR disable
 * each check and watch the matching test fail).
 *
 * The oracle is the real M1 calc-record-edit verifier, fed only from the vault.
 */

import { createHash, createHmac } from "node:crypto";
import {
  chmodSync,
  cpSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readCsvSpreadsheet } from "../../src/core/filepersist.ts";
import type { Verdict } from "../../src/core/verify.ts";
import {
  gatedVerdict,
  gateForTrial,
  integrityReasons,
  type SealedOracle,
} from "../../src/integrity/gate.ts";
import { appendChainedRow, checkChainedLedger } from "../../src/integrity/ledger.ts";
import {
  AUDIT_WITHOUT_RECEIPT,
  canonical,
  newVaultKey,
  type SealReceipt,
  VaultError,
  VerdictVault,
} from "../../src/integrity/vault.ts";
import { calcRecordEditVerifier, intentFor } from "../../src/tasks/calc-record-edit.ts";
import { generateFixture } from "../../src/tasks/fixture.ts";
import {
  type CalcRecordEditParams,
  generateParameterSets,
  groundTruth,
} from "../../src/tasks/intent.ts";

const ROOT = join(import.meta.dirname, "..", "..");
const WRONG = "WRONG-VALUE";

let base: string;
let key: Uint8Array;
let vault: VerdictVault;
let agentWork: string;
let runsDir: string;
let vaultRoot: string;
let oracleSources: string[];
const params: CalcRecordEditParams = generateParameterSets(["tif-266-isolation"])[0]!;

/** The fixture CSV with the target cell set to `value`: what the app saves. */
function savedCsv(value: string): string {
  const fx = generateFixture(params.fixtureSeed);
  const gt = groundTruth(params);
  const rows = fx.rows.map((r) => [...r]);
  rows[gt.location.dataRowIndex]![gt.location.colIndex] = value;
  return `${[fx.header, ...rows].map((r) => r.join(",")).join("\n")}\n`;
}

/** The gate's oracle: M1's verifier over vault bytes, intent built from the sealed params. */
const oracle: SealedOracle = (inputs) => {
  const sealed = inputs.groundTruth as CalcRecordEditParams;
  const bytes = inputs.persisted["output.csv"];
  if (!bytes) return { status: "uncertain", reasons: ["could not look: no persisted output"] };
  const scratch = mkdtempSync(join(base, "oracle-read-"));
  const path = join(scratch, "output.csv");
  writeFileSync(path, bytes);
  return calcRecordEditVerifier.verify(readCsvSpreadsheet(path), intentFor(sealed));
};

interface Ctx {
  runId: string;
  runDir: string;
  receipt: SealReceipt;
}

/** Overwrite a read-only vault file and put the read-only mode back, as a careful attacker would. */
function overwrite(path: string, content: string | Uint8Array): void {
  chmodSync(path, 0o600);
  writeFileSync(path, content);
  chmodSync(path, 0o400);
}

function seal(runId: string, gt: CalcRecordEditParams = params): SealReceipt {
  return vault.seal(runId, {
    groundTruth: gt,
    fixtures: { "fixture.csv": Buffer.from(generateFixture(gt.fixtureSeed).csv) },
    oracle: { id: "calc-record-edit@m1", sourceFiles: oracleSources },
  });
}

/**
 * One gated trial: seal → stage → agent acts (writes `agentValue`, then `duringAgent`) →
 * stop → capture → `afterCapture` → gate.
 */
function trial(opts: {
  agentValue: string;
  duringAgent?: (ctx: Ctx) => void;
  afterCapture?: (ctx: Ctx) => void;
  useReceipt?: boolean;
  runId?: string;
}): { verdict: Verdict; ctx: Ctx } {
  const runId = opts.runId ?? "run-1";
  const receipt = seal(runId);
  const ctx: Ctx = { runId, runDir: join(vaultRoot, runId), receipt };
  writeFileSync(join(agentWork, "fixture.csv"), generateFixture(params.fixtureSeed).csv);
  // The agent's turn.
  writeFileSync(join(agentWork, "output.csv"), savedCsv(opts.agentValue));
  opts.duringAgent?.(ctx);
  // The harness, after the agent has stopped. A refusal here (the vault already
  // looks tampered) is left for the gate to report.
  try {
    vault.markAgentStopped(runId);
    const evidence: Record<string, Uint8Array> = {
      "persisted/output.csv": readFileSync(join(agentWork, "output.csv")),
    };
    for (const name of ["result.json", "trace.jsonl"]) {
      try {
        evidence[name] = readFileSync(join(runsDir, runId, name));
      } catch {
        // nothing written: nothing to capture
      }
    }
    vault.capture(runId, evidence);
  } catch (e) {
    if (!(e instanceof VaultError)) throw e;
  }
  opts.afterCapture?.(ctx);
  const verdict =
    opts.useReceipt === false ? auditVerdict(runId) : gatedVerdict(vault, runId, receipt, oracle);
  return { verdict, ctx };
}

/** The offline-audit path (no receipt): isolates the checks the receipt would also catch. */
function auditVerdict(runId: string): Verdict {
  const opened = vault.openVerdictInputs(runId, AUDIT_WITHOUT_RECEIPT);
  return opened.ok
    ? oracle(opened.inputs)
    : { status: "uncertain", reasons: integrityReasons(opened.violations) };
}

function expectIntegrity(verdict: Verdict, code: string): void {
  expect(verdict.status).toBe("uncertain");
  expect(verdict.reasons.some((r) => r.startsWith(`integrity:${code}`))).toBe(true);
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "myco-tif266-"));
  agentWork = join(base, "agent-work");
  runsDir = join(base, "runs");
  vaultRoot = join(base, "vault");
  mkdirSync(agentWork);
  mkdirSync(runsDir);
  // Copies of the real oracle sources, so the oracle-edit route never touches the repo.
  const oracleDir = join(base, "oracle-src");
  mkdirSync(oracleDir);
  oracleSources = ["src/tasks/calc-record-edit.ts", "src/tasks/intent.ts"].map((rel) => {
    const dst = join(oracleDir, rel.split("/").pop()!);
    cpSync(join(ROOT, rel), dst);
    return dst;
  });
  key = newVaultKey();
  vault = new VerdictVault({ root: vaultRoot, key, agentRoots: [agentWork, runsDir] });
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("baselines (no tampering)", () => {
  it("an honest correct run is verified", () => {
    expect(trial({ agentValue: params.newValue }).verdict.status).toBe("verified");
  });

  it("an honest wrong run is refuted", () => {
    expect(trial({ agentValue: WRONG }).verdict.status).toBe("refuted");
  });
});

describe("tampering routes: the gate never returns verified", () => {
  it("overwriting the sealed fixture is caught by its hash", () => {
    const { verdict } = trial({
      agentValue: WRONG,
      duringAgent: (c) => overwrite(join(c.runDir, "sealed/fixtures/fixture.csv"), savedCsv(WRONG)),
    });
    expectIntegrity(verdict, "sealed-file-hash");
  });

  it("overwriting the agent-side fixture copy cannot reach the oracle", () => {
    const { verdict } = trial({
      agentValue: WRONG,
      duringAgent: () => writeFileSync(join(agentWork, "fixture.csv"), savedCsv(WRONG)),
    });
    expect(verdict.status).toBe("refuted");
  });

  it("editing the expected value in the sealed ground truth is caught by its hash", () => {
    const { verdict } = trial({
      agentValue: WRONG,
      duringAgent: (c) =>
        overwrite(
          join(c.runDir, "sealed/ground-truth.json"),
          `${JSON.stringify({ ...params, newValue: WRONG })}\n`,
        ),
    });
    expectIntegrity(verdict, "sealed-file-hash");
  });

  it("editing the expected value and its manifest hash is caught by the seal MAC", () => {
    const { verdict } = trial({
      agentValue: WRONG,
      useReceipt: false,
      duringAgent: (c) => forgeGroundTruthAndManifest(c, WRONG),
    });
    expectIntegrity(verdict, "seal-signature");
  });

  it("with a leaked key, a re-signed seal is caught by the in-memory receipt", () => {
    const { verdict } = trial({
      agentValue: WRONG,
      duringAgent: (c) => forgeGroundTruthAndManifest(c, WRONG, key),
    });
    expectIntegrity(verdict, "receipt-mismatch");
  });

  it("replaying another run's seal is caught by the run id", () => {
    seal("run-0", { ...params, newValue: WRONG });
    const { verdict } = trial({
      agentValue: WRONG,
      useReceipt: false,
      duringAgent: (c) => {
        for (const rel of ["seal.json", "sealed/ground-truth.json", "sealed/fixtures/fixture.csv"])
          overwrite(join(c.runDir, rel), readFileSync(join(vaultRoot, "run-0", rel)));
      },
    });
    expectIntegrity(verdict, "seal-malformed");
  });

  it("replaying an earlier honest run's stop marker and capture is caught by the seal binding", () => {
    trial({ agentValue: params.newValue, runId: "run-0" });
    const { verdict } = trial({
      agentValue: WRONG,
      afterCapture: (c) => {
        for (const rel of ["stop.json", "capture.json", "captured/persisted/output.csv"])
          overwrite(join(c.runDir, rel), readFileSync(join(vaultRoot, "run-0", rel)));
      },
    });
    expectIntegrity(verdict, "stop-signature");
  });

  it("replaying an earlier honest run's capture is caught by the stop binding", () => {
    trial({ agentValue: params.newValue, runId: "run-0" });
    const { verdict } = trial({
      agentValue: WRONG,
      afterCapture: (c) => {
        for (const rel of ["capture.json", "captured/persisted/output.csv"])
          overwrite(join(c.runDir, rel), readFileSync(join(vaultRoot, "run-0", rel)));
      },
    });
    expectIntegrity(verdict, "capture-signature");
  });

  it("writing result.json and trace.jsonl claiming success cannot raise the verdict", () => {
    let inputsSeen: string[] = [];
    const { verdict, ctx } = trial({
      agentValue: WRONG,
      duringAgent: (c) => {
        mkdirSync(join(runsDir, c.runId), { recursive: true });
        writeFileSync(
          join(runsDir, c.runId, "result.json"),
          JSON.stringify({ verdict: { status: "verified", reasons: ["agent says so"] } }),
        );
        writeFileSync(
          join(runsDir, c.runId, "trace.jsonl"),
          '{"kind":"verdict","status":"verified"}\n',
        );
      },
    });
    expect(verdict.status).toBe("refuted");
    const opened = vault.openVerdictInputs(ctx.runId, ctx.receipt);
    if (opened.ok) inputsSeen = Object.keys(opened.inputs.persisted);
    expect(inputsSeen).toEqual(["output.csv"]);
  });

  it("dropping a forged result.json into the vault is caught as an unexpected file", () => {
    const { verdict } = trial({
      agentValue: WRONG,
      afterCapture: (c) =>
        writeFileSync(join(c.runDir, "result.json"), JSON.stringify({ status: "verified" })),
    });
    expectIntegrity(verdict, "unexpected-file");
  });

  it("overwriting the captured output with a correct one is caught by its hash", () => {
    const { verdict } = trial({
      agentValue: WRONG,
      afterCapture: (c) =>
        overwrite(join(c.runDir, "captured/persisted/output.csv"), savedCsv(params.newValue)),
    });
    expectIntegrity(verdict, "captured-file-hash");
  });

  it("overwriting a captured trace is caught by its hash", () => {
    const { verdict } = trial({
      agentValue: WRONG,
      duringAgent: (c) => {
        mkdirSync(join(runsDir, c.runId), { recursive: true });
        writeFileSync(join(runsDir, c.runId, "trace.jsonl"), '{"kind":"observation"}\n');
      },
      afterCapture: (c) =>
        overwrite(
          join(c.runDir, "captured/trace.jsonl"),
          '{"kind":"verdict","status":"verified"}\n',
        ),
    });
    expectIntegrity(verdict, "captured-file-hash");
  });

  it("swapping the captured output for a symlink is refused", () => {
    const { verdict } = trial({
      agentValue: WRONG,
      afterCapture: (c) => {
        const good = join(agentWork, "good.csv");
        writeFileSync(good, savedCsv(params.newValue));
        const target = join(c.runDir, "captured/persisted/output.csv");
        rmSync(target);
        symlinkSync(good, target);
      },
    });
    expectIntegrity(verdict, "captured-file-not-regular");
  });

  it("making a sealed file writable is caught even with unchanged content", () => {
    const { verdict } = trial({
      agentValue: params.newValue,
      duringAgent: (c) => chmodSync(join(c.runDir, "sealed/ground-truth.json"), 0o600),
    });
    expectIntegrity(verdict, "sealed-file-writable");
  });

  it("opening up the vault directory's permissions is caught", () => {
    const { verdict } = trial({
      agentValue: params.newValue,
      duringAgent: (c) => chmodSync(c.runDir, 0o755),
    });
    expectIntegrity(verdict, "vault-permissions");
  });

  it("editing the oracle's source is caught by its hash", () => {
    const { verdict } = trial({
      agentValue: WRONG,
      duringAgent: () =>
        writeFileSync(
          oracleSources[0]!,
          `${readFileSync(oracleSources[0]!, "utf8")}\n// patched\n`,
        ),
    });
    expectIntegrity(verdict, "oracle-source-hash");
  });

  it("deleting the stop marker after capture is caught", () => {
    const { verdict } = trial({
      agentValue: WRONG,
      afterCapture: (c) => rmSync(join(c.runDir, "stop.json")),
    });
    expectIntegrity(verdict, "agent-not-stopped");
  });

  it("deleting the capture manifest is caught", () => {
    const { verdict } = trial({
      agentValue: WRONG,
      afterCapture: (c) => rmSync(join(c.runDir, "capture.json")),
    });
    expectIntegrity(verdict, "capture-missing");
  });

  it("a forged capture manifest (no key) is caught by its MAC", () => {
    const { verdict } = trial({
      agentValue: WRONG,
      afterCapture: (c) => {
        const out = join(c.runDir, "captured/persisted/output.csv");
        overwrite(out, savedCsv(params.newValue));
        const manifest = JSON.parse(readFileSync(join(c.runDir, "capture.json"), "utf8"));
        manifest.files["captured/persisted/output.csv"] = sha256(savedCsv(params.newValue));
        overwrite(join(c.runDir, "capture.json"), `${JSON.stringify(manifest)}\n`);
      },
    });
    expectIntegrity(verdict, "capture-signature");
  });

  it("a forged stop marker (no key) is caught by its MAC", () => {
    const receipt = seal("run-1");
    const runDir = join(vaultRoot, "run-1");
    writeFileSync(
      join(runDir, "stop.json"),
      JSON.stringify({ runId: "run-1", mac: "00".repeat(32) }),
    );
    // The harness cannot write its own marker over the planted one, and refuses to capture.
    expect(() => vault.markAgentStopped("run-1")).toThrow();
    expect(() => vault.capture("run-1", { "persisted/output.csv": Buffer.from("x") })).toThrow(
      VaultError,
    );
    expectIntegrity(gatedVerdict(vault, "run-1", receipt, oracle), "stop-signature");
  });

  it("the harness refuses to capture before the agent stopped", () => {
    const receipt = seal("run-1");
    expect(() => vault.capture("run-1", { "persisted/output.csv": Buffer.from("x") })).toThrow(
      /not-stopped/,
    );
    expectIntegrity(gatedVerdict(vault, "run-1", receipt, oracle), "agent-not-stopped");
  });

  it("a hard link to a captured file held by the agent is refused", () => {
    const { verdict } = trial({
      agentValue: WRONG,
      afterCapture: (c) =>
        linkSync(join(c.runDir, "captured/persisted/output.csv"), join(agentWork, "held.csv")),
    });
    expectIntegrity(verdict, "captured-file-not-regular");
  });

  it("a hard link to the sealed ground truth held by the agent is refused", () => {
    const { verdict } = trial({
      agentValue: WRONG,
      duringAgent: (c) =>
        linkSync(join(c.runDir, "sealed/ground-truth.json"), join(agentWork, "gt.json")),
    });
    expectIntegrity(verdict, "sealed-file-not-regular");
  });

  it.runIf(process.platform === "darwin")(
    "a vault root differing from an agent root only in case is refused on macOS",
    () => {
      expect(
        () =>
          new VerdictVault({
            root: join(agentWork.toUpperCase(), "vault"),
            key,
            agentRoots: [agentWork],
          }),
      ).toThrow(/reachable/);
    },
  );

  it("a vault inside an agent-reachable root is refused at construction", () => {
    expect(
      () => new VerdictVault({ root: join(agentWork, "vault"), key, agentRoots: [agentWork] }),
    ).toThrow(/reachable/);
    expect(() => new VerdictVault({ root: base, key, agentRoots: [agentWork] })).toThrow(
      /reachable/,
    );
  });
});

describe("the gate binds the agent's run id to its own trial (V5)", () => {
  it("an agent naming an earlier honest run gets uncertain, not that run's verified", () => {
    const honest = trial({ agentValue: params.newValue, runId: "run-0" });
    expect(honest.verdict.status).toBe("verified");
    const { ctx } = trial({ agentValue: WRONG, runId: "run-1" });
    // The gate holds run-1's binding (operator-pinned); the agent asks about run-0.
    const binding = { runId: "run-1", receipt: ctx.receipt };
    const v = gateForTrial(vault, binding, "run-0", oracle);
    expectIntegrity(v, "run-not-bound");
    expect(gateForTrial(vault, binding, "run-1", oracle).status).toBe("refuted");
  });

  it("run-1's receipt does not open run-0", () => {
    trial({ agentValue: params.newValue, runId: "run-0" });
    const { ctx } = trial({ agentValue: WRONG, runId: "run-1" });
    expectIntegrity(gatedVerdict(vault, "run-0", ctx.receipt, oracle), "receipt-mismatch");
  });

  it("a missing receipt is refused at runtime, not treated as an audit", () => {
    trial({ agentValue: params.newValue, runId: "run-0" });
    const v = gatedVerdict(vault, "run-0", undefined as unknown as SealReceipt, oracle);
    expectIntegrity(v, "receipt-missing");
    // @ts-expect-error: the receipt is a required parameter.
    expect(gatedVerdict(vault, "run-0", undefined, oracle).status).toBe("uncertain");
  });
});

describe("ledger rows", () => {
  function ledger(): { path: string; head: string } {
    const path = join(base, "ledger.jsonl");
    let head = "";
    for (const [runId, status] of [
      ["run-1", "verified"],
      ["run-2", "refuted"],
      ["run-3", "uncertain"],
    ] as const)
      head = appendChainedRow(path, key, "eval-a", { runId, gateVerdict: status });
    return { path, head };
  }
  const verifiedRuns = (rows: Record<string, unknown>[]) =>
    rows.filter((r) => r.gateVerdict === "verified").map((r) => r.runId);

  it("an untouched ledger verifies", () => {
    const { path, head } = ledger();
    const check = checkChainedLedger(path, key, "eval-a", head);
    expect(check.ok).toBe(true);
    expect(verifiedRuns(check.rows)).toEqual(["run-1"]);
  });

  it("editing a row's verdict to verified is caught and the row is not counted", () => {
    const { path, head } = ledger();
    writeFileSync(
      path,
      readFileSync(path, "utf8").replace('"gateVerdict":"refuted"', '"gateVerdict":"verified"'),
    );
    const check = checkChainedLedger(path, key, "eval-a", head);
    expect(check.ok).toBe(false);
    expect(check.violations[0]?.detail).toMatch(/MAC/);
    expect(verifiedRuns(check.rows)).toEqual(["run-1"]);
  });

  it("deleting a row is caught", () => {
    const { path, head } = ledger();
    const lines = readFileSync(path, "utf8").split("\n");
    writeFileSync(path, [lines[0], lines[2], ""].join("\n"));
    const check = checkChainedLedger(path, key, "eval-a", head);
    expect(check.ok).toBe(false);
    expect(check.violations[0]?.detail).toMatch(/prev/);
  });

  it("truncating the tail is caught against the kept head", () => {
    const { path, head } = ledger();
    const lines = readFileSync(path, "utf8").split("\n");
    writeFileSync(path, [lines[0], lines[1], ""].join("\n"));
    expect(checkChainedLedger(path, key, "eval-a", head).ok).toBe(false);
  });

  it("a row re-signed without the key is caught", () => {
    const { path } = ledger();
    const other = newVaultKey();
    const forged = join(base, "forged.jsonl");
    appendChainedRow(forged, other, "eval-a", { runId: "run-2", gateVerdict: "verified" });
    expect(checkChainedLedger(forged, key, "eval-a").ok).toBe(false);
    expect(checkChainedLedger(path, key, "eval-a").ok).toBe(true);
  });

  it("a whole ledger copied under another ledger id is caught", () => {
    const { path } = ledger();
    const copy = join(base, "eval-b.jsonl");
    writeFileSync(copy, readFileSync(path));
    const check = checkChainedLedger(copy, key, "eval-b");
    expect(check.ok).toBe(false);
    expect(check.rows).toEqual([]);
  });
});

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Rewrite the ground truth and the seal manifest's hash for it; re-sign only if given a key. */
function forgeGroundTruthAndManifest(c: Ctx, value: string, leakedKey?: Uint8Array): void {
  const gtText = `${canonical({ ...params, newValue: value })}\n`;
  overwrite(join(c.runDir, "sealed/ground-truth.json"), gtText);
  const manifest = JSON.parse(readFileSync(join(c.runDir, "seal.json"), "utf8"));
  manifest.files["sealed/ground-truth.json"] = sha256(gtText);
  if (leakedKey) {
    const { mac: _old, ...body } = manifest;
    manifest.mac = createHmac("sha256", leakedKey).update(canonical(body)).digest("hex");
  }
  overwrite(join(c.runDir, "seal.json"), `${canonical(manifest)}\n`);
}
