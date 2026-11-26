/**
 * Capability track I, round-1 verifier defects D2 and D3 (PR #527).
 *
 * D2: host paths reach the agent only through cell text a formula produced (Calc's
 * `=CELL("filename")` gives `'file:///<trial dir>/agent/saved.xlsx'#$Sheet1`). Two layers
 * keep them out: the backend's raw strings are checked against the harness's withheld list
 * BEFORE any scrubbing (OUTPUT_WITHHELD), and every string the agent sees has path-like
 * text replaced by `[path]` (cells say `pathScrubbed: true`). The list itself is mandatory
 * (the CLI side is in state-scope.test.ts, the audit side in state-arms.test.ts).
 *
 * D3: the reader cut text at 512 code points while the server re-checks 512 UTF-16 units,
 * so one cell of emoji made every range covering it BACKEND_ERROR. The reader now counts
 * UTF-16 units, never splitting a surrogate pair.
 */
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { STATE_CAPS } from "../../src/state/api.ts";
import {
  createStateService,
  FOLDED_WINDOW,
  foldForMatch,
  scrubPaths,
} from "../../src/state/server.ts";
import { fakeBackend, rawBackend } from "./fake-backend.ts";

// biome-ignore lint/suspicious/noExplicitAny: replies are read loosely in tests
type Json = any;

const ROOT = resolve(import.meta.dirname, "..", "..");
const TRIAL = "/tmp/probe base/runs/run probe";
const CELL_FILENAME = `'file://${TRIAL}/agent/saved.xlsx'#$seed`;

const oneCell = (cell: object) => ({
  sheet: { index: 0, name: "seed" },
  range: "A1:A1",
  rows: [[{ ref: "A1", ...cell }]],
});

async function readA1(
  cell: object,
  withheld?: readonly string[],
  flag: boolean | null = false,
): Promise<Json> {
  const data = flag === null ? oneCell(cell) : { ...oneCell(cell), documentPathFunctions: flag };
  const service = createStateService({
    backend: rawBackend(data, { omitFlag: flag === null }),
    withheld,
  });
  return service.call("state_read_range", { range: "A1" });
}

