# Host-only Writer oracle (TIF-99 / M2-08)

Status: foundation, built for M2 plan row M2-08 (scorecard R5/R6 Writer half). Host only, no VM.

## What it is

A read path and oracle for saved LibreOffice Writer / Word documents (`.odt`, `.docx`) that
returns the same three-valued verdict as the Calc oracle (`src/core/verify.ts`):
`verified`, `refuted`, `uncertain`. It runs anywhere Node runs. LibreOffice is not needed
to read a document; it is used only to produce real-LibreOffice test fixtures.

| File | Role |
|---|---|
| `src/tasks/writer-doc-edit.ts` | Task family `writer-doc-edit`: deterministic fixture per seed, intent params, host-side `groundTruth()` |
| `src/verify/writer-xml.ts` | Strict XML parser: any well-formedness error throws |
| `src/verify/writer-reader.ts` | Strict ZIP reader (EOCD, local/central agreement, size, CRC-32) and `.docx` / `.odt` parsing into a normalised `WriterDocument` |
| `src/verify/writer-oracle.ts` | `verifyWriterFile(path, intent)` and `checkPostcondition()`: verdict plus a reason `code` |
| `src/tasks/writer-docgen.ts` | Host generator: spec to `.docx` / `.odt` bytes, plus damaged variants |
| `scripts/writer-lo-fixtures.ts` | Re-saves generated documents with headless LibreOffice into `test/fixtures/writer-lo/` |

## Postconditions (checks on the saved file)

| Kind | Params | Holds when |
|---|---|---|
| `paragraph-text` | `paragraph`, `newText` | top-level paragraph #i (tables excluded, headings included) has exactly `newText` |
| `heading-level` | `headingText`, `level` | the one paragraph with exactly that text is a heading of outline level `level` |
| `table-cell` | `table`, `cell` (`B2`), `newText` | table #t's cell, named as Writer names cells, has exactly `newText` |
| `paragraph-style` | `paragraph`, `style` | top-level paragraph #i uses the paragraph style with that display name |

Heading level: `.odt` `text:h/@text:outline-level`; `.docx` direct `w:outlineLvl`, else the
style's `basedOn` chain, else a `heading N` style name. Style name: `.odt` automatic style
to parent common style to `style:display-name`; `.docx` `w:pStyle` (or the default
paragraph style) to `w:name`. Text excludes tracked deletions, field codes, notes,
annotations and drawings.

## Reason codes

| Code | Status | Meaning |
|---|---|---|
| `postcondition-holds` | verified | the only `verified` code |
| `value-mismatch` | refuted | read in full; target holds another value |
| `target-absent` | refuted | read in full; the target paragraph, table or cell is gone |
| `ambiguous-target` | uncertain | more than one paragraph carries the heading text |
| `merged-cell` | uncertain | the table has spanned, covered or nested cells, so cell names are ambiguous |
| `style-unresolved` | uncertain | the style name or level depends on a style the file does not define |
| `read-missing` | uncertain | no file (Calc's `PersistedStateReadError` cause `missing`) |
| `read-unreadable` | uncertain | not a Writer document, encrypted, ZIP64, strict OOXML, unexpected namespaces |
| `read-corrupt` | uncertain | empty, truncated, bad CRC or size, partially saved (XML cut short), missing main part |
| `ground-truth-invalid` | uncertain | intent params do not yield a ground truth (wrong task, bad target, a no-op task) |

Uncertain reasons start with `could not look:`, as Calc's do. `WRITER_REASON_STATUS` is the
single mapping; a test pins that only `postcondition-holds` maps to `verified`.

## Verdict integrity (plan R4)

Expected values come only from `groundTruth(params)`: the fixture is regenerated from
`fixtureSeed` and the target checked against it. `writer-doc-edit.ts` imports nothing but
the `TaskIntent` type and the seed hash (a test pins its import list), so no saved file,
agent claim, screen text or trace event reaches the expectation. Unknown params (an
agent-added `expected` or `claim`) are dropped by `normalizeWriterParams`. A task whose
expected value equals the fixture's current value is rejected, since it could not tell an
agent that did nothing from one that did the work. The isolation of the intent itself from
the agent is M2-03's job.

## Test documents

Generated on the host, two ways:

1. **Our generator** (`writer-docgen.ts`, pure TypeScript, byte-stable): pristine, edited,
   wrong-value and target-deleted documents; damaged variants: empty, truncated at every
   1/40th, one byte flipped across the main part's compressed data, partially saved (main
   XML part cut and re-zipped with a valid CRC), main part missing, not a ZIP, wrong
   package type.
2. **Headless LibreOffice 24.2.7.2** (`scripts/writer-lo-fixtures.ts`): the pristine and
   edited documents re-saved by LibreOffice in the other format (`docx -> odt` with
   `writer8`, `odt -> docx` with `Office Open XML Text`). Committed with a SHA-256 manifest,
   because CI has no LibreOffice. Regenerating changes bytes (LibreOffice stamps metadata),
   not verdicts.

## Not in this PR

- A live (UNO) read of an open Writer document and an `isModified` check, as Calc's
  `UnoVerifier` does: this is the host-only path.
- A collateral-damage check (everything outside the target unchanged).
- The R5 mutation report itself (M2-09) reuses the damaged-variant generators here.
