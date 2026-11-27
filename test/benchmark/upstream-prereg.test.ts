/**
 * The draft public-R1 pre-registration under the lead's rulings: 13:55Z (OSWorld's own task
 * configs, controller, evaluator and Claude runner; Myco adds only the DONE gate), 14:05Z
 * (retarget to the Myco Linux fleet with one provider for every arm; parity before any live
 * run), 14:37Z (scope), 15:21Z (UTM reference, a stated deviation) and 15:26Z (N3: the self-check
 * arm is a structural re-check of the end state on DONE, not a prompt). It states all of that;
 * its hash is recomputable; and the analysis refuses "shown" while anything is pending, without
 * a passed parity assessment, on a pre-registration that is not committed, on any non-LIVE or
 * simulated row, or unless every arm covers exactly the n tasks (#652 rule). Rows and parity
 * records below are synthetic inputs to the analysis functions, not results.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { UPSTREAM_METRIC_MOCK_VERSION } from "../../src/benchmark/upstream/evaluate.ts";
import type { UpstreamTask } from "../../src/benchmark/upstream/import.ts";
import {
  assessParity,
  type ParityAssessment,
  type ParityRecord,
  type ParitySample,
} from "../../src/benchmark/upstream/parity.ts";
import { MYCO_FLEET, OSWORLD_HARNESS, OSWORLD_PIN } from "../../src/benchmark/upstream/pins.ts";
import {
  ACTION_LAYER_SUMMARY,
  analyzePublicR1,
  canonicalJson,
  type PublicR1Context,
  type PublicR1Prereg,
  type PublicR1Row,
  preregProblems,
  preregSha256,
  R1_ARMS,
  WAA_PHASE2_ENTRY,
} from "../../src/benchmark/upstream/prereg.ts";
import { OSWORLD_EVALUATE_GRADER } from "../../src/benchmark/upstream/r1-grade.ts";
import { pinnedStamp } from "./upstream-fixture.ts";

const ROOT = resolve(import.meta.dirname, "..", "..");
const RAW = readFileSync(join(ROOT, "docs/benchmark/upstream/r1-public-prereg.json"), "utf8");
const MD = readFileSync(join(ROOT, "docs/benchmark/upstream/r1-public-prereg.md"), "utf8");
const SAMPLE = JSON.parse(
  readFileSync(join(ROOT, "docs/benchmark/upstream/r1-parity-sample.json"), "utf8"),
) as ParitySample;
const SAMPLE_SHA = preregSha256(SAMPLE);
type Prereg = PublicR1Prereg & Record<string, unknown>;
const PREREG = JSON.parse(RAW) as Prereg;
const TASKS = readFileSync(join(ROOT, "benchmark/upstream/osworld-office-v1/tasks.jsonl"), "utf8")
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l) as UpstreamTask);
const SUBSET = new Set(TASKS.map((t) => t.taskId));
const clone = (): Prereg => JSON.parse(RAW);
type Obj = Record<string, unknown>;
const at = (p: Obj, ...path: (string | number)[]): Obj =>
  path.reduce<Obj>((o, k) => o[k as string] as Obj, p);

/** A passing parity assessment over admissible synthetic records (fleet matches reference). */
function parityRecords(over: Partial<ParityRecord> = {}): ParityRecord[] {
  const out: ParityRecord[] = [];
  for (const env of ["fleet", "reference"] as const)
    for (const t of SAMPLE.tasks)
      for (const sequence of ["known-good", "known-bad"] as const)
        out.push({
          label: "LIVE-SCRIPTED",
          env,
          provider: env === "fleet" ? MYCO_FLEET.provider : MYCO_FLEET.referenceProvider,
          taskId: t.taskId,
          sequence,
          score: sequence === "known-good" ? 1 : 0,
          graderVersion: OSWORLD_EVALUATE_GRADER,
          sampleSha256: SAMPLE_SHA,
          hostLabel: "synthetic-host",
          stamp: pinnedStamp(env === "fleet" ? "myco-fleet" : "utm-reference"),
          ...over,
        });
  return out;
}
const PASSED: ParityAssessment = assessParity(SAMPLE, SUBSET, parityRecords());

