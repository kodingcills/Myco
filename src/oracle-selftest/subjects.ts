/**
 * Self-test subjects (M2-09 / R5): the hand-written oracles on main, each with its seeded
 * cases. Each oracle is called through its real read path on a real file, so the self-test
 * exercises what runs, not a re-implementation.
 *
 *  - `calc-record-edit/csv`: M1's persisted-state verifier (`calcRecordEditVerifier` over
 *    `readCsvSpreadsheet`), with the eval harness's rule that a `PersistedStateReadError` is
 *    `uncertain` (`src/core/eval.ts`).
 *  - `writer-doc-edit`: the host-only Writer oracle (`verifyWriterFile`, TIF-99), all four
 *    postcondition kinds, in both `.docx` and `.odt`.
 *
 * The whole-document Calc gate and the multi-step Calc family (TIF-270, #485) join as
 * subjects when they land; agent-written oracles join through the same `OracleUnderTest`.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PersistedStateReadError, readCsvSpreadsheet } from "../core/filepersist.ts";
import type { TaskIntent } from "../core/verify.ts";
import { calcRecordEditFamily } from "../gate/families.ts";
import { calcRecordEditVerifier, intentFor } from "../tasks/calc-record-edit.ts";
import { DATA_COLUMNS, generateFixture } from "../tasks/fixture.ts";
import { type CalcRecordEditParams, generateParameterSets } from "../tasks/intent.ts";
import {
  applyGroundTruth,
  BODY_STYLE,
  groundTruth,
  NOTE_STYLE,
  paragraphsOf,
  WRITER_POSTCONDITION_KINDS,
  type WriterDocSpec,
  type WriterGroundTruth,
  writerFixture,
  writerIntentFor,
  writerTaskFor,
} from "../tasks/writer-doc-edit.ts";
import {
  flippedByte,
  partiallySaved,
  truncated,
  type WriterFormat,
  withoutMainPart,
  writeWriterDocument,
} from "../tasks/writer-docgen.ts";
import { verifyWriterFile } from "../verify/writer-oracle.ts";
import type { CorruptionClass, OracleUnderTest, SavedDocument, SelfTestCase } from "./types.ts";

/** Write `doc` to a fresh temp dir, run `read` on its path, and clean up. */
function withFile<T>(doc: SavedDocument, read: (path: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "myco-oracle-selftest-"));
  try {
    const path = join(dir, doc.fileName);
    if (doc.bytes !== null) writeFileSync(path, doc.bytes);
    return read(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const utf8 = (text: string) => new TextEncoder().encode(text);

// ---------------------------------------------------------------------------
// calc-record-edit (M1), CSV persisted path
// ---------------------------------------------------------------------------

export const calcRecordEditOracle: OracleUnderTest<CalcRecordEditParams> = {
  name: "calc-record-edit/csv",
  version: "m1",
  // Target-only by design: collateral damage is TIF-270's whole-document check. CSV has no
  // integrity marker, so a truncation that keeps the target row is invisible to it.
  claims: new Set<CorruptionClass>(["edit-missing", "wrong-value", "wrong-target", "missing-file"]),
  verify(doc, params) {
    return withFile(doc, (path) => {
      try {
        const v = calcRecordEditVerifier.verify(readCsvSpreadsheet(path), intentFor(params));
        // Codes from the status only: the verifier's reasons name the file path.
        const code =
          v.status === "verified"
            ? "postcondition-holds"
            : v.status === "refuted"
              ? "value-mismatch"
              : "could-not-look";
        return { status: v.status, code };
      } catch (error) {
        if (error instanceof PersistedStateReadError)
          return { status: "uncertain", code: `read-${error.cause}` };
        throw error;
      }
    });
  },
};

/**
 * The gate's `calc-record-edit` family (version 2, TIF-270 / #485), over the same CSV bytes:
 * a whole-document diff against the pristine fixture plus the edit. The adapter follows the
 * gate's documented contract (`src/gate/gate.ts`): a missing file, and a `decide` that
 * throws (including unreadable bytes), are `uncertain`.
 */
export const calcGateOracle: OracleUnderTest<CalcRecordEditParams> = {
  name: "calc-record-edit/gate",
  version: `gate-family-${calcRecordEditFamily.version}`,
  claims: new Set<CorruptionClass>([
    "edit-missing",
    "wrong-value",
    "wrong-target",
    "collateral",
    "truncated",
    "missing-file",
  ]),
  verify(doc, params) {
    if (doc.bytes === null) return { status: "uncertain", code: "state-missing" };
    try {
      const out = calcRecordEditFamily.decide(doc.bytes, { ...params }, "oracle-selftest");
      const code =
        out.status === "verified"
          ? "postcondition-holds"
          : out.status === "refuted"
            ? (out.codes ?? []).join("+") || "refuted"
            : "oracle-uncertain";
      return { status: out.status, code };
    } catch {
      return { status: "uncertain", code: "oracle-threw" };
    }
  },
};

function editCsv(
  csv: string,
  edits: ReadonlyArray<{ rowKey: string; column: string; value: string }>,
): string {
  const rows = csv
    .trimEnd()
    .split("\n")
    .map((l) => l.split(","));
  const header = rows[0] as string[];
  for (const e of edits) {
    const col = header.indexOf(e.column);
    const row = rows.findIndex((r, i) => i > 0 && r[0] === e.rowKey);
    if (col < 1 || row < 1) throw new Error(`self-test fixture has no ${e.rowKey}/${e.column}`);
    (rows[row] as string[])[col] = e.value;
  }
  return `${rows.map((r) => r.join(",")).join("\n")}\n`;
}

export function calcCases(count = 10): SelfTestCase<CalcRecordEditParams>[] {
  const seeds = Array.from(
    { length: 10 },
    (_, i) => `oracle-selftest-${String(i + 1).padStart(2, "0")}`,
  );
  return generateParameterSets(seeds)
    .slice(0, count)
    .map((p, i) => {
      const fixture = generateFixture(p.fixtureSeed);
      const names = DATA_COLUMNS.map((c) => c.name);
      const neighbour = names[(names.indexOf(p.column) + 1) % names.length] as string;
      const otherKey = fixture.rows.find((r) => r[0] !== p.rowKey)?.[0] as string;
      const correct = editCsv(fixture.csv, [
        { rowKey: p.rowKey, column: p.column, value: p.newValue },
      ]);
      const doc = (text: string | null): SavedDocument => ({
        fileName: "doc.csv",
        bytes: text === null ? null : utf8(text),
      });
      const bytes = utf8(correct);
      return {
        id: `calc-${String(i + 1).padStart(2, "0")}`,
        intent: p,
        correct: doc(correct),
        corruptions: [
          { cls: "edit-missing", doc: doc(fixture.csv) },
          {
            cls: "wrong-value",
            doc: doc(
              editCsv(fixture.csv, [
                { rowKey: p.rowKey, column: p.column, value: `${p.newValue}9` },
              ]),
            ),
          },
          {
            cls: "wrong-target",
            doc: doc(
              editCsv(fixture.csv, [{ rowKey: p.rowKey, column: neighbour, value: p.newValue }]),
            ),
          },
          {
            cls: "collateral",
            doc: doc(
              editCsv(correct, [{ rowKey: otherKey, column: "name", value: "Collateral Edit" }]),
            ),
          },
          { cls: "truncated", doc: { fileName: "doc.csv", bytes: truncated(bytes, 0.5) } },
          { cls: "missing-file", doc: doc(null) },
        ],
      };
    });
}

// ---------------------------------------------------------------------------
// writer-doc-edit (TIF-99), .docx and .odt
// ---------------------------------------------------------------------------

export const writerOracle: OracleUnderTest<TaskIntent> = {
  name: "writer-doc-edit",
  version: "1",
  // Target-only, like M1's Calc verifier: other content is not compared.
  claims: new Set<CorruptionClass>([
    "edit-missing",
    "wrong-value",
    "wrong-target",
    "truncated",
    "corrupt-byte",
    "partial-save",
    "missing-main-part",
    "missing-file",
  ]),
  verify(doc, intent) {
    return withFile(doc, (path) => {
      const v = verifyWriterFile(path, intent);
      return { status: v.status, code: v.code };
    });
  },
};

/** The same edit with a different value. */
function wrongValue(gt: WriterGroundTruth): WriterGroundTruth {
  switch (gt.kind) {
    case "paragraph-text":
    case "table-cell":
      return { ...gt, expected: `${gt.expected} Wrong` };
    case "heading-level":
      return { ...gt, expected: gt.expected === 9 ? 8 : gt.expected + 1 };
    case "paragraph-style":
      return { ...gt, expected: gt.expected === NOTE_STYLE ? BODY_STYLE : NOTE_STYLE };
  }
}

/** The right value, applied to a neighbouring target. */
function wrongTarget(gt: WriterGroundTruth, spec: WriterDocSpec): WriterGroundTruth {
  const paragraphs = paragraphsOf(spec);
  const neighbourParagraph = (p: number) => (p + 1 < paragraphs.length ? p + 1 : p - 1);
  switch (gt.kind) {
    case "paragraph-text":
    case "paragraph-style":
      return { ...gt, paragraph: neighbourParagraph(gt.paragraph) };
    case "table-cell": {
      const col = gt.col === 0 ? 1 : gt.col - 1;
      return { ...gt, col, cell: `${String.fromCharCode(65 + col)}${gt.row + 1}` };
    }
    case "heading-level": {
      const other = paragraphs.find((p) => p.text !== gt.text && p.headingLevel === null);
      return { ...gt, text: other?.text ?? gt.text };
    }
  }
}

/** The correct document with one other paragraph's text changed. */
function withCollateral(spec: WriterDocSpec, gt: WriterGroundTruth): WriterDocSpec {
  const paragraphs = paragraphsOf(spec);
  const target = gt.kind === "paragraph-text" || gt.kind === "paragraph-style" ? gt.paragraph : -1;
  const victim = paragraphs.findIndex(
    (p, i) => i !== target && p.headingLevel === null && ("text" in gt ? p.text !== gt.text : true),
  );
  let seen = -1;
  return {
    blocks: spec.blocks.map((b) => {
      if (b.kind !== "paragraph") return b;
      seen++;
      return seen === victim ? { ...b, text: `${b.text} (collateral)` } : b;
    }),
  };
}

export function writerCases(
  seeds: readonly string[] = ["ws-1", "ws-2", "ws-3"],
): SelfTestCase<TaskIntent>[] {
  const cases: SelfTestCase<TaskIntent>[] = [];
  for (const seed of seeds) {
    for (const kind of WRITER_POSTCONDITION_KINDS) {
      for (const format of ["docx", "odt"] as const satisfies readonly WriterFormat[]) {
        const params = writerTaskFor(seed, kind);
        const gt = groundTruth(params);
        const fixture = writerFixture(seed);
        const correctSpec = applyGroundTruth(fixture, gt);
        const write = (spec: WriterDocSpec) => writeWriterDocument(spec, format);
        const correct = write(correctSpec);
        const doc = (bytes: Uint8Array | null): SavedDocument => ({
          fileName: `doc.${format}`,
          bytes,
        });
        cases.push({
          id: `writer-${seed}-${kind}-${format}`,
          intent: writerIntentFor(params),
          correct: doc(correct),
          corruptions: [
            { cls: "edit-missing", doc: doc(write(fixture)) },
            { cls: "wrong-value", doc: doc(write(applyGroundTruth(fixture, wrongValue(gt)))) },
            {
              cls: "wrong-target",
              doc: doc(write(applyGroundTruth(fixture, wrongTarget(gt, fixture)))),
            },
            { cls: "collateral", doc: doc(write(withCollateral(correctSpec, gt))) },
            { cls: "truncated", doc: doc(truncated(correct, 0.5)) },
            { cls: "corrupt-byte", doc: doc(flippedByte(correct, Math.floor(correct.length / 2))) },
            { cls: "partial-save", doc: doc(partiallySaved(correctSpec, format, 0.5)) },
            { cls: "missing-main-part", doc: doc(withoutMainPart(correctSpec, format)) },
            { cls: "missing-file", doc: doc(null) },
          ],
        });
      }
    }
  }
  return cases;
}
