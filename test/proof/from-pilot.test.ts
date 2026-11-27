/**
 * Track Q (#674): a proof bundle's input from an R1 pilot run directory. The fixture is a
 * SIMULATED pilot dry run (fake transport, the real gate on a sealed vault, $0, no model, no
 * VM), written by the real runner, once with and once without #518's attempt ledger. Simulated
 * rows are never evidence: these tests show plumbing only.
 */
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { anchorPathFor } from "../../src/m2/attempt-ledger.ts";
import { R1AttemptSink } from "../../src/pilot/ab.ts";
import { fakeDriver, PILOT_DRY_RUN_PLANNER, virtualClock } from "../../src/pilot/dry-run.ts";
import { loadLedger, PROGRESS_FILE } from "../../src/pilot/ledger.ts";
import { HarnessFault, runPilot, SIMULATED_FILE } from "../../src/pilot/runner.ts";
import {
  exportProofBundle,
  ProofExportError,
  serializeProofBundle,
  verifyProofBundle,
} from "../../src/proof/bundle.ts";
import { type CliIo, hostRedaction, main } from "../../src/proof/cli.ts";
import {
  PILOT_ATTEMPTS_FILE,
  PILOT_DOC_FILE,
  PILOT_EVIDENCE,
  PILOT_GATE_TASKS_FILE,
  pilotProofInput,
} from "../../src/proof/from-pilot.ts";
import { sha256Hex } from "../../src/proof/ledger.ts";
import { config, PUBLISHED, ROOT, SOURCES, tmp } from "../pilot/helpers.ts";

/** A small simulated run: the first `n` trials of the reviewed config. */
async function simulatedRun(opts: { n: number; sink: boolean; faultAt?: number }) {
  const parent = tmp("myco-proof-pilot-");
  const dir = join(parent, "run");
  mkdirSync(dir);
  const base = config();
  const clock = virtualClock();
  let calls = 0;
  const result = await runPilot({
    config: { ...base, trials: base.trials.slice(0, opts.n) },
    published: PUBLISHED,
    outDir: dir,
    repoRoot: ROOT,
    oracleSources: SOURCES,
    driver: fakeDriver({
      beforeAgent: () => {
        if (++calls === opts.faultAt)
          throw new HarnessFault("transport-error", "fake transport dropped");
      },
    }),
    plannerModelId: PILOT_DRY_RUN_PLANNER,
    sleep: clock.sleep,
    now: clock.now,
    log: () => {},
    ...(opts.sink ? { attemptSink: new R1AttemptSink(dir) } : {}),
  });
  return { dir, result };
}

/** Every attempt of the run, in ledger order. */
function attemptsOf(dir: string) {
  const state = loadLedger(join(dir, PROGRESS_FILE));
  return [...state.byTask.values()].flat();
}

/** A copy of a run directory with its external anchor beside it, as the harness lays it out. */
function copyRun(dir: string): string {
  const parent = tmp("myco-proof-pilot-copy-");
  const to = join(parent, basename(dir));
  cpSync(dir, to, { recursive: true });
  const anchor = anchorPathFor(dir);
  if (existsSync(anchor)) {
    mkdirSync(dirname(anchorPathFor(to)), { recursive: true });
    cpSync(anchor, anchorPathFor(to));
  }
  return to;
}

const codeOf = (f: () => unknown): string => {
  try {
    f();
  } catch (e) {
    if (e instanceof ProofExportError) return e.code;
    throw e;
  }
  return "no refusal";
};

const messageOf = (f: () => unknown): string => {
  try {
    f();
  } catch (e) {
    return (e as Error).message;
  }
  return "";
};

const exportFrom = (dir: string, key: string) =>
  exportProofBundle(pilotProofInput(dir, key).input, hostRedaction());

let plain: { dir: string; keys: string[] };
let withLedger: { dir: string; keys: string[] };
let faulted: { dir: string; faultedKey: string; ledgerDir: string };