/** A hypothetical fully-ruled, frozen copy, to show the analysis is not refusing for its own sake. */
function ruled(): Prereg {
  const p = clone() as Obj;
  at(p, "harness", "provider").imageDigest = `sha256:${"b".repeat(64)}`;
  return {
    ...(p as Prereg),
    status: "frozen",
    model: "model-x",
    budget: "50 steps",
    gateOracle: "family-x",
    leadRulingPending: [],
  };
}
/** The context of a committed pre-registration with a passed parity assessment. */
const ctx = (p: Prereg, parity: ParityAssessment | null = PASSED): PublicR1Context => ({
  parity,
  committedPreregHashes: new Set([preregSha256(p)]),
});
const analyze = (p: Prereg, rows: readonly PublicR1Row[], parity?: ParityAssessment | null) =>
  analyzePublicR1(p, SUBSET, rows, ctx(p, parity === undefined ? PASSED : parity));

const row = (taskId: string, over: Partial<PublicR1Row> = {}): PublicR1Row => ({
  taskSetVersion: "osworld-office-v1",
  taskId,
  arm: "gate-before-done",
  label: "LIVE",
  graderVersion: OSWORLD_EVALUATE_GRADER,
  agentClaimedDone: true,
  upstreamStatus: "pass",
  gateVerdict: "verified",
  ...over,
});
/** Gated rows over the subset (with `over`), plus plain rows for the other two arms. */
const allRows = (over: (id: string, i: number) => Partial<PublicR1Row> = () => ({})) => [
  ...[...SUBSET].map((id, i) => row(id, over(id, i))),
  ...["no-gate", "self-check"].flatMap((arm) =>
    [...SUBSET].map((id) => row(id, { arm, gateVerdict: null })),
  ),
];

