# `myco-state` security model

Capability track I. This page covers what the structured-state tools can reach and what
they cannot. It also covers why they cannot weaken the gate. The tool reference is in
[tools.md](tools.md).

## What the agent gets

Four read-only tools that read one thing: the live app and document of the agent's own
trial. The agent's inputs are a sheet (index or name), an A1 range, and two tree limits.
There is no field for a path, file, URL, run, task or trial, and a call with any other
field gets `UNKNOWN_FIELD`.

## Bound to one trial

- The harness starts one `myco-state` server per trial. It sets the binding in the
  server's environment: `MYCO_STATE_RUN_ID` (the trial's run id) and `MYCO_STATE_UNO_PIPE`
  (the trial's live soffice pipe). The pipe name comes from the run id plus random bytes,
  and it matches `^myco-state-[a-z0-9-]{8,64}$`. It is never a path.
- It sets `MYCO_STATE_DOC_UID`: the trial document's `RuntimeUID` in that soffice, which
  the harness reads right after the document loads. Calc assigns it per load, as a
  decimal counter, and no client can set it. The reader reads only the spreadsheet with
  that uid. Another file opened in its place (another trial's, the pristine fixture), or
  the trial's own document closed and reopened, has a different uid and gets
  `DOCUMENT_UNAVAILABLE`.
- It also sets `MYCO_STATE_WITHHELD`: the trial's host paths (trial dir, vault root,
  fixture dir, oracle config, other trials' dirs) as a JSON array of 1 to 64 absolute
  paths. The list is mandatory; see [Host paths](#host-paths).
- The server refuses to start without all four, and with any argument except `mcp`.
- The reader finds the one spreadsheet loaded in that soffice. With none or more than one,
  or one whose uid is not the bound one, it returns `DOCUMENT_UNAVAILABLE`; it never
  guesses.
- The launch audit (`src/integrity/launch.ts`) checks a `myco-state` server's environment:
  the run id must equal the trial's, the pipe must have the issued shape, the document uid
  must be present with its shape, the withheld list must be present and valid, there must
  be no other keys than the binding keys (those four plus `MYCO_PYTHON`), and
  the args must end in `mcp` with no flag anywhere (`["--inspect", "mcp"]` is refused).
  `capabilityArmPlan` refuses to build a structured-state plan without withheld paths or a
  document uid.

The binding works like the gate's: one server, one trial, and nothing in a request can
point it elsewhere.

## What it reads, and what it never opens

The server never opens a file. `src/state/{api,backend,server,cli}.ts` and
`linux/uno.ts` import no file-system API (`test/state/state-scope.test.ts`). The only
state module that touches the file system is the harness's own live-session launcher. It
makes a throwaway profile and clears a lock file. The reader script takes only `--pipe`
and `--uid`, never calls `getURL` or `getLocation`, and never prints exception text.

That does NOT put other files' contents out of reach on its own. The server returns what
the trial's open document holds, and the document can hold content from any file the
trial's soffice process can read. On the Linux path that process runs as the harness user,
so the pristine fixture, the vault, the oracle config and other trials are readable to it.
The round-1 verifier of PR #545 showed this (D7): a formula in `H1` reading another file and
`=H1` in `I1` returned the other file's content through a read of `I1` alone. The next
section is what the tools enforce against that, and what they cannot.

### Content from other files

Enforced, in the reader and the server:

1. **Only the trial's document.** The reader is bound to the document's `RuntimeUID`
   (above). Opening another file in place of the trial's gets `DOCUMENT_UNAVAILABLE`, from
   every tool.
2. **Foreign content withholds.** The reader reports `documentForeignContent` for the whole
   document on every `state_list_sheets`, `state_read_range` and `state_ui_tree` call
   (scanned after the cells are read, since reading a cell can resolve a reference). It is
   true when:
   - a formula anywhere the host-path scan looks (formula cells on every sheet, document-
     and sheet-scoped named expressions, validation formulas) holds an external-reference
     marker (`'#` or `#$`: Calc holds `='../fixture/fixture.csv'#$fixture.B2` as
     `'file:///…/fixture.csv'#$fixture.B2`) or calls `INDIRECT`, `DDE` or `WEBSERVICE`
     (built in, so the non-built-in rule does not catch them). The match is loose on
     purpose: a string literal holding `'#` also withholds;
   - any link container is not empty: external-document links (Calc keeps one, with its
     cached content, for every external reference it resolved, including one in a
     conditional format, and after the formula is gone), DDE links, area links (Link to
     External Data), sheet links (Insert Sheet from File with Link), or a sheet whose link
     mode is not `NONE`;
   - a database range (named or unnamed) or a pilot table imports from a data source.

   A container or place the reader cannot read fails the call (`BACKEND_ERROR`). The server
   refuses a reply to those three tools without the flag (`BACKEND_ERROR`) and withholds
   while it is true (`OUTPUT_WITHHELD`). It also checks every returned formula for the same
   markers and calls itself. `state_document_status` carries no document content and stays
   readable. The withholding lasts until the link is broken (Edit > Links to External
   Files); reloading the document instead ends state access for the trial (rule 1).

**What these do not stop.** Content the agent copies into its own document as plain values
becomes part of that document, with no link or formula left to detect: Insert Sheet from
File *without* Link, Data > XML Source, opening the file in the GUI and pasting from it
(while the second spreadsheet is open, every tool gets `DOCUMENT_UNAVAILABLE`, but the
pasted values stay once it is closed), or a macro run from the Basic IDE that writes into
cells. The same content is on screen through `myco-rt observe` either way, so the state
server is not the only channel. The boundary for these is the operating system: on the
Linux path the harness must keep the pristine fixture, the vault, the oracle config and
other trials unreadable to the trial's soffice process. That isolation is not built yet
(TO FILE). On the Windows VM path these files are not on the guest at all.

### Host paths

Host paths are NOT out of reach by construction. The document itself can produce one: a
formula such as `=CELL("filename")` evaluates to the document's own URL
(`'file:///<trial dir>/agent/saved.xlsx'#$Sheet1`), and Calc can rewrite an external
reference into an absolute file URL. A second formula the agent writes can then re-spell
that text in any way it likes (`=MID(CELL("filename");10;300)` drops the `file:///`,
`=SUBSTITUTE(…;"/";"|")` swaps the separators), so no check on the spelling alone can be
complete. Four enforced layers, in the order the server applies them:

1. **Path functions taint the document.** `CELL` and `INFO` are the built-in spreadsheet
   functions that return the document's location; a Basic macro (written in the GUI's
   Basic IDE and called from a cell as `=WHEREAMI()`) or an extension add-in can return it
   too. So a formula taints the document if it calls `CELL`, `INFO`, or ANY function that
   is not built in. "Built in" is the running Calc's own opcode map, minus `CELL` and
   `INFO`, minus add-ins other than the three LibreOffice ships (Analysis, DateFunctions,
   PricingFunctions). The reader scans every place the document holds a formula whose
   result can reach a cell or the UI: formula cells on every sheet, document-scoped named
   expressions, sheet-scoped named expressions (Manage Names with a sheet scope), and the
   validation formulas of every range (a list validation's dropdown shows its values).
   While any of them taints, every `state_read_range` and `state_ui_tree` reply is
   `OUTPUT_WITHHELD`, including reads of cells that never touch it. The reader scans on
   each of these calls and reports `documentPathFunctions`; a place it cannot read fails
   the whole call (`BACKEND_ERROR`); the server refuses a reply without the flag
   (`BACKEND_ERROR`) and also checks every returned formula for `CELL`/`INFO` itself. This
   cuts the source, not the spelling: a formula-based re-spelling depends on a tainting
   formula that is still in the document. The match is loose on purpose: a call-shaped
   string literal (`"INFO("`, `"x("`) also withholds (fail closed). `state_list_sheets` and
   `state_document_status` carry no cell text and stay readable. Removing the formula (or
   the name, validation or macro call) ends the taint.
2. **Withheld strings (mandatory).** The harness lists the trial dir, vault root, fixture
   dir, oracle config and other trials' dirs in `MYCO_STATE_WITHHELD`. The launch audit, the
   plan builder and the server itself all refuse to run without the list, and the
   capability-arm audit also refuses a list that does not cover the trial's own dir (the
   dir or an ancestor). The backend's raw cell, sheet and status strings are checked
   against each entry, as written, JSON-escaped and file-URL-encoded, BEFORE any
   scrubbing, so a partial scrub cannot hide one; a hit gives `OUTPUT_WITHHELD`. UI-tree
   names and roles have these strings redacted to `[path]` instead. The serialized reply
   is checked again at the end.
3. **Separator-insensitive match.** Each string, and each withheld entry, is NFKC-folded,
   lowercased and stripped of everything but letters and digits. A string that contains 16
   consecutive letters/digits of a folded entry (or a whole folded entry of 8 to 15) gives
   `OUTPUT_WITHHELD`; for the UI tree this runs after the redaction in layer 2. This
   catches a re-spelled path that no longer comes from a formula (computed, then pasted as
   plain values): swapped separators, a cut prefix, case changes, fullwidth letters.
4. **Path scrubbing (every string).** Cell `display`, `value` and `formula`, sheet names and
   UI-tree names and roles have path-like text replaced with `[path]`: file URLs (to the
   next quote, so a path with spaces goes whole), absolute POSIX paths, drive and UNC
   paths, and `~/` paths. A cell changed this way carries `pathScrubbed: true`. Dates
   (`2024/06/21`), formula division (`=(A1)/(B1)/2`) and web URLs are left alone. This
   covers host paths the list does not name (for example a home directory) in their usual
   spellings only.

**What no layer stops.** An agent that deliberately computes a re-encoding of its own
document's path that keeps fewer than 16 letters/digits of any withheld entry in order
(reversed, spelled as character codes, split across cells), pastes the result as plain
values and deletes the formula, can read that text back. The same goes for a macro run
from the Basic IDE (not called from a cell) that writes such a re-encoding into cells as
plain values: no formula is left to taint the document. Conditional-format formulas are
not scanned: their result is a cell style, never text a reply carries. The same text is on its screen
through `myco-rt observe` either way, so the state server is not the only channel. What
it learns is a location. Whether the content at that location can reach the tools is the
subject of [Content from other files](#content-from-other-files), not of this section. A
host path the withheld list does not name is covered only by layer 4's patterns. These
layers do not support the claim that no reply can ever contain a host path in any
spelling, and the docs do not make it.

### Other defense in depth

- **Codes only.** Every refusal is a code. A backend exception, timeout or malformed reply
  becomes `BACKEND_ERROR`, and its text goes to the operator's stderr only. An unknown tool
  or method is not echoed.

The tests plant `PLANTED_FAKE_MARKER` in the pristine fixture, the vault, the oracle config
and another trial's dir. Then they check that no tool output contains the marker or any of
those paths:

- `test/state/state-foreign.test.ts` (hermetic) covers content from other files (D7): the
  server's flag rules for each content tool, its own formula check (external references,
  `INDIRECT`, `DDE`, `WEBSERVICE`), the reader's document scan over every formula place
  and every link container, the document-uid binding (another document, a reopened one,
  none, two) and the uid shape check, and planted markers pulled into a stand-in document;
- `test/state/state-scope.test.ts` (hermetic) runs a battery of valid and hostile calls,
  including path-like sheets and ranges and smuggled `path`, `runId`, `taskId`, `file` and
  `trial` fields;
- `test/state/state-host-paths.test.ts` covers the four host-path layers: a
  `=CELL("filename")` cell, the round-2 verifier's re-spellings (`MID`, `SUBSTITUTE`,
  `REGEX`, a cut prefix, case, fullwidth) both as formula results and pasted as plain
  values, a `CELL` formula on another sheet, a missing flag, the 16-character window
  boundary, and the reader's document scan (cells, document- and sheet-scoped names, validation
  formulas, macro and extension add-in calls, and which add-ins count as built in);