beforeAll(async () => {
  const a = await simulatedRun({ n: 3, sink: false });
  expect(a.result).toMatchObject({ status: "complete", ran: 3 });
  plain = { dir: a.dir, keys: attemptsOf(a.dir).map((r) => r.start.trialKey) };

  const b = await simulatedRun({ n: 3, sink: true });
  expect(b.result).toMatchObject({ status: "complete", ran: 3 });
  withLedger = { dir: b.dir, keys: attemptsOf(b.dir).map((r) => r.start.trialKey) };

  const c = await simulatedRun({ n: 1, sink: false, faultAt: 1 });
  const d = await simulatedRun({ n: 1, sink: true, faultAt: 1 });
  const faultedKey = attemptsOf(c.dir).find((r) => r.end?.outcome === "harness-fault")?.start
    .trialKey as string;
  faulted = { dir: c.dir, faultedKey, ledgerDir: d.dir };
}, 120_000);

describe("a bundle from an R1 pilot run directory (SIMULATED dry run)", () => {
  it("every decided trial exports, and verifies against its trial directory", () => {
    expect(plain.keys).toHaveLength(3);
    for (const key of plain.keys) {
      const pilot = pilotProofInput(plain.dir, key);
      const bundle = exportProofBundle(pilot.input, hostRedaction());
      const result = verifyProofBundle(serializeProofBundle(bundle), {
        evidenceDir: pilot.evidenceDir,
      });
      expect(result.errors).toEqual([]);
      expect(result.ok).toBe(true);
      expect(pilot.evidenceDir).toBe(join(plain.dir, "trials", key));
    }
  });

  it("projects the run from the progress ledger: run id, task, arm, simulated", () => {
    const [record] = attemptsOf(plain.dir);
    const key = record?.start.trialKey as string;
    const pilot = pilotProofInput(plain.dir, key);
    expect(pilot.input).toMatchObject({
      runId: record?.start.runId,
      taskId: record?.start.taskId,
      arm: record?.end?.armRow?.arm,
      simulated: true,
    });
    const bundle = exportFrom(plain.dir, key);
    expect(bundle.run).toMatchObject({ runId: key, taskId: record?.start.taskId, simulated: true });
    expect(bundle.run.arm).toBe("myco-gate");
  });

  it("carries the gate registry and the captured document, by digest, bound to the arm row", () => {
    const [record] = attemptsOf(plain.dir);
    const key = record?.start.trialKey as string;
    const trialDir = join(plain.dir, "trials", key);
    const bundle = exportFrom(plain.dir, key);
    const evidence = bundle.records.filter((r) => r.kind === "evidence").map((r) => r.body);
    const doc = readFileSync(join(trialDir, PILOT_DOC_FILE));
    const gate = readFileSync(join(trialDir, PILOT_GATE_TASKS_FILE));
    expect(evidence).toEqual([
      expect.objectContaining({
        evidenceId: PILOT_EVIDENCE.gateTasks.evidenceId,
        kind: PILOT_EVIDENCE.gateTasks.evidenceKind,
        mediaType: "application/json",
        sha256: sha256Hex(gate),
        bytes: gate.byteLength,
      }),
      expect.objectContaining({
        evidenceId: PILOT_EVIDENCE.doc.evidenceId,
        kind: PILOT_EVIDENCE.doc.evidenceKind,
        mediaType: "text/csv",
        sha256: record?.end?.armRow?.persistedSha256,
        bytes: doc.byteLength,
      }),
    ]);
    // The artifact itself is never inlined.
    expect(serializeProofBundle(bundle)).not.toContain(doc.toString("utf8").split("\n")[1]);
  });

  it("carries no verdict record: the runner does not persist the gate's reason codes", () => {
    for (const key of plain.keys) {
      const pilot = pilotProofInput(plain.dir, key);
      expect(pilot.verdictCarried).toBe(false);
      expect(pilot.input.steps.some((s) => s.kind === "verdict")).toBe(false);
    }
  });

  it("a pilot run with no #518 ledger carries none", () => {
    expect(existsSync(join(plain.dir, PILOT_ATTEMPTS_FILE))).toBe(false);
    expect(exportFrom(plain.dir, plain.keys[0] as string).ledger).toBeNull();
  });

  it("an arm directory with #518's ledger is anchored, with the head from the external anchor", () => {
    const anchorLines = readFileSync(anchorPathFor(withLedger.dir), "utf8").trim().split("\n");
    const last = JSON.parse(anchorLines.at(-1) as string) as { headSha256: string };
    for (const key of withLedger.keys) {
      const bundle = exportFrom(withLedger.dir, key);
      const anchor = bundle.records.at(-1);
      expect(anchor?.kind).toBe("ledger-anchor");
      expect(anchor?.body).toMatchObject({ trialKey: key, ledgerHeadSha256: last.headSha256 });
      const result = verifyProofBundle(serializeProofBundle(bundle), {
        evidenceDir: join(withLedger.dir, "trials", key),
        expectLedgerHead: last.headSha256,
      });
      expect(result.errors).toEqual([]);
    }
  });

  it("a harness-faulted trial exports its registry only (no document was captured)", () => {
    const pilot = pilotProofInput(faulted.dir, faulted.faultedKey);
    expect(pilot.input.steps.map((s) => (s.kind === "evidence" ? s.evidenceId : s.kind))).toEqual([
      PILOT_EVIDENCE.gateTasks.evidenceId,
    ]);
    const bundle = exportProofBundle(pilot.input, hostRedaction());
    expect(
      verifyProofBundle(serializeProofBundle(bundle), { evidenceDir: pilot.evidenceDir }).ok,
    ).toBe(true);
  });

  it("a faulted trial #518 cannot name has no end in #518's ledger, so its export is refused", () => {
    const key = attemptsOf(faulted.ledgerDir).find((r) => r.end?.outcome === "harness-fault")?.start
      .trialKey as string;
    expect(codeOf(() => exportFrom(faulted.ledgerDir, key))).toBe("PROOF_LEDGER_ANCHOR");
  });
});