describe("D2: a formula-derived host path never reaches the agent", () => {
  it('=CELL("filename") is withheld by the formula check, whatever the backend flag says', async () => {
    const reply = await readA1({
      kind: "formula",
      formula: '=CELL("filename")',
      formulaResult: "text",
      value: CELL_FILENAME,
      display: CELL_FILENAME,
    });
    expect(reply).toMatchObject({ ok: false, code: "OUTPUT_WITHHELD" });
  });

  it("a pasted host path NOT on the withheld list: scrubbed, flagged", async () => {
    const reply = await readA1({ kind: "text", value: CELL_FILENAME, display: CELL_FILENAME });
    expect(reply.ok).toBe(true);
    const cell = reply.data.rows[0][0];
    expect(cell.display).toBe("'[path]'#$seed");
    expect(cell.value).toBe("'[path]'#$seed");
    expect(cell.pathScrubbed).toBe(true);
    expect(JSON.stringify(reply)).not.toMatch(/tmp|probe|runs|agent|saved\.xlsx/);
  });

  it("a withheld path is refused before scrubbing, even where the scrub would hide it", async () => {
    // After scrubbing this display reads `'[path]'#$seed`, which contains no withheld
    // string: only the pre-scrub check catches it.
    expect(
      await readA1({ kind: "text", value: CELL_FILENAME, display: CELL_FILENAME }, [TRIAL]),
    ).toMatchObject({ ok: false, code: "OUTPUT_WITHHELD" });
  });

  it("a withheld path in its file-URL-encoded form is refused too", async () => {
    const encoded = `'file:///tmp/probe%20base/runs/run%20probe/agent/saved.xlsx'#$seed`;
    expect(await readA1({ kind: "text", value: encoded, display: encoded }, [TRIAL])).toMatchObject(
      { ok: false, code: "OUTPUT_WITHHELD" },
    );
  });

  it("formula text with an absolute external reference is scrubbed", async () => {
    const reply = await readA1({
      kind: "formula",
      formula: "='file:///srv/elsewhere/vault.ods'#$Sheet1.A1",
      formulaResult: "error",
      value: null,
      display: "#REF!",
    });
    expect(reply.data.rows[0][0]).toMatchObject({
      formula: "='[path]'#$Sheet1.A1",
      pathScrubbed: true,
    });
  });

  it.each([
    ["formula division", "=(A1)/(B1)/2"],
    ["a date", "2024/06/21"],
    ["a web URL", "https://example.com/a/b"],
    ["plain text", "profile: Ann"],
  ])("leaves %s alone, unflagged", async (_name, text) => {
    const reply = await readA1({ kind: "text", value: text, display: text });
    expect(reply.data.rows[0][0].display).toBe(text);
    expect(reply.data.rows[0][0].pathScrubbed).toBeUndefined();
  });

  it("scrubs POSIX, Windows, UNC and home paths in cell text", () => {
    expect(scrubPaths("see /etc/passwd now")).toBe("see [path] now");
    expect(scrubPaths('"/srv/v/x"')).toBe('"[path]"');
    expect(scrubPaths("D:\\trials\\gt.json")).toBe("[path]");
    expect(scrubPaths("D:/trials/run-1/gt.json")).toBe("[path]");
    expect(scrubPaths("\\\\srv\\share\\x")).toBe("[path]");
    expect(scrubPaths("~/secrets/k")).toBe("[path]");
    expect(scrubPaths("[path]/saved.xlsx — Calc")).toBe("[path] — Calc");
  });

  it("a scrubbed cell stays within the text cap", async () => {
    const text = `${"x".repeat(STATE_CAPS.maxCellTextChars - 5)} /a/`;
    const reply = await readA1({ kind: "text", value: text, display: text });
    expect(reply.ok).toBe(true);
    expect(reply.data.rows[0][0].display.length).toBeLessThanOrEqual(STATE_CAPS.maxCellTextChars);
  });

  it("a UI name holding a withheld path with spaces is redacted whole, not withheld", async () => {
    const service = createStateService({
      backend: rawBackend({
        tree: {
          role: "frame",
          name: `${TRIAL}/agent/saved.xlsx — LibreOffice Calc`,
          childCount: 0,
        },
        nodes: 1,
        truncated: false,
      }),
      withheld: [TRIAL],
    });
    const reply: Json = await service.call("state_ui_tree", {});
    expect(reply.ok).toBe(true);
    expect(reply.data.tree.name).toBe("[path] — LibreOffice Calc");
  });

  it("sheet names in the reply are scrubbed too", async () => {
    const service = createStateService({
      backend: rawBackend({
        sheets: [{ index: 0, name: "~/x/y", usedRange: null }],
        sheetCount: 1,
        truncated: false,
      }),
    });
    const reply: Json = await service.call("state_list_sheets", {});
    expect(reply.data.sheets[0].name).toBe("[path]");
  });
});

/**
 * Round-2 verifier defect D5: a formula the agent writes can re-spell its own document's
 * path (`=MID(CELL("filename");10;300)`, `=SUBSTITUTE(CELL("filename");"/";"|")`), and the
 * withheld list (exact substrings) and the scrubber (needs a leading `/`, `file://`, …)
 * both missed it. Two more layers now: the path-function taint (any CELL/INFO formula in
 * the document withholds every cell read and UI tree) and the separator-insensitive match.
 */
