# The xlsx byte grammar the gate accepts

TIF-274 prerequisite. Replaces #503's parsed-tree allowlist (round 3, D8: BLOCKING).

**Lead ruling (12:42Z, after #503's round 3):** #503 does not ship and the gate stays CSV-only
until a fresh PR adds a raw-byte pre-scan and fixed part names. Binding: xlsx must FAIL
CLOSED; a false VERIFIED is the one thing the gate cannot do; never emulate LibreOffice's
reading. This document is that pre-scan's contract.

## Why bytes, not the tree

#503 checked its allowlist on the tree its XML parser built. By then comments were gone,
quoting and whitespace inside tags were normalised, namespace prefixes were resolved, and
parts had been found by following relationships. The independent grader
(`src/benchmark/grade/sheet.ts`) is a literal, regex-based reader of fixed part names. Every
shape the gate normalised but the grader read literally was a place the two diverged: the
gate verified 14 workbooks the grader failed (P01-P15, P46).

So the gate now looks at the bytes first, and accepts only the narrow serialisation
LibreOffice Calc writes. It does not try to read anything else the way LibreOffice would: it
refuses it, with a code (`uncertain` `STATE_CORRUPT`, never `verified`).

## Order of checks (`readXlsxDocument`, `src/gate/xlsx-document.ts`)

1. Zip layer: size, entry-count, ratio and total caps from the central directory before
   anything inflates; traversal, duplicate, encrypted and ZIP64 refusal; inflation bounded
   by the declared size, CRC checked (#503). Since round 2 of this PR, also **byte
   coverage**: the EOCD is exactly the last 22 bytes and carries **no comment**; the entries
   (local header, data, and the data descriptor LibreOffice writes after each, which must
   repeat the central directory's CRC and sizes) tile `[0, cdOffset)` with no gap or
   overlap; the central directory is `[cdOffset, eocd)`. No byte is left that no structure
   covers, so no decoy archive can sit in a comment, in front, between entries or behind
   (round 1, V6: the grader takes the last `PK\x05\x06` it finds). `XLSX_ZIP_MALFORMED`.
   Covered is not constrained: the local and central extra fields and the per-entry
   comments are bytes inside a structure, and nothing checks their content (both judges
   read the same directory and skip them). The local header's name must equal the central
   one, and the descriptor's CRC as well as its sizes must equal the central directory's;
   each of these and the EOCD comment-length check has its own test row
   (`test/gate/xlsx-round3-probes.test.ts`, "round-2 nits").
2. Active content by entry name (macros, external links, embedded objects).
3. **Part names** (`src/gate/xlsx-parts.ts`, `checkPartNames`): every entry is one of
   LibreOffice's fixed parts (below), or `XLSX_PART_UNEXPECTED`.
4. **Raw-byte pre-scan** (`src/gate/xlsx-prescan.ts`) of every part. No XML has been parsed
   yet.
5. Only then the parser: external relationship targets, content types, the workbook.
6. **Relationships** (`checkRelationships`): exact types and target strings, every part
   referenced, no decoy.
7. #503's parsed-tree allowlist for cell and string structure (kept, behind the pre-scan),
   the cell model, cached values only.
8. **Element tree** (`src/gate/xlsx-tree.ts`, `checkTree`; round 2 of this PR), over every
   part, before anything is returned. See "Element tree" below.

## Part names (exactly what LibreOffice writes)

| Entry | | Referenced by (raw `Target`, exact string) |
|---|---|---|
| `[Content_Types].xml` | required | the package |
| `_rels/.rels` | required | the package |
| `xl/workbook.xml` | required | `_rels/.rels`, `officeDocument` -> `xl/workbook.xml` |
| `xl/_rels/workbook.xml.rels` | required | the package |
| `xl/worksheets/sheetN.xml` (N >= 1, no leading zero) | one or more | workbook rels, `worksheet` -> `worksheets/sheetN.xml`, and a `<sheet r:id>` |
| `xl/sharedStrings.xml` | optional | workbook rels, `sharedStrings` -> `sharedStrings.xml` |
| `xl/styles.xml` | optional | workbook rels, `styles` -> `styles.xml` |
| `xl/theme/theme1.xml` | optional | workbook rels, `theme` -> `theme/theme1.xml` |
| `docProps/core.xml` | optional | `_rels/.rels`, `core-properties` -> `docProps/core.xml` |
| `docProps/app.xml` | optional | `_rels/.rels`, `extended-properties` -> `docProps/app.xml` |

Refused: any other entry, a worksheet relationships part, media, drawings
(`XLSX_PART_UNEXPECTED`); any other relationship type or target spelling (absolute, `./`,
another name), a duplicate id, two relationships to one part, an extra attribute, a `<sheet>`
naming no worksheet relationship (`XLSX_REL_TARGET`); any entry nothing references (a copy
left at a canonical name, a worksheet no `<sheet>` names), a content-type override naming no
entry (`XLSX_PART_UNREFERENCED`). A missing required part is `XLSX_NOT_WORKBOOK`.

## The byte grammar

Every part:

```
part    := DECL LF? content
DECL    := '<?xml version="1.0" encoding="UTF-8"?>'
         | '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
content := ( text | open | close )*        exactly one root element; outside it, LF only
text    := ( any byte except '<' '>' '&' | REF )*
REF     := '&amp;' | '&lt;' | '&gt;' | '&quot;' | '&apos;'
open    := '<' QNAME ( ' ' QNAME '="' value '"' )* ( '>' | '/>' )
close   := '</' QNAME '>'
value   := ( any byte except '"' '<' '>' '&' | REF )*
QNAME   := NAME ( ':' NAME )?               NAME := [A-Za-z_] [A-Za-z0-9_.-]*
```

Inside `<v>`: no `&` at all.

The pinned parts (workbook, worksheets, shared strings, styles, content types, the two
relationships parts) also:

| Root | Namespace declarations, exactly, in this order |
|---|---|
| `<workbook>` | `xmlns` = spreadsheetml main, `xmlns:r` = officeDocument relationships |
| `<worksheet>` | `xmlns` = main, `xmlns:r`, `xmlns:xdr` (spreadsheetDrawing), `xmlns:x14` (2009/9/main), `xmlns:xr2` (2015/revision2), `xmlns:mc` (markup-compatibility) |
| `<sst>`, `<styleSheet>` | `xmlns` = main |
| `<Types>` | `xmlns` = package content-types |
| `<Relationships>` | `xmlns` = package relationships |

- no namespace declaration below the root, except `xmlns:loext="http://schemas.libreoffice.org/"`
  on a workbook `<ext>` inside `<extLst>` (LibreOffice's `loext:extCalcPr`);
- no prefixed element outside an `<extLst>` of the workbook, a worksheet or styles; none at all
  in the shared strings, content types or relationships;
- no prefixed attribute other than `r:id` on `<sheet>` and `xml:space` on `<t>`;
- no text, not even whitespace, directly inside `sheetData`, `row`, `c`, `is`, `si`, `r`,
  `rPr`, `sst`, `sheets`, `Types` or `Relationships` (LibreOffice's one LF before `</Types>`
  and `</Relationships>` aside);
- no self-closing `<v/>` or `<t/>`.

docProps and the theme get the grammar but no namespace pin: no reader looks inside them.

### What LibreOffice writes, and what that left out

Derived from LibreOffice 24.2.7.2 `soffice --convert-to xlsx` output, committed:
`test/fixtures/calc-xlsx-writers/*.lo.xlsx` (from #503, `scripts/calc-xlsx-writer-fixtures.ts`)
and `test/fixtures/calc-xlsx-lo-grammar/` (this PR; the command is in its README).

- Declarations: the package parts (`[Content_Types].xml`, `.rels`) carry the first form, every
  other part the `standalone="yes"` form; the package parts end their root with an LF.
- Attributes: always double quotes, one space between attributes, none before `>` or `/>`.
- References: in text LibreOffice writes all five predefined escapes (`escapes.lo.xlsx`).
  It ALSO writes `&#9;` for a tab and `&#10;` for a line break (`tab-newline.lo.xlsx`). The
  pre-scan refuses every numeric reference anyway, so a workbook with a tab or a line break in
  a text cell is `uncertain`, never verified. That is deliberate: the fixture data has none,
  and accepting numeric references reopens P21/P35/P50.
- No comments, CDATA, DOCTYPE or processing instructions, ever.

### Codes

| Code | Rule |
|---|---|
| `XLSX_PRESCAN_DECL` | no declaration, or not one of the two |
| `XLSX_PRESCAN_COMMENT` | `<!--` |
| `XLSX_PRESCAN_CDATA` | `<![CDATA[` |
| `XLSX_PRESCAN_DTD` | any other `<!` |
| `XLSX_PRESCAN_PI` | `<?` other than the declaration |
| `XLSX_PRESCAN_QUOTE` | a single-quoted attribute value |
| `XLSX_PRESCAN_TAG_SPACE` | whitespace before `>` or `/>`, around `=`, two spaces, or a tab, CR or LF in a tag |
| `XLSX_PRESCAN_NAMESPACE` | the namespace rules above |
| `XLSX_PRESCAN_ENTITY` | a reference other than the five escapes; any reference in `<v>` |
| `XLSX_PRESCAN_TEXT` | text inside structure |
| `XLSX_PRESCAN_SYNTAX` | anything else outside the grammar |

Behind the pre-scan, the reader also refuses (`XLSX_CELL_MALFORMED` / `XLSX_STYLE_MALFORMED`)
five shapes LibreOffice never writes that #503 verified: `t="str"` without a formula, a
`t="d"` cell, a number not in its canonical spelling (`04242`, `4.242E3`), a non-canonical
style index (`s="00"`), and a `<dimension>` that is not the used range.

## Element tree (round 2: closes round 1's V1-V5 and V7)

The readers in steps 5-7 walk down from each root and see only the paths they read
(`sheetData` as a direct child of `worksheet`, `cellXfs` of `styleSheet`, ...). The grader
does not walk a tree: it regex-scans the whole text of a part and takes the first match (the
last, for `<numFmt>` and per `Relationship` id). Round 1 showed decoys the grader read and
the gate never saw: `<sheetData/>` inside `<sheetPr>` (V1), `<workbookPr date1904="true"/>`
inside `<fileVersion>` (V2), `<cellXfs>` inside `<fonts>` (V3), `<numFmt>` inside
`<borders>` (V4), a `<Relationship>` inside a `<Relationship>` (V5). Round 2 found one more
while building its nested-decoy family: a SECOND `<numFmts>` or `<workbookPr>` at its
canonical path (V7).

So every element of every pinned part (workbook, worksheets, shared strings, styles, content
types, relationships) must be at a path LibreOffice writes:

- for each parent path, an allowlist of child local names (`LO_TREES`): LibreOffice 24.2's
  tree in the committed fixtures, plus the cell and string shapes the cell reader accepts
  (inline strings, rich-text runs, `<f>`) and the formatting-only leaves of a font, fill and
  border record (bold, colour). None of the additions is a name either reader reads
  structurally, and all are leaves;
- a path that is not a key holds no element at all, so nothing can sit inside a
  `<Relationship>`, `<Override>`, `<Default>`, `<numFmt>`, `<v>` or any other leaf;
- a child not marked repeatable (`sheet`, `row`, `c`, `si`, `r`, `numFmt`, `font`, `fill`,
  `border`, `xf`, `cellStyle`, `col`, `workbookView`, `sheetView`, `selection`, `ext`,
  `Relationship`, `Override`, `Default`) appears at most once under its parent;
- every element is in the root's namespace, except `loext:extCalcPr` in the workbook's
  `<extLst>`.

So each `sheetData`, `row`, `c`, `sheet`, `sheets`, `workbookPr`, `cellXfs`, `numFmts`,
`numFmt`, `xf`, `si`, `Relationship`, `Override` and `Default` is at its canonical path, and
each singleton is the only one of its name. docProps and the theme are not pinned (neither
reader looks inside them) but may hold none of those names, or `t`, `v`, `f`, `is`, `r` or a
part root's name, anywhere (`checkUnpinnedTree`). `XLSX_TREE_ELEMENT`. The pin runs last, so
where an earlier reader check also refuses a shape, its more specific code is the one
reported.

## Consequences

- openpyxl files (single-quoted declarations, other root declarations) are refused. #503
  verified them; the ruling allows only LibreOffice's shapes.
- Our own generator (`src/tasks/calc-xlsxgen.ts`) now writes LibreOffice's worksheet root and
  the real `<dimension>`; its tab and CR text cells (`&#9;`, `&#13;`) are refused.
- #503's one soundness exception (a prefixed root the grader cannot read, verified by the
  gate) is refused by the pre-scan.
- What is claimed about soundness, and on what evidence. Round 1 of this PR claimed "whenever
  the gate verifies, the grader passes, with no exception"; that was false (V1-V6, 107 of the
  verifier's 1,584 generated variants). What is now enforced: the byte grammar, the fixed part
  names and relationships, byte coverage with no EOCD comment, and the element tree above.
  What is now tested: on every workbook the tests build (V1-V7 verbatim, P01-P53, the parity
  tables, and the 4,800 variants of the differential test, including 400 nested decoys and
  400 comment and coverage decoys over the four real LibreOffice fixtures), gate VERIFIED
  implies grader PASS. That is evidence over those shapes, not a proof over all inputs.

## Evidence

- `test/gate/xlsx-prescan.test.ts`: the grammar on hand-built byte strings, one refusing row
  per code, plus every part of every committed LibreOffice fixture accepted.
- `test/gate/xlsx-parts.test.ts`: part names and relationships, unit and end to end.
- `test/gate/xlsx-probes-503.test.ts`: #503's P01-P53, none verified.
- `test/gate/xlsx-differential.test.ts`: 4,800 seeded variants of the real LibreOffice
  workbooks over twelve families (400 each), among them `nestedDecoys` and `commentDecoys`
  (round 2); gate VERIFIED implies grader PASS on every one. Each family prints a `TALLY`
  line; the two round-2 families also count the variants that fool the grader (live decoys).
- `test/gate/xlsx-decoys.test.ts`: round 1's V1-V6 verbatim (and V7), each run through the
  gate's real read path and the grader; the zip coverage rules; `checkTree` unit rows; the
  `countNamed(workbook, "sheet")` and `dims.length > 1` guards pinned by their codes.
- `test/gate/xlsx-lo-grammar.test.ts`: LibreOffice's own references.