describe("refusals (codes and structural messages only)", () => {
  const key = () => plain.keys[0] as string;
  const docOf = (dir: string) => join(dir, "trials", key(), PILOT_DOC_FILE);

  it("a document on disk that is not the one the arm row recorded", () => {
    const dir = copyRun(plain.dir);
    appendFileSync(docOf(dir), "x\n");
    expect(codeOf(() => pilotProofInput(dir, key()))).toBe("PROOF_PILOT_EVIDENCE");
  });

  it("a recorded document missing from disk", () => {
    const dir = copyRun(plain.dir);
    rmSync(docOf(dir));
    expect(codeOf(() => pilotProofInput(dir, key()))).toBe("PROOF_PILOT_EVIDENCE");
  });

  it("a document on disk when the arm row recorded none", () => {
    const dir = copyRun(faulted.dir);
    writeFileSync(join(dir, "trials", faulted.faultedKey, PILOT_DOC_FILE), "a,b\n");
    expect(codeOf(() => pilotProofInput(dir, faulted.faultedKey))).toBe("PROOF_PILOT_EVIDENCE");
  });

  it("a symlinked document, even one pointing at the right bytes, and a dangling one", () => {
    const dir = copyRun(plain.dir);
    const real = join(tmp(), "doc.csv");
    cpSync(docOf(dir), real);
    rmSync(docOf(dir));
    symlinkSync(real, docOf(dir));
    expect(codeOf(() => pilotProofInput(dir, key()))).toBe("PROOF_PILOT_EVIDENCE");
    rmSync(real);
    expect(codeOf(() => pilotProofInput(dir, key()))).toBe("PROOF_PILOT_EVIDENCE");
  });

  it("a trial key that is not a closed id is never joined into a path", () => {
    for (const bad of ["../run", "a/b", "..", "", "x y", "C:run"])
      expect(
        codeOf(() => pilotProofInput(plain.dir, bad)),
        bad,
      ).toBe("PROOF_PILOT_TRIAL");
  });

  it("a trial key the progress ledger does not have", () => {
    expect(codeOf(() => pilotProofInput(plain.dir, "no-such-trial"))).toBe("PROOF_PILOT_TRIAL");
  });

  it("a directory with no progress ledger, or one that does not load", () => {
    const empty = tmp();
    expect(codeOf(() => pilotProofInput(empty, key()))).toBe("PROOF_PILOT_PROGRESS");
    const dir = copyRun(plain.dir);
    writeFileSync(join(dir, PROGRESS_FILE), "not json\n{}\n");
    expect(codeOf(() => pilotProofInput(dir, key()))).toBe("PROOF_PILOT_PROGRESS");
    expect(messageOf(() => pilotProofInput(dir, key()))).not.toContain(dir);
  });

  it("an open attempt (a start with no end)", () => {
    const dir = copyRun(plain.dir);
    const path = join(dir, PROGRESS_FILE);
    const lines = readFileSync(path, "utf8").trim().split("\n");
    const kept = lines.filter((l) => {
      const v = JSON.parse(l) as { event?: string; trialKey?: string };
      return !(v.event === "end" && v.trialKey === key());
    });
    writeFileSync(path, `${kept.join("\n")}\n`);
    expect(codeOf(() => pilotProofInput(dir, key()))).toBe("PROOF_PILOT_OPEN");
  });

  it("an end whose arm row is null (a crash closure)", () => {
    const dir = copyRun(plain.dir);
    const path = join(dir, PROGRESS_FILE);
    const lines = readFileSync(path, "utf8").trim().split("\n");
    const edited = lines.map((l) => {
      const v = JSON.parse(l) as { event?: string; trialKey?: string };
      // The end the runner appends on resume for an attempt it crashed in.
      return v.event === "end" && v.trialKey === key()
        ? JSON.stringify({
            ...v,
            outcome: "harness-fault",
            harnessClass: "crash",
            recovered: true,
            armRow: null,
            cost: null,
          })
        : l;
    });
    writeFileSync(path, `${edited.join("\n")}\n`);
    expect(codeOf(() => pilotProofInput(dir, key()))).toBe("PROOF_PILOT_OPEN");
  });

  it("an arm row of another trial, or of another task", () => {
    for (const field of ["trialKey", "taskId"] as const) {
      const dir = copyRun(plain.dir);
      const path = join(dir, PROGRESS_FILE);
      const lines = readFileSync(path, "utf8").trim().split("\n");
      const edited = lines.map((l) => {
        const v = JSON.parse(l) as { event?: string; trialKey?: string; armRow?: object };
        return v.event === "end" && v.trialKey === key()
          ? JSON.stringify({ ...v, armRow: { ...v.armRow, [field]: "other-value" } })
          : l;
      });
      writeFileSync(path, `${edited.join("\n")}\n`);
      expect(
        codeOf(() => pilotProofInput(dir, key())),
        field,
      ).toBe("PROOF_PILOT_MISMATCH");
    }
  });

  it("a trial directory with no evidence at all", () => {
    const dir = copyRun(faulted.dir);
    rmSync(join(dir, "trials", faulted.faultedKey, PILOT_GATE_TASKS_FILE));
    expect(codeOf(() => pilotProofInput(dir, faulted.faultedKey))).toBe("PROOF_PILOT_EVIDENCE");
  });

  it("#518's ledger without its external anchor", () => {
    const dir = copyRun(withLedger.dir);
    rmSync(anchorPathFor(dir));
    expect(codeOf(() => pilotProofInput(dir, withLedger.keys[0] as string))).toBe(
      "PROOF_LEDGER_ANCHOR",
    );
  });

  it("#518's ledger rewritten consistently but not re-anchored", () => {
    // Drop the last attempt (its start and end): the chain still verifies, the anchor does not.
    const dir = copyRun(withLedger.dir);
    const path = join(dir, PILOT_ATTEMPTS_FILE);
    const lines = readFileSync(path, "utf8").trim().split("\n");
    writeFileSync(path, `${lines.slice(0, -2).join("\n")}\n`);
    expect(codeOf(() => pilotProofInput(dir, withLedger.keys[0] as string))).toBe(
      "PROOF_LEDGER_ANCHOR",
    );
  });

  it("#518's ledger with an edited event", () => {
    const dir = copyRun(withLedger.dir);
    const path = join(dir, PILOT_ATTEMPTS_FILE);
    const lines = readFileSync(path, "utf8").trim().split("\n");
    const first = JSON.parse(lines[0] as string) as Record<string, unknown>;
    lines[0] = JSON.stringify({ ...first, taskId: "fc-v1-999" });
    writeFileSync(path, `${lines.join("\n")}\n`);
    expect(codeOf(() => pilotProofInput(dir, withLedger.keys[0] as string))).toBe(
      "PROOF_LEDGER_CHAIN",
    );
  });

  it("a torn ledger or anchor line", () => {
    for (const which of ["ledger", "anchor"] as const) {
      const dir = copyRun(withLedger.dir);
      appendFileSync(
        which === "ledger" ? join(dir, PILOT_ATTEMPTS_FILE) : anchorPathFor(dir),
        "{torn",
      );
      expect(
        codeOf(() => pilotProofInput(dir, withLedger.keys[0] as string)),
        which,
      ).toBe(which === "ledger" ? "PROOF_LEDGER_CHAIN" : "PROOF_LEDGER_ANCHOR");
    }
  });

  it("no refusal message quotes the run directory", () => {
    const dir = copyRun(plain.dir);
    rmSync(docOf(dir));
    expect(messageOf(() => pilotProofInput(dir, key()))).not.toContain(dir);
    expect(messageOf(() => pilotProofInput(dir, key()))).not.toContain(key());
  });
});

