# Finding M2-03 — Which Windows app should be Myco's *second* app?

> **Status: research input, not a product decision.**
> The earlier "M2 = MCP/API" direction is **retracted** pending MVP Discovery
> (Linear P-TIF-5). This finding feeds Discovery's choice between
> **A** (verified desktops for coding agents), **B** (verified ops for software
> without APIs), and **C** (branchable desktops). Where this doc recommends a
> surface or a build, read it as *one option's requirements*, not as the decided
> wedge. Task-design implications route to the Evaluation Foundry (P-TIF-6).

Date: 2026-11-21. Branch: `myco/m2-research`. Level: L2 (vendor docs + API references read directly; no app installed, no VM touched). Baseline: M1's `calc-record-edit` on LibreOffice Calc 26.8.3 ARM64 (docs/architecture/m1.md, src/verify/uno-verifier.ts).

## 1. Question

M1 proved verified execution in LibreOffice Calc: an edit proved by (a) live UNO readback, (b) `XModifiable.isModified()`, (c) close + host-side parse of the persisted file (`soffice --convert-to csv`, src/verify/uno-verifier.ts:1-20, 240-285). Which candidate gives the **cheapest second proof** — a second app whose *document state* is readable out-of-process by a read-only checker, without inventing a new verification theory?

Scored on: structural surface (document state, not widgets), ARM64 availability, licence, independent-checker cost, and whether a parameterized "record edit" analogue exists.

## 2. Evidence

### 2.1 LibreOffice Writer (baseline family, second component)

| Claim | Pointer | Limit |
|---|---|---|
| Body text is a UNO `XText`; `getString()` returns the document string | `com.sun.star.text.XTextDocument.getText()` — <https://api.libreoffice.org/docs/idl/ref/servicecom_1_1sun_1_1star_1_1text_1_1XTextDocument.html> §Member Function Documentation | Full-document string; per-*paragraph* identity needs `XParagraphCursor` |
| Per-range value read | `XTextRange.getString()` — <https://api.libreoffice.org/docs/idl/ref/interfacecom_1_1sun_1_1star_1_1text_1_1XTextRange.html> §getString | — |
| Paragraph-by-paragraph traversal | `XParagraphCursor.gotoNextParagraph/isStartOfParagraph/isEndOfParagraph` — <https://api.libreoffice.org/docs/idl/ref/interfacecom_1_1sun_1_1star_1_1text_1_1XParagraphCursor.html> | Cursor movement, not an index; paragraph N is counted from the start |
| **Tables are readable by cell name, exactly like Calc cells** | `XTextTable.getCellByName("D3")`, `getCellNames()`, `XCellRange.getCellByPosition(col,row)` — <https://api.libreoffice.org/docs/idl/ref/interfacecom_1_1sun_1_1star_1_1text_1_1XTextTable.html> §getCellByName | Name scheme documented: "The cell in the 4th column and third row has the name D3"; split cells get `D3.1.1` |
| The cell object carries both `XCell` (`getValue/getFormula/getError`) and `XText` (`getString`) | `com.sun.star.text.Cell` exported interfaces — <https://api.libreoffice.org/docs/idl/ref/servicecom_1_1sun_1_1star_1_1text_1_1Cell.html> §Exported Interfaces | The existing `get_string`/`get_value` UNO call shape transfers unchanged |
| All tables in a document are enumerable | `XTextTablesSupplier.getTextTables()` → `com.sun.star.text.TextTables` (`XIndexAccess`+`XNameAccess`) — <https://api.libreoffice.org/docs/idl/ref/servicecom_1_1sun_1_1star_1_1text_1_1XTextDocument.html>, <https://api.libreoffice.org/docs/idl/ref/servicecom_1_1sun_1_1star_1_1text_1_1TextTables.html> | — |
| Unsaved-changes flag | `com.sun.star.util.XModifiable.isModified()` (already used, docs/research/adapters.md §4.3) | Document-level, not per-paragraph |
| Persisted-file check | `soffice --convert-to "txt:Text (encoded):UTF8" *.doc`; filter table "Filters for WRITER" lists `Text` → `.txt` and `Text (encoded)` → `.txt` — <https://help.libreoffice.org/latest/en-US/text/shared/guide/convertfilters.html> §Filters for WRITER | Plain text loses table structure. A Writer→CSV table conversion is **not published**; `[INFERENCE]` the robust persisted path for table cells is a host-side `word/document.xml` (`w:tbl`/`w:tc`) parse of the saved `.docx` |
| ARM64 | `LibreOffice_26.8.3_Win_aarch64.msi` (345 MB, 2026-11-11) in `stable/26.8.3/win/aarch64/`, alongside `_sdk.msi` and helppacks — <https://download.documentfoundation.org/libreoffice/stable/26.8.3/win/aarch64/> | Same MSI already installed on the VM (docs/env/windows.md §Live environment) |
| Licence | MPL-2.0, based on Apache-2.0 OpenOffice code, plus other OSS components — <https://www.libreoffice.org/licenses/> | Fixture redistribution unaffected; we generate fixtures ourselves |