describe("D5: a transformed spelling of the document's path never reaches the agent", () => {
  const PATH = `${TRIAL}/agent/saved.xlsx`;
  // The verifier's live probes, as Calc renders them.
  const spellings: [string, string][] = [
    ["MID(CELL(…);10;300)", `${PATH.slice(1)}'#$seed`],
    ['SUBSTITUTE(…;"/";"|")', `'file:${PATH.replace(/\//g, "|")}'#$seed`],
    ['SUBSTITUTE(MID(…);" ";"_")', PATH.slice(1).replace(/ /g, "_")],
    ['REGEX(…;"/";"\\\\";"g")', `'file:${PATH.replace(/\//g, "\\")}'#$seed`],
    ["MID(…;14;300) (prefix cut inside a segment)", PATH.slice(5)],
    ["UPPER(…)", PATH.toUpperCase()],
    [
      "fullwidth letters",
      PATH.replace(/[a-z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0)),
    ],
  ];

  it.each(spellings)("formula %s: withheld by the document flag", async (_name, text) => {
    const cell = {
      kind: "formula",
      formula: "=MID(H2;10;300)",
      formulaResult: "text",
      value: text,
      display: text,
    };
    expect(await readA1(cell, [TRIAL], true)).toMatchObject({ code: "OUTPUT_WITHHELD" });
  });

  it.each(spellings)(
    "the same text pasted as a plain value (no formula left): withheld by the folded match (%s)",
    async (_name, text) => {
      expect(await readA1({ kind: "text", value: text, display: text }, [TRIAL])).toMatchObject({
        code: "OUTPUT_WITHHELD",
      });
    },
  );

  it("an innocuous cell is withheld while the document holds a path function", async () => {
    expect(
      await readA1({ kind: "text", value: "Ann", display: "Ann" }, [TRIAL], true),
    ).toMatchObject({ code: "OUTPUT_WITHHELD" });
  });

  it("a cell read or UI tree without the document flag is refused (BACKEND_ERROR)", async () => {
    expect(
      await readA1({ kind: "text", value: "Ann", display: "Ann" }, [TRIAL], null),
    ).toMatchObject({ code: "BACKEND_ERROR" });
    const tree = createStateService({
      backend: rawBackend(
        { tree: { role: "frame", name: "x", childCount: 0 }, nodes: 1, truncated: false },
        { omitFlag: true },
      ),
      withheld: [TRIAL],
    });
    expect(await tree.call("state_ui_tree", {})).toMatchObject({ code: "BACKEND_ERROR" });
    const nonBool = createStateService({
      backend: rawBackend({
        ...oneCell({ kind: "empty", value: null, display: "" }),
        documentPathFunctions: "no",
      }),
    });
    expect(await nonBool.call("state_read_range", { range: "A1" })).toMatchObject({
      code: "BACKEND_ERROR",
    });
  });

  it("a CELL formula on ANOTHER sheet withholds reads and the UI tree, not the sheet list or status", async () => {
    const service = createStateService({
      backend: fakeBackend({
        sheets: [
          {
            name: "seed",
            rows: [
              ["id", "name"],
              ["EMP-1", "Ann"],
            ],
          },
          { name: "scratch", rows: [['=CELL("filename")']] },
        ],
        modified: true,
        tree: { role: "frame", name: "saved.xlsx — LibreOffice Calc", childCount: 0 },
      }),
      withheld: [TRIAL],
    });
    expect(await service.call("state_read_range", { range: "A1:B2" })).toMatchObject({
      code: "OUTPUT_WITHHELD",
    });
    expect(await service.call("state_ui_tree", {})).toMatchObject({ code: "OUTPUT_WITHHELD" });
    expect(await service.call("state_list_sheets", {})).toMatchObject({ ok: true });
    expect(await service.call("state_document_status", {})).toMatchObject({ ok: true });
  });

  it.each([
    '=cell("filename")',
    '=CELL ("filename";A1)',
    "=CELL(A9)",
    '=_xlfn.CELL("filename")',
    '=INFO("directory")',
    '=LEN(CELL("filename"))',
  ])("the server's own formula check withholds %s (backend flag false)", async (formula) => {
    expect(
      await readA1({ kind: "formula", formula, formulaResult: "number", value: 1, display: "1" }),
    ).toMatchObject({ code: "OUTPUT_WITHHELD" });
  });

  it("the folded window is 16 letters/digits (as documented): 15 pass, 16 are withheld", async () => {
    const folded = foldForMatch(TRIAL);
    expect(folded).toBe("tmpprobebaserunsrunprobe");
    expect(FOLDED_WINDOW).toBe(16);
    const under = folded.slice(0, 15);
    const at = folded.slice(3, 3 + 16);
    expect((await readA1({ kind: "text", value: under, display: under }, [TRIAL])).ok).toBe(true);
    expect(await readA1({ kind: "text", value: at, display: at }, [TRIAL])).toMatchObject({
      code: "OUTPUT_WITHHELD",
    });
  });

  it("ordinary cell text is not withheld by the folded match", async () => {
    for (const text of ["EMP-0007", "probe", "run probe", "Base runs", "tmp", "2024/06/21"]) {
      const reply = await readA1({ kind: "text", value: text, display: text }, [
        TRIAL,
        "/srv/vault",
      ]);
      expect(reply.ok, text).toBe(true);
    }
  });

  it("a short withheld entry (8-15 folded chars) is matched whole", async () => {
    const reply = await readA1(
      { kind: "text", value: "SRV|MYCO|VAULT", display: "SRV|MYCO|VAULT" },
      ["/srv/myco/vault"],
    );
    expect(reply).toMatchObject({ code: "OUTPUT_WITHHELD" });
  });

  it("a UI name carrying a transformed path is withheld; a role carrying a withheld path is redacted", async () => {
    const tree = (name: string, role: string) =>
      createStateService({
        backend: rawBackend({ tree: { role, name, childCount: 0 }, nodes: 1, truncated: false }),
        withheld: [TRIAL],
      }).call("state_ui_tree", {});
    expect(await tree(PATH.replace(/\//g, "|"), "frame")).toMatchObject({
      code: "OUTPUT_WITHHELD",
    });
    const reply: Json = await tree("Calc", `${TRIAL}/agent`);
    expect(reply.ok).toBe(true);
    expect(reply.data.tree.role).toBe("[path]");
    expect(JSON.stringify(reply)).not.toContain(TRIAL);
  });

  it("a role that is a path NOT on the list is scrubbed", async () => {
    const reply: Json = await createStateService({
      backend: rawBackend({
        tree: { role: "/srv/elsewhere/x", name: "Calc", childCount: 0 },
        nodes: 1,
        truncated: false,
      }),
    }).call("state_ui_tree", {});
    expect(reply.data.tree.role).toBe("[path]");
  });
});

describe("the scrub cut never splits a surrogate pair (round-2 nit own5)", () => {
  it("a scrub that grows a cell past the cap cuts before an emoji, not inside it", async () => {
    const cap = STATE_CAPS.maxCellTextChars;
    // " /a/ " (5) → " [path] " (8): +3, so the emoji's high surrogate lands at cap - 1.
    const text = ` /a/ ${"x".repeat(cap - 9)}😀yy`;
    expect(text.length).toBe(cap);
    const reply = await readA1({ kind: "text", value: text, display: text });
    expect(reply.ok).toBe(true);
    const shown: string = reply.data.rows[0][0].display;
    expect(shown.length).toBe(cap - 1);
    expect(/[\uD800-\uDBFF]$/.test(shown)).toBe(false);
  });
});

/** Run the reader's `clip` (scripts/linux/calc_state.py) under an isolated Python. */
function pyClip(text: string, limit: number): { text: string; cut: boolean; units: number } | null {
  const code = [
    "import importlib.util, json, sys",
    "spec = importlib.util.spec_from_file_location('calc_state', sys.argv[1])",
    "m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)",
    "req = json.loads(sys.stdin.read())",
    "out, cut = m.clip(req['text'], req['limit'])",
    "print(json.dumps({'text': out, 'cut': cut, 'units': m.utf16_units(out)}))",
  ].join("\n");
  const r = spawnSync(
    process.env.MYCO_PYTHON ?? "python3",
    ["-I", "-c", code, join(ROOT, "scripts", "linux", "calc_state.py")],
    { input: JSON.stringify({ text, limit }), encoding: "utf8" },
  );
  if (r.error) return null;
  if (r.status !== 0) throw new Error(`python failed: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

const python = spawnSync(process.env.MYCO_PYTHON ?? "python3", ["--version"]).error === undefined;

describe.runIf(python)("D3: the reader cuts text in UTF-16 units, like the server", () => {
  const cap = STATE_CAPS.maxCellTextChars;

  it("400 emoji (800 UTF-16 units) are cut to 256 emoji, flagged, and the server accepts it", async () => {
    const r = pyClip("😀".repeat(400), cap);
    expect(r).toEqual({ text: "😀".repeat(256), cut: true, units: 512 });
    const text = r?.text ?? "";
    const reply: Json = await readA1({ kind: "text", value: text, display: text, truncated: true });
    expect(reply.ok).toBe(true);
  });

  it("never splits a surrogate pair at the cut", () => {
    const r = pyClip(`${"a".repeat(cap - 1)}😀b`, cap);
    expect(r).toEqual({ text: "a".repeat(cap - 1), cut: true, units: cap - 1 });
  });

  it("leaves text within the cap untouched", () => {
    expect(pyClip("😀".repeat(256), cap)).toEqual({
      text: "😀".repeat(256),
      cut: false,
      units: 512,
    });
    expect(pyClip("plain", cap)).toEqual({ text: "plain", cut: false, units: 5 });
  });

  it("the server still refuses a reader that overshoots the cap (fail closed)", async () => {
    const text = "😀".repeat(257);
    expect(await readA1({ kind: "text", value: text, display: text })).toMatchObject({
      code: "BACKEND_ERROR",
    });
  });
});

/**
 * The reader's document-wide scan (`document_path_functions`, scripts/linux/calc_state.py)
 * against a stand-in document: every sheet's formula cells and every named expression.
 */
function pyPathFunctions(doc: { sheets: string[][]; named: string[] }): boolean | null {
  const code = [
    "import importlib.util, json, sys",
    "spec = importlib.util.spec_from_file_location('calc_state', sys.argv[1])",
    "m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)",
    "d = json.loads(sys.stdin.read())",
    "class Cell:",
    "    def __init__(s, f): s.f = f",
    "    def getFormula(s): return s.f",
    "class Enum:",
    "    def __init__(s, xs): s.xs = list(xs)",
    "    def hasMoreElements(s): return bool(s.xs)",
    "    def nextElement(s): return s.xs.pop(0)",
    "class Cells:",
    "    def __init__(s, fs): s.fs = fs",
    "    def createEnumeration(s): return Enum(Cell(f) for f in s.fs)",
    "class Ranges:",
    "    def __init__(s, fs): s.fs = fs",
    "    def getCells(s): return Cells(s.fs)",
    "class Sheet:",
    "    def __init__(s, fs): s.fs = fs",
    "    def queryContentCells(s, flags):",
    "        assert flags == 16",
    "        return Ranges(s.fs)",
    "class Sheets:",
    "    def __init__(s, sh): s.sh = sh",
    "    def getCount(s): return len(s.sh)",
    "    def getByIndex(s, i): return Sheet(s.sh[i])",
    "class Named:",
    "    def __init__(s, c): s.c = c",
    "    def getContent(s): return s.c",
    "class NamedRanges:",
    "    def __init__(s, ns): s.ns = ns",
    "    def getElementNames(s): return ['n%d' % i for i in range(len(s.ns))]",
    "    def getByName(s, n): return Named(s.ns[int(n[1:])])",
    "class Doc:",
    "    def __init__(s, d): s.d = d; s.NamedRanges = NamedRanges(d['named'])",
    "    def getSheets(s): return Sheets(s.d['sheets'])",
    "print(json.dumps(m.document_path_functions(Doc(d))))",
  ].join("\n");
  const r = spawnSync(
    process.env.MYCO_PYTHON ?? "python3",
    ["-I", "-c", code, join(ROOT, "scripts", "linux", "calc_state.py")],
    { input: JSON.stringify(doc), encoding: "utf8" },
  );
  if (r.error) return null;
  if (r.status !== 0) throw new Error(`python failed: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

describe.runIf(python)("D5: the reader flags a path function anywhere in the document", () => {
  it("no path function: false", () => {
    expect(pyPathFunctions({ sheets: [["=A1*2", "=SUM(B1:B9)"], []], named: ["$seed.$A$1"] })).toBe(
      false,
    );
  });

  it.each([
    ["a CELL formula on the second sheet", { sheets: [["=A1"], ['=CELL("filename")']], named: [] }],
    ["a lower-case cell( formula", { sheets: [['=MID(cell("filename");10;3)']], named: [] }],
    ["an INFO formula", { sheets: [['=INFO("directory")']], named: [] }],
    ["a named expression", { sheets: [["=WHERE"]], named: ['CELL("filename")'] }],
  ])("%s: true", (_name, doc) => {
    expect(pyPathFunctions(doc)).toBe(true);
  });
});