describe("the simulated flag fails toward never-evidence", () => {
  const setHeaderSimulated = (dir: string, simulated: boolean) => {
    const path = join(dir, PROGRESS_FILE);
    const [header, ...rest] = readFileSync(path, "utf8").trim().split("\n");
    const h = JSON.parse(header as string) as Record<string, unknown>;
    writeFileSync(path, `${[JSON.stringify({ ...h, simulated }), ...rest].join("\n")}\n`);
  };

  it("the SIMULATED marker alone makes the run simulated", () => {
    const dir = copyRun(plain.dir);
    setHeaderSimulated(dir, false);
    expect(existsSync(join(dir, SIMULATED_FILE))).toBe(true);
    expect(pilotProofInput(dir, plain.keys[0] as string).input.simulated).toBe(true);
  });

  it("the header alone makes the run simulated", () => {
    const dir = copyRun(plain.dir);
    rmSync(join(dir, SIMULATED_FILE));
    expect(pilotProofInput(dir, plain.keys[0] as string).input.simulated).toBe(true);
  });

  it("only a header that says live and no marker gives simulated: false", () => {
    const dir = copyRun(plain.dir);
    setHeaderSimulated(dir, false);
    rmSync(join(dir, SIMULATED_FILE));
    expect(pilotProofInput(dir, plain.keys[0] as string).input.simulated).toBe(false);
  });
});