describe("draft public-R1 pre-registration: the rulings' fields", () => {
  it("has no shape problem as committed", () => {
    expect(preregProblems(PREREG, SUBSET.size, SAMPLE_SHA)).toEqual([]);
  });

  it("states OSWorld's own harness and the standard Claude runner at the pinned commit, on the Myco fleet provider (14:05Z)", () => {
    const h = PREREG.harness as Obj;
    expect(h.repo).toBe(OSWORLD_PIN.repo);
    expect(h.commit).toBe(OSWORLD_PIN.commit);
    expect(h.provider).toMatchObject({
      name: "myco-fleet",
      adapter: "src/benchmark/upstream/fleet/myco_fleet_provider.py",
      image: "src/benchmark/upstream/fleet/Dockerfile",
    });
    expect((h.provider as Obj).imageDigest).toMatch(/^PENDING/);
    expect(RAW).not.toMatch(/providerOptions/);
    expect(PREREG.agentRunner).toMatchObject({
      file: "scripts/python/run_multienv_claude.py",
      commit: OSWORLD_PIN.commit,
    });
    expect(OSWORLD_HARNESS.files[OSWORLD_HARNESS.agentRunner]).toMatch(/^[0-9a-f]{64}$/);
  });

  it("asserts one action layer, 'OSWorld controller, identical across arms', and says where and how DONE is intercepted", () => {
    expect(PREREG.actionLayer).toMatchObject({
      summary: "OSWorld controller, identical across arms",
      actionSpace: "claude_computer_use",
      observationType: "screenshot",
      identicalAcrossArms: true,
    });
    expect(ACTION_LAYER_SUMMARY).toBe("OSWorld controller, identical across arms");
    expect((PREREG.actionLayer as { assertion: string }).assertion).toMatch(
      /^Identical across arms/,
    );
    expect(PREREG.gateInterception).toMatchObject({
      api: "myco.gate/v1",
      request: ["taskId", "runId", "claim"],
      failClosed: true,
    });
  });

  it("has exactly the three ruled arms on the shared runner, action layer, provider and budget; the gate only in arm (b)", () => {
    const arms = PREREG.arms as Obj[];
    expect(arms.map((a) => a.id)).toEqual(["no-gate", "gate-before-done", "self-check"]);
    expect(arms.map((a) => a.gate)).toEqual([false, true, false]);
    for (const a of arms)
      expect(a).toMatchObject({
        agentRunner: "shared",
        actionLayer: "shared",
        budget: "shared",
        provider: "shared",
      });
    expect(RAW).not.toMatch(
      /hcu-shell|screenshot-only|myco-gate"|namespace desktop|linux-namespace/i,
    );
  });

  it("N3 (15:26Z): arm (c) is the structural re-check, with its probe pin, budget parity and what it may never read; no prompt-suffix arm or ablation", () => {
    const arms = PREREG.arms as Obj[];
    expect(arms.map((a) => a.promptSuffix)).toEqual([null, null, null]);
    const sc = at(PREREG, "arms", 2, "selfCheck") as Record<string, unknown>;
    expect(sc).toMatchObject({
      form: "structural-recheck",
      ruling: "2026-11-27T15:26Z",
      codes: [
        "SAVED_FILE_MISSING",
        "SAVED_FILE_FORMAT_MISMATCH",
        "NOTHING_SAVED",
        "RECHECK_UNAVAILABLE",
      ],
    });
    expect(sc.transport).toMatch(
      /^desktop_env\/controllers\/python\.py#PythonController\.run_bash_script/,
    );
    expect(sc.onProblem).toMatch(/^DONE becomes upstream's own WAIT special action/);
    expect(sc.budgetParity).toMatch(
      /counted exactly as the gate arm's check is counted: it runs inside the turn of the DONE it checks, a refused DONE uses that turn \(one step\), the probe itself costs no step and no model tokens/,
    );
    expect(sc.budgetParity).toMatch(
      /20 s script timeout plus the controller's fixed 100 s HTTP margin is 120 s, the gate client's timeout/,
    );
    const never = (sc.mayNotRead as string[]).join(" | ");
    for (const k of [
      "oracle",
      "task configuration",
      "gold files",
      "fixtures",
      "ground truth",
      "evaluator code",
      "result.txt",
      "DesktopEnv.evaluate",
      "run_bash_script",
    ])
      expect(never).toContain(k);
    expect(sc.ablation).toMatch(
      /^None\. The earlier prompt-suffix variant .* 117 more trials .* it is dropped/,
    );
    expect(PREREG.leadRulingPending.join("\n")).not.toMatch(/self-check/);
  });

  it("has a parity section: parity before any live run, the committed sample by hash, the fleet against OSWorld's guest image in UTM as a stated deviation (15:21Z)", () => {
    const parity = PREREG.parity as Obj;
    expect(parity.rule).toMatch(/^Parity must pass before any live run\./);
    expect(parity.sample).toBe("docs/benchmark/upstream/r1-parity-sample.json");
    expect(parity.sampleSha256).toBe(SAMPLE_SHA);
    expect(parity.taskIds).toEqual(SAMPLE.tasks.map((t) => t.taskId));
    expect(parity.grader).toBe(OSWORLD_EVALUATE_GRADER);
    expect(parity.reference).toMatchObject({
      provider: "utm-reference",
      hypervisor: "UTM (QEMU with HVF)",
    });
    const ref = parity.reference as { deviation: string; guestImage: string };
    expect(ref.deviation).toMatch(/^STATED DEVIATION from OSWorld's VMware reference/);
    expect(ref.deviation).toMatch(/Never VMware Fusion or any Broadcom\/VMware account/);
    expect(ref.guestImage).toMatch(/Ubuntu-arm\.zip/);
    expect(ref.guestImage).toMatch(/12,287,865,453 bytes; 25,215,685,544 bytes unzipped in 27/);
    expect(parity.status).toMatch(/^Not run\./);
  });

  it("cites the 13:55Z, 14:05Z, 14:37Z, 15:21Z and 15:26Z rulings with their timestamps and comment links", () => {
    const rulings = PREREG.rulings as { at: string; ref: string }[];
    expect(rulings.map((r) => r.at)).toEqual([
      "2026-11-27T13:55Z",
      "2026-11-27T14:05Z",
      "2026-11-27T14:37Z",
      "2026-11-27T15:21Z",
      "2026-11-27T15:26Z",
    ]);
    expect(rulings.map((r) => r.ref.split("issuecomment-")[1])).toEqual([
      "7220110528",
      "7220313158",
      "7220987945",
      "7221935698",
      "7222035806",
    ]);
    for (const t of ["13:55Z", "14:05Z", "14:37Z", "15:21Z", "15:26Z"])
      expect(PREREG.ruling as string).toContain(t);
  });

  it("grades with the upstream evaluate path at the pin, never the MOCK metric runner", () => {
    expect(PREREG.grader).toMatchObject({
      version: OSWORLD_EVALUATE_GRADER,
      path: "desktop_env/desktop_env.py#DesktopEnv.evaluate",
    });
    expect(OSWORLD_EVALUATE_GRADER).toBe(`osworld-desktopenv-evaluate@${OSWORLD_PIN.commit}`);
  });

  it("states the subset rule and count from OSWorld's own task list, with no exclusions", () => {
    expect(PREREG.subsetSize).toBe(117);
    expect(PREREG.n).toBe(SUBSET.size);
    expect(PREREG.exclusions).toEqual([]);
    expect(PREREG.subsetRule).toMatch(
      /libreoffice_calc, libreoffice_writer and libreoffice_impress/,
    );
  });

  it("keeps WAA as phase 2: deferred, not dropped", () => {
    expect(PREREG.phase2).toEqual([WAA_PHASE2_ENTRY]);
    expect(WAA_PHASE2_ENTRY).toBe(
      "WAA office subset (64 tasks @ eb220c4dcf64) via WAA's own Windows 11 image, in-VM server, evaluators and runner: deferred, not dropped.",
    );
  });

  it("keeps the truly open rulings pending (the parity reference run among them) and drops the settled host, harness and self-check-form items", () => {
    const ids = PREREG.leadRulingPending.map((p) => p.split(":")[0]);
    expect(ids).toEqual([
      "asset-license",
      "model",
      "budget",
      "n",
      "pass-threshold",
      "gate-oracle",
      "parity-reference-run",
      "model-access",
    ]);
    expect(PREREG.gateOracle).toMatch(/^PENDING/);
    expect(PREREG.gateOracleConstraint).toMatch(/independent of the upstream evaluator/);
  });

  it("each missing ruling field is caught by the shape check", () => {
    const cases: [string, (p: Obj) => void][] = [
      ["HARNESS_NOT_PINNED", (p) => (at(p, "harness").commit = "0".repeat(40))],
      // B2: a VM provider, or none, is not the fleet.
      ["HARNESS_PROVIDER_NOT_FLEET", (p) => (at(p, "harness").provider = "vmware")],
      ["HARNESS_PROVIDER_NOT_FLEET", (p) => (at(p, "harness", "provider").name = "docker")],
      ["HARNESS_PROVIDER_NOT_FLEET", (p) => delete at(p, "harness", "provider").imageDigest],
      [
        "HARNESS_PROVIDER_NOT_FLEET",
        (p) => (at(p, "harness", "provider").adapter = "desktop_env/providers/vmware"),
      ],
      ["AGENT_RUNNER_NOT_PINNED", (p) => (at(p, "agentRunner").file = "run.py")],
      [
        "ACTION_LAYER_NOT_ASSERTED_IDENTICAL",
        (p) => (at(p, "actionLayer").identicalAcrossArms = false),
      ],
      ["ACTION_LAYER_NOT_ASSERTED_IDENTICAL", (p) => delete at(p, "actionLayer").summary],
      ["ACTION_LAYER_NOT_UPSTREAM", (p) => (at(p, "actionLayer").executor = "hcu")],
      ["ARM_ACTION_LAYER_DIFFERS:self-check", (p) => (at(p, "arms", 2).actionLayer = "hcu+shell")],
      ["ARM_BUDGET_DIFFERS:no-gate", (p) => (at(p, "arms", 0).budget = "100 steps")],
      // B3: one arm on another provider.
      ["ARM_PROVIDER_DIFFERS:self-check", (p) => (at(p, "arms", 2).provider = "vmware")],
      ["ARM_PROVIDER_DIFFERS:no-gate", (p) => delete at(p, "arms", 0).provider],
      ["ARM_GATE_WRONG:self-check", (p) => (at(p, "arms", 2).gate = true)],
      [
        "ARMS_NOT_RULED",
        (p) =>
          (p.arms as unknown[]).push({
            id: "hcu-shell",
            actionLayer: "shared",
            agentRunner: "shared",
            budget: "shared",
            provider: "shared",
            gate: false,
          }),
      ],
      [
        "GATE_INTERCEPTION_MISSING",
        (p) => (at(p, "gateInterception").request = ["taskId", "runId", "claim", "expected"]),
      ],
      [
        "GRADER_NOT_UPSTREAM_EVALUATE",
        (p) => (at(p, "grader").version = UPSTREAM_METRIC_MOCK_VERSION),
      ],
      ["WAA_PHASE2_MISSING", (p) => (p.phase2 = [])],
      ["SUBSET_SIZE_MISMATCH", (p) => (p.subsetSize = 130)],
      [
        "STALE_HARNESS_PENDING",
        (p) => (p.leadRulingPending as string[]).push("harness: display on the namespace desktops"),
      ],
      // B2: no parity section, or one without the before-any-live-run rule.
      ["PARITY_MISSING", (p) => delete p.parity],
      ["PARITY_MISSING", (p) => (at(p, "parity").rule = "Parity should be checked at some point.")],
      ["PARITY_MISSING", (p) => (at(p, "parity", "fleet").provider = "docker")],
      ["PARITY_SAMPLE_MISMATCH", (p) => (at(p, "parity").sampleSha256 = "0".repeat(64))],
      ["PARITY_REFERENCE_NOT_RULED", (p) => (at(p, "parity", "reference").provider = "vmware")],
      [
        "PARITY_REFERENCE_NOT_RULED",
        (p) => (at(p, "parity", "reference").hypervisor = "VMware Fusion"),
      ],
      [
        "PARITY_REFERENCE_NOT_RULED",
        (p) => (at(p, "parity", "reference").deviation = "Same as OSWorld's reference."),
      ],
      ["RULINGS_NOT_CITED", (p) => (p.rulings = (p.rulings as unknown[]).slice(0, 1))],
      ["RULINGS_NOT_CITED", (p) => (p.ruling = "Lead ruling 2026-11-27 ~13:55Z only.")],
      [
        "RULINGS_NOT_CITED",
        (p) => (p.rulings = (p.rulings as Obj[]).filter((r) => r.at !== "2026-11-27T15:26Z")),
      ],
      // N3 (15:26Z): the self-check arm is the structural re-check, pre-registered in full.
      ["SELF_CHECK_NOT_RULED", (p) => delete at(p, "arms", 2).selfCheck],
      ["SELF_CHECK_NOT_RULED", (p) => (at(p, "arms", 2, "selfCheck").form = "prompt-suffix")],
      ["SELF_CHECK_NOT_RULED", (p) => (at(p, "arms", 2, "selfCheck").ruling = "2026-11-27T15:21Z")],
      ["SELF_CHECK_NOT_RULED", (p) => (at(p, "arms", 2, "selfCheck").probeSha256 = "PENDING")],
      ["SELF_CHECK_NOT_RULED", (p) => delete at(p, "arms", 2, "selfCheck").budgetParity],
      ["SELF_CHECK_NOT_RULED", (p) => delete at(p, "arms", 2, "selfCheck").onProblem],
      ["SELF_CHECK_NOT_RULED", (p) => delete at(p, "arms", 2, "selfCheck").mayRead],
      [
        "SELF_CHECK_NOT_RULED",
        (p) => (at(p, "arms", 2, "selfCheck").codes = ["NOTHING_SAVED", "ORACLE_FAIL"]),
      ],
      ...["oracle", "task configuration", "gold", "fixtures", "evaluator code", "result.txt"].map(
        (k) =>
          [
            "SELF_CHECK_NOT_RULED",
            (p: Obj) =>
              (at(p, "arms", 2, "selfCheck").mayNotRead = (
                at(p, "arms", 2, "selfCheck").mayNotRead as string[]
              ).map((m) => m.replaceAll(k, "x"))),
          ] as [string, (p: Obj) => void],
      ),
      ["ARM_PROMPT_DIFFERS:self-check", (p) => (at(p, "arms", 2).promptSuffix = "Verify first.")],
      ["ARM_PROMPT_DIFFERS:no-gate", (p) => delete at(p, "arms", 0).promptSuffix],
      [
        "STALE_SELF_CHECK_PENDING",
        (p) => (p.leadRulingPending as string[]).push("self-check-form: suffix or re-check"),
      ],
    ];
    for (const [code, mutate] of cases) {
      const p = clone();
      mutate(p);
      expect(preregProblems(p, SUBSET.size, SAMPLE_SHA), code).toContain(code);
    }
    expect(preregProblems(PREREG, SUBSET.size, "0".repeat(64))).toEqual(["PARITY_SAMPLE_MISMATCH"]);
  });

  it("its hash is the SHA-256 of the canonical JSON, and the .md quotes it", () => {
    const hash = preregSha256(PREREG);
    expect(MD).toContain(`\`${hash}\``);
    expect(MD).toContain(`\`${SAMPLE_SHA}\``);
    expect(canonicalJson({ b: [2, { d: 1, c: 0 }], a: "x" })).toBe(
      '{"a":"x","b":[2,{"c":0,"d":1}]}',
    );
    expect(preregSha256({ ...clone(), n: 116 })).not.toBe(hash);
  });
});

describe("the public-R1 analysis refuses 'shown' while anything is pending", () => {
  it("refuses on the draft even with perfect LIVE rows and a passed parity assessment", () => {
    const a = analyze(PREREG, allRows());
    expect(a.verdict).toBe("refused");
    expect(a.reasons).toEqual(
      expect.arrayContaining([
        "PREREG_NOT_FROZEN",
        "LEAD_RULING_PENDING",
        "FIELD_PENDING:model",
        "FIELD_PENDING:budget",
        "FIELD_PENDING:gateOracle",
        "FIELD_PENDING:harness.provider.imageDigest",
        "IMAGE_DIGEST_NOT_PINNED",
      ]),
    );
  });

  it("refuses while any single lead ruling is pending, any field says PENDING, or the record has a shape problem", () => {
    const one = { ...ruled(), leadRulingPending: ["parity-reference-run"] };
    expect(analyze(one, allRows())).toMatchObject({
      verdict: "refused",
      reasons: ["LEAD_RULING_PENDING"],
    });
    const pendingModel = { ...ruled(), model: "PENDING: id" };
    expect(analyze(pendingModel, allRows())).toMatchObject({
      verdict: "refused",
      reasons: ["FIELD_PENDING:model"],
    });
    const noPhase2 = { ...ruled(), phase2: [] };
    expect(analyze(noPhase2, allRows())).toMatchObject({
      verdict: "refused",
      reasons: ["PREREG_INVALID:WAA_PHASE2_MISSING"],
    });
  });

  it("B2: a frozen record with no parity section and a VM provider is never 'shown'", () => {
    const p = ruled() as Obj;
    delete p.parity;
    at(p, "harness").provider = "vmware";
    const a = analyze(p as Prereg, allRows());
    expect(a.verdict).toBe("refused");
    expect(a.reasons).toEqual(
      expect.arrayContaining([
        "PREREG_INVALID:HARNESS_PROVIDER_NOT_FLEET",
        "PREREG_INVALID:PARITY_MISSING",
        "PREREG_INVALID:PARITY_SAMPLE_MISMATCH",
        "PREREG_INVALID:PARITY_REFERENCE_NOT_RULED",
        "IMAGE_DIGEST_NOT_PINNED",
        "PARITY_NOT_PASSED",
      ]),
    );
  });

  it("B3: one arm on a different provider is never 'shown'", () => {
    const p = ruled() as Obj;
    at(p, "arms", 0).provider = "myco-linux-fleet";
    at(p, "arms", 2).provider = "vmware";
    expect(analyze(p as Prereg, allRows())).toMatchObject({
      verdict: "refused",
      reasons: [
        "PREREG_INVALID:ARM_PROVIDER_DIFFERS:no-gate",
        "PREREG_INVALID:ARM_PROVIDER_DIFFERS:self-check",
      ],
    });
  });

  it("refuses unless parity passed on this record's sample: no assessment, a failed one, or another sample's", () => {
    expect(analyze(ruled(), allRows(), null).reasons).toEqual([
      "PREREG_INVALID:PARITY_SAMPLE_MISMATCH",
      "PARITY_NOT_PASSED",
    ]);
    const gap = assessParity(
      SAMPLE,
      SUBSET,
      parityRecords().map((r, i) => (i === 0 ? { ...r, score: 0 } : r)),
    );
    expect(gap.passed).toBe(false);
    expect(analyze(ruled(), allRows(), gap).reasons).toEqual(["PARITY_NOT_PASSED"]);
    const forged = { ...gap, passed: true };
    expect(analyze(ruled(), allRows(), forged).reasons).toEqual(["PARITY_NOT_PASSED"]);
    const other = { ...PASSED, sampleSha256: "0".repeat(64) };
    expect(analyze(ruled(), allRows(), other).reasons).toEqual(
      expect.arrayContaining(["PREREG_INVALID:PARITY_SAMPLE_MISMATCH", "PARITY_NOT_PASSED"]),
    );
  });

  it("refuses a pre-registration whose hash does not match a committed one", () => {
    const p = ruled();
    const a = analyzePublicR1(p, SUBSET, allRows(), {
      parity: PASSED,
      committedPreregHashes: new Set([preregSha256(PREREG)]),
    });
    expect(a.reasons).toEqual(["PREREG_NOT_COMMITTED"]);
  });

  it("refuses an image that is not pinned by digest once the field is filled", () => {
    const p = ruled() as Obj;
    at(p, "harness", "provider").imageDigest = "myco-osworld-desktop:local";
    expect(analyze(p as Prereg, allRows()).reasons).toEqual(["IMAGE_DIGEST_NOT_PINNED"]);
  });

  it("never counts MOCK or simulated rows, rows from the MOCK metric runner, or rows from an unregistered arm", () => {
    expect(
      analyze(
        ruled(),
        allRows((_, i) => (i === 0 ? { label: "MOCK" } : {})),
      ).reasons,
    ).toEqual(["NON_LIVE_ROW"]);
    expect(
      analyze(
        ruled(),
        allRows((_, i) => (i === 3 ? { label: "SIMULATED" } : {})),
      ).verdict,
    ).toBe("refused");
    // Shared rule: a row is simulated unless `simulated` is absent or exactly false.
    for (const simulated of [true, "false", 0, null, "yes"])
      expect(
        analyze(
          ruled(),
          allRows((_, i) => (i === 2 ? { simulated } : {})),
        ).reasons,
        String(simulated),
      ).toEqual(["SIMULATED_ROW"]);
    expect(
      analyze(
        ruled(),
        allRows(() => ({ simulated: false })),
      ).verdict,
    ).toBe("shown");
    expect(
      analyze(
        ruled(),
        allRows((_, i) => (i === 5 ? { graderVersion: UPSTREAM_METRIC_MOCK_VERSION } : {})),
      ).reasons,
    ).toEqual(["NOT_UPSTREAM_EVALUATE_GRADED"]);
    expect(
      analyze(ruled(), [...allRows(), row([...SUBSET][0] as string, { arm: "hcu-shell" })]).reasons,
    ).toEqual(["ROW_ARM_NOT_REGISTERED"]);
  });

  it("N6: refuses unless every arm's LIVE rows cover exactly the n pre-registered subset tasks", () => {
    const rows = allRows();
    const n = SUBSET.size;
    expect(analyze(ruled(), rows.slice(1)).reasons).toEqual(["N_MISMATCH:gate-before-done"]);
    expect(analyze(ruled(), [...rows.slice(1), rows[1] as PublicR1Row]).reasons).toEqual([
      "N_MISMATCH:gate-before-done",
    ]);
    for (const [k, arm] of [
      [1, "no-gate"],
      [2, "self-check"],
    ] as const) {
      const missing = rows.filter((_, i) => i !== k * n);
      expect(analyze(ruled(), missing).reasons, arm).toEqual([`N_MISMATCH:${arm}`]);
      const doubled = [...missing, rows[k * n + 1] as PublicR1Row];
      expect(analyze(ruled(), doubled).reasons, arm).toEqual([`N_MISMATCH:${arm}`]);
    }
    expect(R1_ARMS).toEqual(["no-gate", "gate-before-done", "self-check"]);
    expect(analyze(ruled(), [...rows, row("not-in-subset", { arm: "no-gate" })]).reasons).toEqual([
      "ROW_OUTSIDE_SUBSET",
      "N_MISMATCH:no-gate",
    ]);
  });

  it("once nothing is pending and parity passed: a gate that catches every false done is 'shown'; one false accept is 'not shown'", () => {
    const caught = allRows((_, i) =>
      i < 10 ? { upstreamStatus: "fail", gateVerdict: "refuted" } : {},
    );
    expect(analyze(ruled(), caught)).toEqual({
      verdict: "shown",
      reasons: [],
      falseDone: 10,
      falseAccepts: 0,
      caught: 10,
    });
    const leak = allRows((_, i) =>
      i === 0 ? { upstreamStatus: "fail", gateVerdict: "verified" } : {},
    );
    expect(analyze(ruled(), leak)).toMatchObject({ verdict: "not-shown", falseAccepts: 1 });
    const ungradableAccepted = allRows((_, i) =>
      i === 0 ? { upstreamStatus: "ungradable", gateVerdict: "verified" } : {},
    );
    expect(analyze(ruled(), ungradableAccepted)).toMatchObject({ verdict: "not-shown" });
  });
});
