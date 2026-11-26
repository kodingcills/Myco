/**
 * Track M acceptance 1: a procedure is stored ONLY when the gate verified it AND the
 * independent grader passed it, both recorded as digests. Refuted, uncertain, assisted
 * (track N), corrections, ungraded and every half-verified shape are refused, and a refusal
 * writes nothing to the store. Real sealed gate + real grader; no model, no VM.
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { newVaultKey, VerdictVault } from "../../src/integrity/vault.ts";
import { admit, gradeDigest, verdictDigest } from "../../src/skills/admission.ts";
import { SkillStore, STORE_FILE } from "../../src/skills/store.ts";
import {
  candidateFrom,
  docWith,
  forbiddenFor,
  gatedRun,
  pristine,
  NONE_TASK as T,
} from "./helpers.ts";

let base: string;
let vault: VerdictVault;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "myco-skills-admit-"));
  vault = new VerdictVault({
    root: join(base, "vault"),
    key: newVaultKey(),
    agentRoots: [join(base, "agent")],
  });
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

const F = () => forbiddenFor(T);

describe("admission: verified AND graded, or nothing", () => {
  it("admits a run the gate verified and the grader passed, with both digests recorded", async () => {
    const run = await gatedRun(vault, base, T, "run-ok", docWith(T, T.intent.newValue));
    expect(run.outcome.status === "decided" && run.outcome.result.verdict).toBe("verified");
    expect(run.grade.status).toBe("pass");
    const r = admit(candidateFrom(T, "run-ok", run), F());
    expect(r.ok).toBe(true);
    if (!r.ok || run.outcome.status !== "decided") return;
    expect(r.record.provenance).toMatchObject({
      runId: "run-ok",
      taskId: T.taskId,
      gateVerdict: "verified",
      gradeStatus: "pass",
      verdictSha256: verdictDigest(run.outcome.result),
      gradeSha256: gradeDigest(run.grade),
      persistedSha256: run.grade.persistedSha256,
      assisted: false,
      corrections: "off",
      simulated: true,
    });
    const store = SkillStore.open(join(base, "store"));
    expect(store.add(r)).toEqual({ stored: true, skillId: r.record.skillId });
    expect(store.active()).toHaveLength(1);
  });

  it("refuses a refuted run (wrong value saved) and stores nothing", async () => {
    const run = await gatedRun(vault, base, T, "run-ref", docWith(T, "WRONG-VALUE"));
    expect(run.outcome.status === "decided" && run.outcome.result.verdict).toBe("refuted");
    const store = SkillStore.open(join(base, "store"));
    const r = admit(candidateFrom(T, "run-ref", run), F());
    expect(r).toEqual({ ok: false, code: "GATE_NOT_VERIFIED" });
    expect(store.add(r)).toEqual({ stored: false, code: "GATE_NOT_VERIFIED" });
    expect(existsSync(join(base, "store", STORE_FILE))).toBe(false);
  });

  it("refuses an unsaved run (pristine document: refuted)", async () => {
    const run = await gatedRun(vault, base, T, "run-unsaved", pristine(T));
    expect(admit(candidateFrom(T, "run-unsaved", run), F())).toEqual({
      ok: false,
      code: "GATE_NOT_VERIFIED",
    });
  });

  it("refuses an uncertain run (nothing captured: STATE_MISSING)", async () => {
    const run = await gatedRun(vault, base, T, "run-unc", null);
    expect(run.outcome.status === "decided" && run.outcome.result.verdict).toBe("uncertain");
    expect(admit(candidateFrom(T, "run-unc", run), F())).toEqual({
      ok: false,
      code: "GATE_NOT_VERIFIED",
    });
  });

  describe("on a verified run, every other rule still refuses", () => {
    let run: Awaited<ReturnType<typeof gatedRun>>;
    beforeEach(async () => {
      run = await gatedRun(vault, base, T, "run-v", docWith(T, T.intent.newValue));
    });
    const gateOf = () => {
      if (run.outcome.status !== "decided") throw new Error("not decided");
      return run.outcome.result;
    };

    it("assisted (track N) is refused", () => {
      expect(admit(candidateFrom(T, "run-v", run, { assisted: true }), F())).toEqual({
        ok: false,
        code: "ASSISTED_OR_UNKNOWN",
      });
    });
    it("assistance not stated is refused (fail closed)", () => {
      const c = candidateFrom(T, "run-v", run);
      const { assisted: _, ...rest } = c;
      expect(admit(rest, F())).toEqual({ ok: false, code: "ASSISTED_OR_UNKNOWN" });
    });
    it("ungraded (no grade) is refused", () => {
      expect(admit(candidateFrom(T, "run-v", run, { grade: null }), F())).toEqual({
        ok: false,
        code: "UNGRADED",
      });
    });
    it("a grader fail on a gate-verified run (a false VERIFIED) is refused", () => {
      expect(
        admit(candidateFrom(T, "run-v", run, { grade: { ...run.grade, status: "fail" } }), F()),
      ).toEqual({ ok: false, code: "GRADE_NOT_PASS" });
    });
    it("ungradable is refused", () => {
      expect(
        admit(
          candidateFrom(T, "run-v", run, { grade: { ...run.grade, status: "ungradable" } }),
          F(),
        ),
      ).toEqual({ ok: false, code: "GRADE_NOT_PASS" });
    });
    it("a grade on other bytes than the gate read is refused", () => {
      expect(
        admit(
          candidateFrom(T, "run-v", run, {
            grade: { ...run.grade, persistedSha256: "b".repeat(64) },
          }),
          F(),
        ),
      ).toEqual({ ok: false, code: "GRADE_BYTES_MISMATCH" });
    });
    it("corrections on is refused, even when verified", () => {
      expect(admit(candidateFrom(T, "run-v", run, { corrections: "on" }), F())).toEqual({
        ok: false,
        code: "CORRECTIONS_ON",
      });
    });
    it("corrections not stated is refused", () => {
      const { corrections: _, ...rest } = candidateFrom(T, "run-v", run);
      expect(admit(rest, F())).toEqual({ ok: false, code: "CORRECTIONS_ON" });
    });
    it("a gate result that delivered corrections is refused", () => {
      const gate = {
        ...gateOf(),
        corrections: [{ kind: "target_unchanged" } as never],
      };
      expect(admit(candidateFrom(T, "run-v", run, { gate }), F())).toEqual({
        ok: false,
        code: "CORRECTIONS_DELIVERED",
      });
    });
    it("verified but not accepted is refused", () => {
      expect(
        admit(candidateFrom(T, "run-v", run, { gate: { ...gateOf(), accepted: false } }), F()),
      ).toEqual({ ok: false, code: "GATE_NOT_ACCEPTED" });
    });
    it("verified without ORACLE_PASS is refused", () => {
      expect(
        admit(
          candidateFrom(T, "run-v", run, {
            gate: { ...gateOf(), reasonCodes: ["CLAIM_RECORDED"] },
          }),
          F(),
        ),
      ).toEqual({ ok: false, code: "GATE_NO_ORACLE_PASS" });
    });
    it("a gate result for another run is refused", () => {
      expect(admit(candidateFrom(T, "run-other", run), F())).toEqual({
        ok: false,
        code: "GATE_RUN_MISMATCH",
      });
    });
    it("a gate result for another task is refused", () => {
      expect(admit(candidateFrom(T, "run-v", run, { taskId: "fc-v1-099" }), F())).toEqual({
        ok: false,
        code: "GATE_TASK_MISMATCH",
      });
    });
    it("a gate result from another family is refused", () => {
      expect(admit(candidateFrom(T, "run-v", run, { taskFamily: "todo-add" }), F())).toEqual({
        ok: false,
        code: "GATE_FAMILY_MISMATCH",
      });
    });
    it("no gate result is refused", () => {
      expect(admit(candidateFrom(T, "run-v", run, { gate: null }), F())).toEqual({
        ok: false,
        code: "NO_GATE_RESULT",
      });
    });
    it("a malformed ledger reference is refused", () => {
      expect(
        admit(
          candidateFrom(T, "run-v", run, {
            ledgerRef: { ledger: "../x", entrySha256: "a".repeat(64) },
          }),
          F(),
        ),
      ).toEqual({ ok: false, code: "LEDGER_REF_INVALID" });
    });
    it("no forbidden-value list is refused (the expected-value check could not run)", () => {
      expect(admit(candidateFrom(T, "run-v", run), { values: [] })).toEqual({
        ok: false,
        code: "NO_FORBIDDEN_VALUES",
      });
    });
    it("a path-shaped run id is refused", () => {
      expect(admit(candidateFrom(T, "/tmp/run", run), F()).ok).toBe(false);
    });
    it("one skill per run: a second admission of the same run is a duplicate", () => {
      const store = SkillStore.open(join(base, "store"));
      expect(store.add(admit(candidateFrom(T, "run-v", run), F())).stored).toBe(true);
      const again = admit(
        candidateFrom(T, "run-v", run, {
          steps: ["Open the spreadsheet in Calc and save it as CSV"],
        }),
        F(),
      );
      expect(store.add(again)).toEqual({ stored: false, code: "DUPLICATE" });
    });
  });

  it("a run that only got there with corrections on (the #514 loop) is never stored", async () => {
    const run = await gatedRun(vault, base, T, "run-corr", docWith(T, T.intent.newValue), {
      families: ["calc-record-edit"],
    });
    expect(run.outcome.status === "decided" && run.outcome.corrections).toBe("on");
    const store = SkillStore.open(join(base, "store"));
    expect(store.add(admit(candidateFrom(T, "run-corr", run), F()))).toEqual({
      stored: false,
      code: "CORRECTIONS_ON",
    });
    expect(existsSync(join(base, "store", STORE_FILE))).toBe(false);
  });
});
