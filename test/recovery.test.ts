import { mkdtempSync, writeFileSync } from "node:fs";
/**
 * spreadsheet app (host-side, no Windows). Cases (a)-(f) from the ticket:
 * (a) intent already satisfied → no retry; (b) transient observe failure →
 * one retry; (c) app dead before save → relaunch+resume; (d) app dead after
 * save → no silent redo, abort; (e) recovery returns no verdict (the caller's
 * verifier is the only verdict source); (f) bounded retries.
 *
 * Relaunch semantics mirror the real VM: a relaunched app reloads from disk,
 * so an unsaved edit is LOST (pristine state) and a saved edit PERSISTS.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Action, ActResult, AppAdapter } from "../src/core/adapter.ts";
import { type Program, predicate } from "../src/core/program.ts";
import { runRecovery } from "../src/core/recovery.ts";
import { type RunOutcome, runProgram } from "../src/core/runner.ts";
import { findNode } from "../src/core/state.ts";
import { FakeSpreadsheetApp } from "../src/fake/app.ts";

const NEW_VALUE = "REVISED-XYZ";

function tmpFile(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `myco-recovery-${name}-`));
  const filePath = join(dir, `${name}.csv`);
  // Row 2 = data row 1; the app's grid is 0-indexed from A1, so cell B2 is
  // data row 1, column 0. A fixture file loads lines[1] into row 1.
  writeFileSync(filePath, "id,name\n1,b\n");
  return filePath;
}

/** Fake-app program: click B2, set it, save. */
function editProgram(): Program {
  const cellPristine = predicate(
    'cell B2 holds "b"',
    (s) => findNode(s, "B2")?.value === "b",
    (s) => `value=${JSON.stringify(findNode(s, "B2")?.value)}`,
  );
  const cellHasNewValue = predicate(
    `cell B2 holds "${NEW_VALUE}"`,
    (s) => findNode(s, "B2")?.value === NEW_VALUE,
    (s) => `value=${JSON.stringify(findNode(s, "B2")?.value)}`,
  );
  const notDirty = predicate(
    "document not dirty after save",
    (s) => !s.facts.dirty,
    (s) => `dirty=${String(s.facts.dirty)}`,
  );
  return {
    name: "fake-edit-save",
    steps: [
      {
        action: { kind: "click", ref: { nodeId: "B2" } },
        preconditions: [cellPristine],
        postconditions: [],
      },
      {
        action: { kind: "setValue", ref: { nodeId: "B2" }, value: NEW_VALUE },
        preconditions: [cellPristine],
        postconditions: [cellHasNewValue],
      },
      {
        action: { kind: "keyPress", keys: "ctrl+s" },
        preconditions: [cellHasNewValue],
        postconditions: [notDirty],
        isSave: true,
      },
    ],
  };
}

/**
 * Adapter whose app can crash and relaunch. Relaunch loads from the same
 * file path, so an unsaved edit is lost and a saved edit persists — the same
 * disk-truth semantics as a relaunched Calc on the VM.
 */
class CrashableAdapter implements AppAdapter {
  #app: FakeSpreadsheetApp;
  readonly #filePath: string;
  readonly relaunchCount = { value: 0 };
  /** Crash after this many dispatched acts (0 = never). */
  crashAfter: number = 0;
  #dispatched = 0;

  constructor(filePath: string) {
    this.#filePath = filePath;
    this.#app = new FakeSpreadsheetApp({ filePath });
  }

  observe() {
    return this.#app.observe();
  }

  capabilities() {
    return this.#app.capabilities();
  }

  issueRef(nodeId: string) {
    return this.#app.issueRef(nodeId);
  }

  async act(action: Action): Promise<ActResult> {
    const result = await this.#app.act(action);
    this.#dispatched += 1;
    if (this.crashAfter > 0 && this.#dispatched === this.crashAfter) {
      this.#app.crash();
    }
    return result;
  }

  /** Fresh instance on the same file: disk state decides what survived. */
  relaunch(): boolean {
    this.relaunchCount.value += 1;
    this.#app = new FakeSpreadsheetApp({ filePath: this.#filePath });
    return true;
  }

  get appAlive(): boolean {
    return this.#app.alive;
  }
}

/**
 * Run the program on the crashable adapter with `crashAfter` acts before the
 * kill lands. Mirrors killAfterStepAdapter + runProgramSafe on the real VM.
 */
