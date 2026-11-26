/**
 * Capability track P (tier 2): the documented limit of the sealed vault path. The vault's
 * evidence reader serves only a task's `stateFile`, so a cross-app task (which needs every
 * step snapshot) is `uncertain` on the vault path, never verified, even when the vault holds
 * a complete, correct capture. Pins the claim in docs/gate/api.md and docs/gate/cross-app.md.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { crossAppTaskEntry } from "../../src/gate/cross-app-demo.ts";
import { buildRegistry } from "../../src/gate/gate.ts";
import { createSealedGate, gateGroundTruth, sealedEvidenceReader } from "../../src/gate/sealed.ts";
import { newVaultKey, VerdictVault } from "../../src/integrity/vault.ts";
import {
  CROSS_APP_STATE_FILE,
  crossAppEvidenceFiles,
  crossAppSpecFor,
  END_DIR,
  noticePdf,
  REPORT_FILE,
  reportAt,
  SHEET_FILE,
  SOURCE_FILE,
  sheetAt,
  sourceLines,
  stepDir,
} from "../../src/tasks/cross-app.ts";

const ROOT = join(import.meta.dirname, "..", "..");
const SPEC = crossAppSpecFor("xa-sealed-path");
const TASK = "xa-sealed";
const RUN = "run-xa";

let base: string;
let vault: VerdictVault;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "myco-xa-sealed-"));
  const agentRoot = join(base, "agent");
  mkdirSync(agentRoot);
  vault = new VerdictVault({
    root: join(base, "vault"),
    key: newVaultKey(),
    agentRoots: [agentRoot],
  });
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

/** A complete, correct cross-app capture, sealed and captured in the vault. */
function sealCorrectTrial() {
  const tasks = buildRegistry([crossAppTaskEntry(TASK, SPEC)]);
  const task = tasks.get(TASK);
  if (!task) throw new Error("task not registered");
  const receipt = vault.seal(RUN, {
    groundTruth: gateGroundTruth(task),
    fixtures: {},
    oracle: { id: "cross-app-steps@1", sourceFiles: [join(ROOT, "src/gate/cross-app.ts")] },
  });
  vault.markAgentStopped(RUN);
  const n = SPEC.steps.length;
  const persisted: Record<string, Buffer> = {};
  for (let k = 1; k <= n; k++) {
    persisted[`persisted/${stepDir(k)}/${SHEET_FILE}`] = Buffer.from(sheetAt(SPEC, k));
    persisted[`persisted/${stepDir(k)}/${REPORT_FILE}`] = Buffer.from(reportAt(SPEC, k));
  }
  persisted[`persisted/${END_DIR}/${SHEET_FILE}`] = Buffer.from(sheetAt(SPEC, n));
  persisted[`persisted/${END_DIR}/${REPORT_FILE}`] = Buffer.from(reportAt(SPEC, n));
  persisted[`persisted/${SOURCE_FILE}`] = Buffer.from(noticePdf(sourceLines(SPEC)), "latin1");
  vault.capture(RUN, persisted);
  return { tasks, task, receipt };
}

describe("cross-app on the sealed vault path (documented limit)", () => {
  it("the vault opens and serves the stateFile, but no other listed file", async () => {
    const { task, receipt } = sealCorrectTrial();
    const reader = sealedEvidenceReader({ vault, binding: { runId: RUN, receipt }, task });
    expect((await reader.read(RUN, CROSS_APP_STATE_FILE)).ok).toBe(true);
    for (const file of crossAppEvidenceFiles(SPEC.steps.length)) {
      if (file === CROSS_APP_STATE_FILE) continue;
      const read = await reader.read(RUN, file);
      expect(read.ok, file).toBe(false);
      if (!read.ok) expect(read.cause).toBe("unreadable");
    }
  });

  it("a complete, correct capture is uncertain STATE_UNREADABLE, never verified", async () => {
    const { tasks, receipt } = sealCorrectTrial();
    const gate = createSealedGate({ tasks, vault, binding: { runId: RUN, receipt }, taskId: TASK });
    const result = await gate.check({ taskId: TASK, runId: RUN, claim: "done" });
    expect(result.verdict).toBe("uncertain");
    expect(result.accepted).toBe(false);
    expect(result.reasonCodes).toContain("STATE_UNREADABLE");
    // The stateFile was read from the vault; the refusal is the next listed file.
    expect(result.reasons).toEqual(["could not look: not the bound task's state file"]);
    expect(result.evidenceRefs.map((r) => r.path)).toEqual([CROSS_APP_STATE_FILE]);
    expect(result.reasons.join("\n")).not.toContain(base);
  });
});