describe("the evidence directory binds the bundle to the run's files", () => {
  it("a document swapped after export is refused by verify --evidence-dir", () => {
    const dir = copyRun(plain.dir);
    const key = plain.keys[0] as string;
    const pilot = pilotProofInput(dir, key);
    const text = serializeProofBundle(exportProofBundle(pilot.input, hostRedaction()));
    appendFileSync(join(pilot.evidenceDir, PILOT_DOC_FILE), "x\n");
    const result = verifyProofBundle(text, { evidenceDir: pilot.evidenceDir });
    expect(result.ok).toBe(false);
    expect(result.errors.map((e) => e.code)).toContain("PROOF_EVIDENCE_DIGEST");
  });
});

describe("CLI: proof.ts export-pilot", () => {
  const run = (argv: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const io: CliIo = { out: (t) => out.push(t), err: (t) => err.push(t) };
    return { code: main(argv, io), out: out.join(""), err: err.join("") };
  };

  it("writes a bundle that verifies, and prints no host path", () => {
    const key = plain.keys[1] as string;
    const out = join(tmp(), "bundle.json");
    const r = run(["export-pilot", plain.dir, "--trial", key, "--out", out]);
    expect(r.code, r.out + r.err).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({
      ok: true,
      simulated: true,
      ledger: false,
      verdictCarried: false,
      records: 2,
    });
    expect(r.out).not.toContain(plain.dir);
    const v = run(["verify", out, "--evidence-dir", join(plain.dir, "trials", key)]);
    expect(v.code, v.out).toBe(0);
  });

  it("a refusal exits 1 with its code", () => {
    const dir = copyRun(plain.dir);
    const key = plain.keys[0] as string;
    rmSync(join(dir, "trials", key, PILOT_DOC_FILE));
    const r = run(["export-pilot", dir, "--trial", key, "--out", join(tmp(), "b.json")]);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.out)).toMatchObject({ ok: false, code: "PROOF_PILOT_EVIDENCE" });
  });

  it("usage: --trial and --out are required", () => {
    expect(run(["export-pilot", plain.dir, "--out", join(tmp(), "b.json")]).code).toBe(2);
    expect(run(["export-pilot", plain.dir, "--trial", plain.keys[0] as string]).code).toBe(2);
  });
});