- `test/linux/state-e2e.test.ts` runs against a real live Calc from a trial dir whose path
  has spaces. It pastes a re-spelled path as plain text, types `=CELL("filename")` and the
  verifier's `=MID(H2;10;300)`, and gets `OUTPUT_WITHHELD` for each, and for an unrelated
  cell while the `CELL` formula is in the document. It also defines a sheet-scoped name
  `p` = `CELL("filename")` with the round-3 verifier's `=REGEX(MID(p;10;300);…)`, a Basic
  function returning the document's URL, and a list validation sourced from `CELL`, and
  gets `OUTPUT_WITHHELD` for an unrelated cell while each is present and `ok` once it is
  removed. Then, with the markers planted, it pulls each one into the live document the
  ways the D7 verifier did: relative external references to the pristine fixture, another
  trial, the vault and the oracle config, `INDIRECT`, `DDE`, a linked sheet and a linked
  area. For each it first proves the marker really is in the live document, then gets
  `OUTPUT_WITHHELD` from a read of the cell that holds only the value, from an unrelated
  cell, from the sheet list and from the UI tree. Last, it opens another trial's file in
  place of the trial's document and gets `DOCUMENT_UNAVAILABLE` from every tool. It checks
  every byte the server wrote.

## Read-only

- The server has no write path. The backend interface has four read methods only.
- The reader script has no setter, dispatch, store, close, load, select or terminate call.
  A static test enforces this.