**AutoCorrect liability.** Writer runs AutoCorrect while typing (replace table, `Tools - AutoCorrect Options - Replace` — <https://help.libreoffice.org/latest/en-US/text/shared/01/06040200.html>). Same class of mutation as M1's ready-made corrupted-trial fixture (docs/env/windows.md §Guest findings 3): an asset for the *fault* suite, a hazard for the *normal* suite.

### 2.2 LibreOffice Impress

| Claim | Pointer | Limit |
|---|---|---|
| Document state lives in shapes on pages, not in a text object | `com.sun.star.drawing.DrawingDocument` / `DrawPages` / `GenericDrawPage` services — <https://api.libreoffice.org/docs/idl/ref/namespacecom_1_1sun_1_1star_1_1drawing.html> §Classes | No `getText()` on the document |
| Text is reachable only through a text-bearing shape | `com.sun.star.drawing.TextShape` includes `com.sun.star.drawing.Text` — <https://api.libreoffice.org/docs/idl/ref/servicecom_1_1sun_1_1star_1_1drawing_1_1TextShape.html> §Included Services | Which shape is "the title" is a fixture convention, not an API fact |
| Shape identity | `com.sun.star.drawing.Shape` properties `Name`, `ZOrder`, `Title`, `Description` — same page §Public Attributes | Localised default names ("Title 1") are an ambiguity source |
| ARM64 / licence | Same LibreOffice MSI and MPL-2.0 (§2.1) | — |

**Verdict on Impress:** readable (shape → text → `getString()`), but the verifier needs a shape-resolution convention (page index + shape name) that lands in *fixture design*, not in a published object model — strictly worse than Calc's `(sheet, cell)` or Writer's `(table, "D3")`.

### 2.3 Notepad++

| Claim | Pointer | Limit |
|---|---|---|
| Document text is Scintilla; the container exposes the editor handle | `NPPM_GETCURRENTSCINTILLA` returns 0 (main view) / 1 (second view); "you need to use one of the two Scintilla handles as the first parameter to SendMessage" — <https://npp-user-manual.org/docs/plugin-communication/> §NPPM_GETCURRENTSCINTILLA, §Aside: Internal Messages | A raw `HWND`: only same-desktop, same-session processes can read it |
| Full text read, any length | `SCI_GETTEXT(length, char*)`; "If the text argument is NULL(0) then the length that should be allocated… is returned", preceded by `SCI_GETLENGTH` — <https://www.scintilla.org/ScintillaDoc.html> §Text retrieval and modification | Byte-oriented; needs an encoding step for non-ASCII |
| Line-addressable read | `SCI_GETLINE(line, char*)`, `SCI_GETLINECOUNT`, `SCI_LINEFROMPOSITION` — same doc §Text retrieval… and its length-of-document table | Line index is the natural analogue of a row key |
| Dirty/save state | `SCI_GETMODIFY` "returns non-zero if the document is modified… determined by the undo position relative to the save point" — same doc §SCI_GETMODIFY | Read-only query; `SCI_SETSAVEPOINT` is the only "mark clean" and a verifier must not call it |
| Path of the live document | `NPPM_GETFULLCURRENTPATH` — <https://npp-user-manual.org/docs/plugin-communication/> §NPPM_GETFULLCURRENTPATH | Binds the handle to the fixture path |
| Save | `NPPM_SAVECURRENTFILE` — same doc §NPPM_SAVECURRENTFILE | — |
| ARM64 | Official ARM64 installer + portable: `npp.8.9.9.1.Installer.arm64.exe` (current 8.9.9.1, 2026-11-11) and `npp.8.8.Installer.arm64.exe` with published SHA-256 — <https://notepad-plus-plus.org/downloads/v8.9.9.1/>, <https://github.com/notepad-plus-plus/notepad-plus-plus/releases/tag/v8.8> | Native ARM64 build ships; **not executed here** |
| Licence | GNU GPLv3 "with the clarifications and exceptions described below" — <https://raw.githubusercontent.com/notepad-plus-plus/notepad-plus-plus/master/LICENSE> | Copyleft binds Notepad++ itself, not a separate process sending window messages `[INFERENCE]`. Fixtures are plain text — unconstrained |
| Scintilla licence | "Permission to use, copy, modify, and distribute this software… without fee is hereby granted" (BSD-like, not GPL) — <https://www.scintilla.org/License.txt> | — |

**Cost note.** The checker must be **guest-side**: Scintilla text sits behind a window handle readable only via `SendMessage` from the same window station. That is a new *tool* in the agent vocabulary (a `scintilla_read` op), not a new verification theory. The persisted side is free — plain text, exact host-side string compare, no converter at all: *cheaper than Calc's CSV conversion step*.

### 2.4 7-Zip (and the "file-only" class)

| Claim | Pointer | Limit |
|---|---|---|
| Live state: nothing published | The only documented programmatic surfaces are the **CLI** and the **7z DLL / LZMA SDK** listed on the vendor download page — <https://www.7-zip.org/download.html> | No COM, no UNO, no documented UIA document model anywhere on the vendor site |
| ARM64 | `7z2606-arm64.exe` "64-bit Windows arm64", 7-Zip 26.06 (2026-11-06) — <https://www.7-zip.org/download.html> | Native ARM64 ships |
| Licence | Page metadata declares `gnu, lgpl` and the source archive is published — <https://www.7-zip.org/download.html>; the shipped licence file is a mix (LGPL / BSD-3 / unRAR terms) `[INFERENCE]` | **Exact terms [UNVERIFIED]**: the download page does not reproduce the licence; read `License.txt` in the source archive before quoting |
| Checker cost | Archive contents re-listed host-side by a different tool `[INFERENCE]` | **File-only** check; no live-state channel at all |

**Verdict:** a *file-format* task, not a *document-state* task. Proves nothing about object-model adapters; reduces to "did a file appear". Reject as the second app (viable later as a cheap third app for the MCP surface).

### 2.5 Paint.NET

| Claim | Pointer | Limit |
|---|---|---|
| ARM64 | "64-bit CPU (Intel/AMD x64 with AVX2, **or ARM64**) with at least 4 cores" — <https://www.getpaint.net/download.html> §System Requirements | Ships as .NET (bundled .NET 11); ARM64 supported |
| Live document state | No published automation/object model; features are layers, undo, effects — <https://www.getpaint.net/> | **No COM/UNO/UIA document model documented.** Layers exist in-app only |
| Licence | Free of charge, but "You may not modify, adapt… or create derivative works"; "Can I use the Paint.NET libraries (DLLs) in my own software…? No. Paint.NET is only licensed for use as an application" — <https://www.paint.net/license.html> | Free redistribution of the Classic installer permitted; plugins not redistributable without author permission |
| Checker cost | Pixel compare of the saved PNG/PDN, or reopen + read a pixel `[INFERENCE]` | Pixel-level truth only; no text/structural state |

**Verdict:** verification collapses to **pixels** — the exact failure mode ADR-0002 exists to refute. Reject.

### 2.6 Microsoft Office (Word / Excel)

| Claim | Pointer | Limit |
|---|---|---|
| ARM64 | "Arm-based devices require Windows 11 or later to run Microsoft 365 Apps. The 32-bit version… isn't supported on these devices. When you install the 64-bit version on an Arm-based device, it **automatically includes the Arm-optimized components**" — <https://learn.microsoft.com/en-us/microsoft-365-apps/deploy/office-deployment-tool-configuration-options> §OfficeClientEdition attribute; consumer Office 2024: "For ARM-based devices, Windows 11 is the minimum supported operating system" — <https://support.microsoft.com/en-us/office/system-requirements/office-suites-for-individuals-and-families> §Office 2024 | Supported, but emulated x64 with Arm-optimized components; no separate native ARM64 installer line |
| Word document state | `Document.Content` → `Range`; `Range.Text` "Returns or sets the text in the specified range… Read/write String" — <https://learn.microsoft.com/en-us/office/vba/api/word.document.content>, <https://learn.microsoft.com/en-us/office/vba/api/word.range.text> | Whole main story; per-paragraph addressing is the VBA `Paragraphs` collection (not re-verified here) |
| Word dirty flag | `Document.Saved` "True if the specified document or template has not changed since it was last saved" — <https://learn.microsoft.com/en-us/office/vba/api/word.document.saved> | Direct analogue of `isModified()` |
| Excel document state | `Range.Value2` read/write Variant — <https://learn.microsoft.com/en-us/office/vba/api/excel.range.value2>; `Workbook.Saved` — <https://learn.microsoft.com/en-us/office/vba/api/excel.workbook.saved> | Excel is a **Calc repeat in another skin** — tests nothing new |
| Open surface | `Documents.Open(FileName, …, Visible, OpenAndRepair, …)` — <https://learn.microsoft.com/en-us/office/vba/api/word.documents.open> | COM automation documented and stable |
| Licence | Paid, per-device/per-user, activation required ("Internet access is required… to activate apps… Periodic connection to the internet is required to keep your apps activated") — <https://support.microsoft.com/en-us/office/system-requirements/office-suites-for-individuals-and-families> §Office 2024; terms index <https://www.microsoft.com/en-us/useterms> | **Hard blocker for this brief**: no paid signups, no accounts; also blocks a public "reproduce our eval" claim (M1 acceptance row 8) |

**Verdict:** structurally the strongest surface after UNO (and `Saved` is documented one-to-one), but **licence + account requirement disqualifies it for M2**. Keep it as the *third* app once someone with a licence owns the fixture story.

### 2.7 Candidates found that are materially better

| Candidate | Why it beats the list | Status |
|---|---|---|
| **Microsoft WordPad** | Ships with Windows; RTF readable by host-side parse — but removed in Windows 11 24H2+ `[INFERENCE]` | Not viable on a current guest; not investigated further |
| **Windows Notepad** | UIA `ValuePattern` on the edit control ⇒ state readable **without a new guest tool**; UTF-8 file parse host-side | `[UNVERIFIED]` — no vendor API doc describes Notepad's automation surface; needs a live probe. Flagged as a *cheap* fallback, not adopted |
| **Writer (chosen)** | The only candidate giving a **cell-addressable and paragraph-addressable object model with a documented converter** on the *already-installed* ARM64 binary | §2.1 |

### 2.8 Scoring table (pointer per factual cell)

Scores: **5 = best → 1 = worst**. Numerics are judgements; every pointer is a source.

| Criterion | Writer | Impress | Notepad++ | 7-Zip | Paint.NET | MSO Word | *Calc (baseline)* |
|---|---|---|---|---|---|---|---|
| **1. Structural surface: document state readable?** | 5 — `XText.getString`, `XParagraphCursor`, `XTextTable.getCellByName("D3")` | 3 — text only via `TextShape`+`drawing.Text` | 4 — `SCI_GETTEXT`/`SCI_GETLINE` via the Scintilla HWND | 1 — no live object model published | 1 — no automation model published | 5 — `Range.Text`, `Document.Saved` | 5 — `XCell.getValue/getString/getError` |
| **Are cell/text/paragraph values programmatically readable?** | **Yes** — text (`getString`), paragraph (cursor), table cell (`getCellByName().getString()`) | **Yes** for shape text; **no** for a page as a value | **Yes** — whole doc + per line | **No** live; only after extraction | **No** (pixels only) | **Yes** — `Range.Text` / `Range.Value2` | **Yes** |
| **2. ARM64 Windows 11** | 4 — in the ARM64 MSI we already run | 4 — same MSI | 4 — `Installer.arm64.exe` | 4 — `7z2606-arm64.exe` | 4 — "or ARM64" | 3 — Arm-supported x64 + optimised components, no native line | 4 (baseline) |
| **3. Licence / fixture redistribution** | MPL-2.0; fixtures ours | MPL-2.0 | GPLv3 (app only; text fixtures unconstrained) | LGPL/mixed `[UNVERIFIED exact]` | Freeware; no DLL reuse, no derivatives | **Paid + activation** | MPL-2.0 |
| **4. Checker cost (out-of-process, read-only)** | **LOW** — UNO live read via existing `uno_eval` + `--convert-to "txt:Text (encoded):UTF8"`; table cells need an OOXML parse instead of CSV | **MEDIUM** — UNO live read OK; persisted check needs an ODP/PPTX shape walk | **MEDIUM** — needs a *new* guest op (`SendMessage` to Scintilla); file side trivially cheap (exact text) | **HIGH** — no live channel; only "archive lists X" | **HIGH** — pixels | **LOW** — COM read + OOXML parse | LOW (baseline) |
| **Table/text values readable without inventing an address scheme?** | **Yes** — `D3` naming documented | No — needs a shape-name convention | Yes — line index | No | No | Yes — `Range` | Yes — `A1` |
| **5. Task-family fit ("record edit" analogue)** | 5 — `writer-record-edit`: set table cell `<rowKey>,<column>` **and** a paragraph's text; two address spaces, one verifier | 3 — `slide-text-edit`: page+shape | 4 — `text-line-edit`: replace line N / a `key=value` line | 2 — extract/compress counts | 2 — draw/pixel | 4 — `word-record-edit` / `excel-record-edit` | 5 (baseline) |
| **Total (5 criteria, max 25)** | **23** | **17** | **20** | **14** | **13** | **21 (licence-blocked)** | 25 |

**ARM64 verification status — explicit.** `[VERIFIED from vendor]`: LibreOffice Writer/Impress (same published aarch64 MSI; that install's Calc binary is already proven on the VM, docs/env/windows.md §Live environment), Notepad++ (`Installer.arm64.exe` for 8.8 and 8.9.9.1), 7-Zip (`7z2606-arm64.exe`), Paint.NET (vendor states "or ARM64"), Microsoft Office (vendor states Arm-based devices supported on Windows 11).
`[NOT VERIFIED ON DEVICE]`: Notepad++, 7-Zip, Paint.NET and Microsoft Office were **not** installed or run on the ARM64 guest for this finding — read-only research, no installs permitted. Office's status is a vendor *support statement*, not an observed install. Writer and Impress require no new install at all; that is the whole reason they rank where they do.

## 3. Decision

**Adopt: LibreOffice Writer** as `writer-record-edit`.

1. **Zero install, zero licence delta.** Writer ships in `LibreOffice_26.8.3_Win_aarch64.msi`, already on the VM. No new download, no new ARM64 risk, no new licence review.
2. **The verifier is a generalisation, not a new mechanism.** Writer table cells expose `XCell` **and** `XText`, so `getCellByName("D3").getString()` is the *same* `get_string` call the agent already serves for Calc (agent/myco_agent/ops.py §uno_eval), and `XModifiable.isModified()` is the same check. New code is addressing (`(table, cellName)` instead of `(sheet, A1)`) plus a persisted-file parser.
3. **It exercises a genuinely different failure surface while keeping the thesis fixed.** Prose is not a cell: AutoCorrect, autocapitalisation and list auto-numbering (<https://help.libreoffice.org/latest/en-US/text/shared/01/06040200.html>) mutate typed text in ways Calc cells do not — new corrupted-trial classes for free.
4. **It proves the MCP surface is app-agnostic:** the same receipt shape (`edit landed` / `not dirty` / `persisted`) holds for a table cell and for a paragraph range.

**Runner-up: Notepad++** as `text-line-edit`. The only candidate with a genuinely *independent* (non-LibreOffice) object model — Scintilla over `SendMessage` — so it would prove the adapter layer is not merely UNO-shaped. Native ARM64 with a published installer and SHA-256; GPLv3 constrains only the app; the persisted-file check is the cheapest of any candidate (plain text, exact compare, no converter). It loses only on the one extra guest op and the same-session window-handle protocol.

**Rejected, with reason:**

- **Impress** — shape-address resolution is a fixture convention we would invent; cost without a new verification idea.
- **7-Zip** — no live state channel; reduces to file-exists.
- **Paint.NET** — pixel-only truth, refuted by ADR-0002's premise; licence also forbids reusing its DLLs.
- **Microsoft Office** — best object model of the set, but paid + activation + account, forbidden by the M2 brief and fatal to the public reproducibility claim.

## 4. Proposed smallest experiment (one day, inside the existing VM)

1. **Fixture (host-side, no install).** Generate `records.docx` (OOXML) with one 4-column × N-row table (`id`, text, integer, date) plus 2–3 body paragraphs containing marker tokens, from `fixtureSeed` — same discipline as `src/tasks/fixture.ts`.
2. **Intent.** `WriterRecordEditParams = { fixtureSeed, table: 0, rowKey, column, newValue }` plus a second intent kind `{ paragraphIndex, newValue }`.
3. **Probe the read path first (30 min).** On the live guest, drive Writer via the existing UIA adapter, then prove one of:
   - **preferred:** extend `uno_eval` with `get_table_cell(table, cellName)` → `XTextTablesSupplier.getTextTables()` → `getCellByName("D3")` → `getString()`;
   - **fallback:** close the document and parse the saved `.docx` host-side from `word/document.xml` `w:tbl`/`w:tc` text.
   Record which path worked; if neither does, reopen this decision.
4. **Corrupted trials.** Reuse `kill-app`, `invalid-target`, `delayed-save`, `focus-change`, and add one Writer-native class: a `newValue` that AutoCorrect/autocapitalise will rewrite, proving the exact-match verifier refutes it — M1's AutoCorrect lesson re-tested in another app.
5. **Pass criteria.** ≥10 normal trials `verified`; the AutoCorrect trial `refuted` (never `verified`); the persisted-file check catches a dropped save with the live document closed.

## 5. Next action

1. Coordinator files this as the M2 second-app decision; `writer-record-edit` becomes the family name, mirroring `calc-record-edit`.
2. Build owner extends `agent/myco_agent/backend.uno_eval` with the table-cell call — `uno_eval` already takes `call`/`sheet`/`cell`; `get_table_cell` adds `table`. No new op.
3. Persisted-state reader: add a `.docx` (`word/document.xml`) reader beside the CSV reader in `src/core/filepersist.ts`. `[INFERENCE]` this is smaller than the Calc path — OOXML is a zip of XML, no `soffice --convert-to` round trip, no nonce outdir.
4. Keep Notepad++ as the *third*-app track; open it when someone wants to prove non-UNO object models. Do **not** activate Microsoft Office without a licence decision escalated to the outer loop.

## 6. Reopen-if

- The `uno_eval` table-cell read fails on the live VM **and** the `.docx` parse cannot address the cell unambiguously (merged cells, `w:gridSpan`) — Writer's advantage evaporates and Notepad++ becomes the recommendation.
- AutoCorrect/autocapitalisation cannot be neutralised without disabling a realistic app default and drives the *normal* suite's `verified` rate below the M1 bar — then retarget the edit (paragraph with no sentence-initial word) or change app.
- The M2 brief changes to admit paid software; Microsoft Word then re-enters at rank 2 on object-model quality (`Range.Text` + `Document.Saved` documented one-to-one).

## 7. Cost spent

| Item | Value |
|---|---|
| Tool calls (this finding) | 46 |
| Tokens | not_reported (harness does not expose it) |
| New sources read | 24 primary pages (LibreOffice IDL×7, LO Help×3, LO download×2, LO licence, MS Learn VBA×5, MS Learn deploy×1, MS support×2, Notepad++×3, Scintilla×2, 7-Zip, Paint.NET×2, Windows Arm emulation×1) |
| Repo files read | 9 (m1.md, adapters.md, uno-verifier.ts, calc-record-edit.ts, ops.py, m1-state.md, windows.md, vision.md, q1/q2 findings) |
| Installs / VM access | **none** (read-only research, per brief) |