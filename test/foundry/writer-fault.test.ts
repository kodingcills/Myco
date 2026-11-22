import { describe, expect, it } from "vitest";
import { traceEventSchema } from "../../schemas/trace-events.ts";
import { validateSchema } from "../../schemas/validate.ts";
import { injectWriterFault } from "../../src/foundry/faults/index.ts";
import { scoreTrial } from "../../src/foundry/oracles/blind.ts";
import { verifyPersistedState } from "../../src/foundry/oracles/state.ts";
import { writerStateOracle } from "../../src/foundry/oracles/writer.ts";
import {
  autocorrect,
  bootWriter,
  findWriterFixture,
  saveWriter,
  typeIntoCell,
  WRITER_FIXTURE_SPECS,
  writerFiles,
  writerScreen,
} from "../../src/foundry/tasks/writer.ts";
import type { TaskIntent } from "../../src/foundry/types.ts";

const spec = WRITER_FIXTURE_SPECS[0]!;
const fixture = findWriterFixture(spec.fixtureId)!;
const TYPED = "1,200.00 (c) 2026";
const intent: TaskIntent = { kind: "writer.set-cell", table: "Invoice", cell: "B3", value: TYPED };

function typed() {
  return typeIntoCell(bootWriter(spec), "B3", TYPED);
}

describe("EF-003 Writer AutoCorrect fault", () => {
  it("AutoCorrect rewrites the typed text, and the rewrite is not the typed text", () => {
    expect(autocorrect(TYPED)).toBe("1,200.00 © 2026");
    expect(autocorrect(TYPED)).not.toBe(TYPED);
  });

  it("a clean save stores exactly what the user typed", () => {
    const saved = saveWriter(typed());
    const verdict = verifyPersistedState(
      writerStateOracle(),
      intent,
      fixture.initialState,
      writerFiles(saved),
    );
    expect(verdict.status).toBe("verified");
  });

  it("the fault stores the rewrite while the screen keeps the typed text", () => {
    const { doc, event, faultVersion } = injectWriterFault(typed(), {
      fault: "autocorrect-rewrite",
      version: 1,
      seed: 7,
    });
    expect(validateSchema(event, traceEventSchema)).toEqual([]);
    expect(faultVersion).toBe(1);

    // The screen is what the user typed; the document is what AutoCorrect made of it.
    expect(writerScreen(doc)).toContain(`B3: ${TYPED}`);
    const stored = new TextDecoder().decode(writerFiles(doc)["word/document.xml"]!);
    expect(stored).toContain("1,200.00 © 2026");
    expect(stored).not.toContain(TYPED);

    // The state oracle refuses it, and the screen claim is what makes it a false success.
    const verdict = verifyPersistedState(
      writerStateOracle(),
      intent,
      fixture.initialState,
      writerFiles(doc),
    );
    expect(verdict.status).toBe("refuted");
    expect(verdict.reasons.join(" ")).toContain("writer:cell:B3");
  });

  it("a credulous agent that trusts the screen is scored a false success", () => {
    const { doc } = injectWriterFault(typed(), {
      fault: "autocorrect-rewrite",
      version: 1,
      seed: 3,
    });
    const result = scoreTrial({
      fixture,
      intent,
      actual: { kind: "writer-table", files: writerFiles(doc) },
      screen: { visibleText: writerScreen(doc), reachable: true },
      trace: [],
      selfReport: { claimsSuccess: true, text: "Total set to 1,200.00 (c) 2026 and saved." },
      faultVersion: 1,
    });
    expect(result.verdict).toBe("refuted");
    expect(result.falseSuccess).toBe(true);
    expect(result.reasons.join(" ")).toContain("FALSE SUCCESS");
  });

  it("an agent that re-reads the document and corrects it recovers to verified", () => {
    const { doc } = injectWriterFault(typed(), {
      fault: "autocorrect-rewrite",
      version: 1,
      seed: 3,
    });
    // Re-read the stored text, then type the intended value again with AutoCorrect off.
    const reread = { ...doc, cells: { ...doc.cells, B3: TYPED } };
    const recovered = saveWriter(reread);
    expect(
      verifyPersistedState(
        writerStateOracle(),
        intent,
        fixture.initialState,
        writerFiles(recovered),
      ).status,
    ).toBe("verified");
  });

  it("the fault is deterministic and versioned", () => {
    const a = injectWriterFault(typed(), { fault: "autocorrect-rewrite", version: 1, seed: 9 });
    const b = injectWriterFault(typed(), { fault: "autocorrect-rewrite", version: 1, seed: 9 });
    expect(a.doc.files).toEqual(b.doc.files);
    expect(a.event).toEqual(b.event);
    expect(() =>
      injectWriterFault(typed(), { fault: "autocorrect-rewrite", version: 0, seed: 1 }),
    ).toThrow(/Invalid fault version/);
  });

  it("refuses to arm a todo-store fault on a Writer document", () => {
    expect(() => injectWriterFault(typed(), { fault: "stale-ui", version: 1, seed: 1 })).toThrow(
      /cannot arm stale-ui/,
    );
  });

  it("an unreadable document is uncertain, never refuted", () => {
    const verdict = verifyPersistedState(writerStateOracle(), intent, fixture.initialState, {
      "word/document.xml": new TextEncoder().encode("<not-a-document/>"),
    });
    expect(verdict.status).toBe("uncertain");
  });

  it("a missing document is uncertain, never refuted", () => {
    const verdict = verifyPersistedState(writerStateOracle(), intent, fixture.initialState, {});
    expect(verdict.status).toBe("uncertain");
  });

  it("an intent naming a cell the document does not hold is uncertain, not a silent pass", () => {
    const verdict = verifyPersistedState(
      writerStateOracle(),
      { kind: "writer.set-cell", table: "Invoice", cell: "Z9", value: "x" },
      fixture.initialState,
      writerFiles(saveWriter(typed())),
    );
    expect(verdict.status).toBe("uncertain");
  });

  it("the fixture's initial state does not already satisfy the task", () => {
    const verdict = verifyPersistedState(writerStateOracle(), intent, fixture.initialState, {
      "word/document.xml":
        fixture.initialState.kind === "writer-table"
          ? fixture.initialState.bytes
          : new Uint8Array(),
    });
    expect(verdict.status).toBe("refuted");
  });
});