async function runInterrupted(
  adapter: CrashableAdapter,
  program: Program,
  crashAfter: number,
): Promise<RunOutcome> {
  adapter.crashAfter = crashAfter;
  try {
    return await runProgram(adapter, program);
  } catch (error) {
    return {
      program: program.name,
      completed: false,
      steps: [],
      guardFailure: {
        step: -1,
        phase: "precondition",
        predicateName: "adapter-available",
        observed: error instanceof Error ? error.message : String(error),
        reason: "adapter unusable",
      },
      finalState: null,
      lastGoodStep: null,
      lastGoodStateVersion: null,
    };
  }
}

describe("recovery ladder (ADR-0006)", () => {
  it("(a) intent already satisfied → idempotent resume, no retry, no relaunch", async () => {
    const filePath = tmpFile("satisfied");
    const adapter = new CrashableAdapter(filePath);
    const program = editProgram();
    // Complete the work, then fabricate the failed outcome as the
    // interruption evidence (steps executed; observe-after-action failure).
    const ok = await runProgram(adapter, program);
    expect(ok.completed).toBe(true);
    const failed: RunOutcome = {
      ...ok,
      completed: false,
      guardFailure: {
        step: program.steps.length - 1,
        phase: "postcondition",
        predicateName: "observe-after-action",
        observed: "connection lost after save",
        reason: "app became unobservable after the last step",
      },
    };
    const result = await runRecovery(
      adapter,
      program,
      failed,
      {
        // Read-only intent check: the edit landed AND the file was saved.
        intentSatisfied: async () => {
          const state = await adapter.observe();
          return findNode(state, "B2")?.value === NEW_VALUE && !state.facts.dirty;
        },
        relaunch: () => {
          throw new Error("relaunch must not be called when satisfied");
        },
      },
      { maxRetries: 2, isReversible: () => false },
    );
    expect(result.alreadySatisfied).toBe(true);
    expect(result.outcome.completed).toBe(true);
    expect(result.attempts.map((a) => a.event)).toEqual(["re-observe:already-satisfied"]);
    expect(result.attempts[0]?.stateVersion).toBe(failed.lastGoodStateVersion);
  });

  it("(b) transient observe failure then success → retried once, completed", async () => {
    const filePath = tmpFile("transient");
    const adapter = new CrashableAdapter(filePath);
    const program = editProgram();
    // Steps 0-1 executed (edit landed, unsaved); a transient bridge error
    // made the post-act observe fail at the save step (step 2).
    const partial = await runProgram(adapter, {
      ...program,
      steps: program.steps.slice(0, 2),
    });
    expect(partial.completed).toBe(true);
    const failed: RunOutcome = {
      ...partial,
      completed: false,
      guardFailure: {
        step: 2,
        phase: "postcondition",
        predicateName: "observe-after-action",
        observed: "transient bridge disposal",
        reason: "app became unobservable after step 2: transient",
      },
    };
    // App is alive and the edit is there but unsaved: the re-observe rung
    // must NOT stop (not satisfied), and one retry from step 2 completes.
    const result = await runRecovery(
      adapter,
      program,
      failed,
      {
        intentSatisfied: async () => {
          const state = await adapter.observe();
          return findNode(state, "B2")?.value === NEW_VALUE && !state.facts.dirty;
        },
        relaunch: () => {
          throw new Error("relaunch must not be needed: app alive");
        },
      },
      { maxRetries: 2, isReversible: () => true },
    );
    expect(result.alreadySatisfied).toBe(false);
    expect(result.outcome.completed).toBe(true);
    expect(result.attempts.map((a) => a.event)).toEqual(["retry:1-completed"]);
    // Merged evidence: original steps 0-1 + resumed step 2.
    expect(result.outcome.steps.map((s) => s.step)).toEqual([0, 1, 2]);
  });

  it("(c) app dead before save → relaunch + resume → completed with merged steps", async () => {
    const filePath = tmpFile("relaunch");
    const adapter = new CrashableAdapter(filePath);
    const program = editProgram();
    // Kill after act 2 (the setValue): the observe after it throws; the edit
    // is lost on relaunch (unsaved), so the program must redo steps 1-2.
    const failed = await runInterrupted(adapter, program, 2);
    expect(failed.completed).toBe(false);
    expect(failed.steps.map((s) => s.step)).toEqual([0]);
    expect(failed.guardFailure?.predicateName).toBe("observe-after-action");
    expect(adapter.appAlive).toBe(false);

    const result = await runRecovery(
      adapter,
      program,
      failed,
      {
        // Dead app: observe throws inside the hook → caught → not satisfied.
        intentSatisfied: async () => {
          const state = await adapter.observe();
          return findNode(state, "B2")?.value === NEW_VALUE && !state.facts.dirty;
        },
        relaunch: async () => adapter.relaunch(),
      },
      { maxRetries: 2, isReversible: () => true },
    );
    expect(result.outcome.completed).toBe(true);
    expect(adapter.relaunchCount.value).toBe(1);
    const events = result.attempts.map((a) => a.event);
    // Retries ran against the dead app (their observe threw before any
    // step), then the relaunch rung resumed to completion.
    expect(events).toContain("relaunch:resumed");
    expect(events).toContain("relaunch:completed");
    expect(events.at(-1)).toBe("relaunch:completed");
    // Relaunch lost the unsaved edit: the resumed run re-executed the edit
    // (step 1) and the save (step 2), keeping the pre-crash open step (0).
    expect(result.outcome.steps.map((s) => s.step)).toEqual([0, 1, 2]);
  });

  it("(d) app dead after save → no silent redo: relaunch rung skipped", async () => {
    const filePath = tmpFile("after-save");
    const adapter = new CrashableAdapter(filePath);
    const program = editProgram();
    // Kill after act 3 (the save): the edit IS on disk; relaunch would show
    // the edit persisted, but redoing could double-apply — refused.
    const failed = await runInterrupted(adapter, program, 3);
    expect(failed.completed).toBe(false);
    expect(failed.steps.map((s) => s.step)).toEqual([0, 1]);

    const result = await runRecovery(
      adapter,
      program,
      failed,
      {
        intentSatisfied: async () => {
          const state = await adapter.observe();
          return findNode(state, "B2")?.value === NEW_VALUE && !state.facts.dirty;
        },
        relaunch: () => {
          throw new Error("relaunch must not be called: save already dispatched");
        },
      },
      { maxRetries: 0, isReversible: () => false },
    );
    expect(result.outcome.completed).toBe(false);
    expect(adapter.relaunchCount.value).toBe(0);
    expect(result.attempts.map((a) => a.event)).toEqual([
      "re-observe:check-failed", // dead app: could not look
      "relaunch:skipped-not-reversible",
    ]);
    // Outcome unchanged: the caller aborts with uncertain + full trace.
    expect(result.outcome.guardFailure?.predicateName).toBe("observe-after-action");
  });

  it("(e) recovery never fabricates a verdict — a lying verifier still decides", async () => {
    const filePath = tmpFile("no-verdict");
    const adapter = new CrashableAdapter(filePath);
    const program = editProgram();
    const failed = await runInterrupted(adapter, program, 2);
    const result = await runRecovery(
      adapter,
      program,
      failed,
      {
        intentSatisfied: async () => false,
        relaunch: async () => adapter.relaunch(),
      },
      { maxRetries: 2, isReversible: () => true },
    );
    // The ladder's result carries no verdict: a lying verifier (one that
    // returns whatever it likes) is the ONLY verdict source, structurally.
    const resultKeys = Object.keys(result);
    expect(resultKeys).not.toContain("verdict");
    expect(resultKeys).not.toContain("status");
    // And the fake app's disk state (what a verifier would read) carries the
    // recovered edit — the verdict, whatever it is, is computed from this,
    // not from the ladder's claims.
    const state = await adapter.observe();
    expect(findNode(state, "B2")?.value).toBe(NEW_VALUE);
  });

  it("(f) bounded retries: persistent death stops after maxRetries, no loop", async () => {
    const filePath = tmpFile("bounded");
    const adapter = new CrashableAdapter(filePath);
    const program = editProgram();
    const failed = await runInterrupted(adapter, program, 2);
    expect(adapter.appAlive).toBe(false);

    // App stays dead AND relaunch always fails: the ladder must terminate.
    let relaunchTries = 0;
    const result = await runRecovery(
      adapter,
      program,
      failed,
      {
        intentSatisfied: async () => false,
        relaunch: async () => {
          relaunchTries += 1;
          return false;
        },
      },
      { maxRetries: 2, isReversible: () => true },
    );
    expect(relaunchTries).toBe(1); // relaunch attempted exactly once
    expect(result.outcome.completed).toBe(false);
    const retryAttempts = result.attempts.filter((a) => a.rung === "retry");
    expect(retryAttempts.length).toBe(2); // bounded, never more
    expect(result.attempts.at(-1)?.event).toBe("relaunch:failed");
  });
});