- The acting channel for the Linux test harness (`scripts/linux/calc_live_act.py`) is a
  separate script. It is never reachable through the MCP server.

## Bounded output

| Bound | Value | Over the bound |
|---|---|---|
| Cells per `state_read_range` | 400 | `RANGE_TOO_LARGE` |
| Rows or columns per range | 200 | `RANGE_TOO_LARGE` |
| Characters per cell text or formula (UTF-16 code units; an emoji is 2) | 512 | cut, `truncated: true` |
| Characters per sheet or node name | 128 | cut |
| Sheets listed | 64 | `truncated: true` |
| UI tree depth | 8 (default 4) | `LIMIT_OUT_OF_RANGE` on request |
| UI tree nodes | 200 (default 60) | `LIMIT_OUT_OF_RANGE` on request |
| Children per UI node | 25 | `childrenOmitted: "width"` |
| Reply bytes | 64 KiB | `OUTPUT_TOO_LARGE` |

The backend applies the caps, and the server checks them again. A reply over any cap, or
with the wrong shape, is refused with `BACKEND_ERROR`. It is never passed through.

## Gate and grader independence

- `myco-state` is a separate server. Nothing is added to `myco-gate`'s `myco.gate/v1`
  surface: the agent still supplies only `taskId`, `runId` and `claim`.
- The gate never calls these tools. No module under `src/gate/` reaches `src/state/`, and
  none names the server (`test/state/state-independence.test.ts`). The gate keeps reading
  only the persisted bytes the harness captures after the agent stops.
- The grader (`src/benchmark/grade/`) shares no code with `src/state/`, in either direction.
  `test/benchmark/independence.test.ts` now also forbids any `state/` or `myco-state`
  reference in grader code.
- `myco-state` is not a default MCP server in the surface audit. The R1 gated harness
  (`runGatedTrial`) audits with the gate's class only, so it refuses a plan that starts
  `myco-state`. Structured-state trials can therefore never produce R1 rows through it.
- Live state is not proof. The second end-to-end case shows it: the client sees its edit in
  live state, never saves, and the gate refutes from the saved file.

## The new reach class

`src/integrity/surface.ts` has a new reach, `app-state`. It reads the agent's own live app
or document for its own trial, read-only, through a server bound to that trial. Only
`STATE_SERVER_CLASS`, which only the capability-arm audit passes, has tools of this reach.
