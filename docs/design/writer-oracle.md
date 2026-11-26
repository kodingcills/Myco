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
| `src/verify/writer-reader.ts` | Strict, bounded ZIP reader (EOCD, local/central agreement, size, CRC-32, inflate limits) and `.docx` / `.odt` parsing into a normalised `WriterDocument` |
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
| `read-unreadable` | uncertain | not a Writer document, encrypted, ZIP64, strict OOXML, unexpected namespaces, main part not typed as WordprocessingML in `[Content_Types].xml`, over a read limit (below) |
| `read-corrupt` | uncertain | empty, truncated, bad CRC or size, a part inflating past its declared size, duplicate entries, partially saved (XML cut short), not UTF-8, XML nested deeper than 256, missing main part |
| `ground-truth-invalid` | uncertain | intent params do not yield a ground truth (wrong task, bad target, a no-op task) |

Uncertain reasons start with `could not look:`, as Calc's do. `WRITER_REASON_STATUS` is the
single mapping; a test pins that only `postcondition-holds` maps to `verified`.

## Bounded reads (round-1 verifier D1, D2)

A hostile file must not make the oracle allocate without bound; past a limit the verdict
is `uncertain`, never a crash, a hang or a verdict.

| Limit | Value | Why that value |
|---|---|---|
| Parts inflated | only `mimetype`, `content.xml`, `styles.xml` (odt); `[Content_Types].xml`, `_rels/.rels`, the main part, its rels, its styles part (docx) | nothing else is read, so nothing else is decompressed; an unused entry's CRC is not checked (it cannot move a verdict) |
| Inflate output | `maxOutputLength` = the entry's declared size | a header that understates a stream fails at the declared size (`read-corrupt`), not in memory |
| `ZIP_LIMITS.maxPartBytes` | 16 MiB declared per inflated part | a few hundred pages of text is a main part of a few MiB |
| `ZIP_LIMITS.maxTotalBytes` | 32 MiB inflated per read | two or three parts at the part limit |
| Bomb signature | any entry, used or not, declaring over 16 MiB at over 100:1 | images, fonts and media that large deflate near 1:1; such an entry is never a part the reader inflates, so the archive is refused (`read-unreadable`) rather than verified around it |
| `ODT_LIMITS.maxRepeat` | 1024 per repeat or span attribute (`read-corrupt` above) | unchanged from round 1 |
| `ODT_LIMITS.maxTableCells` | 50,000 expanded cells per table | Writer tables are small; a long report's biggest table is a few thousand cells. Counted from the attributes before any cell is built |
| `ODT_LIMITS.maxDocumentCells` | 200,000 expanded cells across all tables, nested included | |
| `ODT_LIMITS.maxSpaces` | 1,000,000 spaces from `text:s/@text:c` per document | |
| `MAX_XML_DEPTH` | 256 nested elements (`read-corrupt` above) | real Writer XML nests a few dozen levels; the parser and readers are recursive |

Repeated ODF rows and cells are read once and shared by reference, so a legal repeated
table costs its distinct cells, not its expanded size. Measured on the verifier's
fixtures (child process peak RSS; `node --import tsx` alone is about 55 MB):

| Fixture | Size | Round 1 | Round 2 |
|---|---|---|---|
| odt repeat bomb, n=200 | 1,672 B | heap OOM abort | uncertain `read-unreadable`, 56 MB, 3 ms |
| odt repeat bomb, n=20 | 1,616 B | verified, 1,121 MB | uncertain `read-unreadable`, 69 MB, 3 ms |
| docx + 8 x 512 MiB zeros | 4.25 MB | verified, 5,208 MB | uncertain `read-unreadable`, 64 MB, 5 ms |
| odt + 8 x 512 MiB zeros | 4.25 MB | verified, 5,207 MB | uncertain `read-unreadable`, 67 MB, 5 ms |
| docx + 1 x 512 MiB zeros | 533 KB | verified, 1,607 MB | uncertain `read-unreadable`, 59 MB, 2 ms |

The tests build these fixtures in memory (`test/writer-hostile.ts`, nothing large is
committed) and verify them in a child process (`test/writer-hostile-child.ts`) with a
512 MB heap cap, asserting the verdict, peak RSS under 200 MB and under 2 s.

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
   because CI has no LibreOffice. Regenerating is expected to change bytes (LibreOffice
   stamps metadata) and not verdicts; that expectation is not checked in CI, which cannot
   run LibreOffice, only by re-running the script and the tests by hand.

## Scope of the check: the target, not the whole document

The oracle checks the targeted element only. A saved file whose target holds the expected
value verifies even if other paragraphs or tables were changed or deleted. Under the lead's
ruling that R1 grades the whole document, the independent grader would reject such a run
while this oracle accepts it, which would count as a false DONE against R1. So **this
oracle must not gate an R1 trial until the collateral-damage follow-up lands** (compare
every block of the read document with `applyGroundTruth(writerFixture(seed), gt)`). That
was kept out of M2-08 because LibreOffice re-saves change block structure (extra empty
paragraphs, renamed built-in styles) and the comparison needs its own normalisation and
tests.

## Known conservative gaps

- ODT `text:p` paragraphs whose style sets `style:default-outline-level` read as body
  text, not headings (round-1 N2). This can only make a heading-level check refute or
  stay uncertain, never verify wrongly.
- `.docx` rows with `w:gridBefore` / `w:gridAfter` and cells with legacy `w:hMerge` mark
  the table as merged (`merged-cell`, uncertain) instead of computing shifted names.

## Not in this PR

- A live (UNO) read of an open Writer document and an `isModified` check, as Calc's
  `UnoVerifier` does: this is the host-only path.
- A collateral-damage check (everything outside the target unchanged); see above.
- An adapter to #470's `SealedOracle` (`(inputs: VerdictInputs) => Verdict`, in
  `src/integrity/`). The vault's `persisted` bytes go to `parseWriterDocument(bytes, name)`
  and its sealed `groundTruth` (a `WriterGroundTruth`) to `checkPostcondition`, so the
  adapter is small, but wiring it is the gate integration's job, not this foundation's.
- The R5 mutation report itself (M2-09) reuses the damaged-variant generators here.
