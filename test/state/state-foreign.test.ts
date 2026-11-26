/**
 * Capability track I, PR #545 round-1 verifier defect D7 (BLOCKING): content from other
 * files reached the agent through `state_read_range`.
 *
 * The verifier put a formula in `H1` that reads another file (`='../fixture/fixture.csv'
 * #$fixture.B2`, `INDIRECT(…)`, `DDE("soffice";…)`, a linked sheet) and `=H1` in `I1`, then
 * read only `I1`: the reply was `ok` and carried PLANTED_FAKE_MARKER from the pristine
 * fixture, the vault, the oracle config and another trial. The path sat only in `H1`'s
 * formula, so no check on the returned cells could see it.
 *
 * The fix is at the source, in three parts, each tested here (real Calc in
 * test/linux/state-e2e.test.ts):
 *
 *  1. the reader reads only the trial's own document: it is bound to the document's
 *     RuntimeUID (harness-read, `MYCO_STATE_DOC_UID`), so another file opened in its place
 *     (another trial's, the pristine fixture) is DOCUMENT_UNAVAILABLE;
 *  2. the reader reports `documentForeignContent` document-wide: a formula anywhere with an
 *     external reference or an INDIRECT/DDE/WEBSERVICE call, or any link container that is
 *     not empty (external-document, DDE, area and sheet links, a linked sheet, a database
 *     range or pilot table importing from a data source);
 *  3. the server requires that flag on every reply carrying document content
 *     (`state_list_sheets`, `state_read_range`, `state_ui_tree`), withholds while it is
 *     true, and checks every returned formula for a foreign reference itself.
 */
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createStateService, FOREIGN_REFERENCE } from "../../src/state/server.ts";
import { fakeBackend, rawBackend } from "./fake-backend.ts";

// biome-ignore lint/suspicious/noExplicitAny: replies are read loosely in tests
type Json = any;

const ROOT = resolve(import.meta.dirname, "..", "..");
const READER = join(ROOT, "scripts", "linux", "calc_state.py");
const MARKER = "PLANTED_FAKE_MARKER";
const python = spawnSync(process.env.MYCO_PYTHON ?? "python3", ["--version"]).error === undefined;

/** Each D7 source, as the cell the agent reads holds it: the value only, no formula. */
const PULLED = [
  ["the pristine fixture", `${MARKER}-pristine`],
  ["another trial", `${MARKER}-other`],
  ["the vault", `${MARKER}-vault`],
  ["the oracle config", `{"expected":"${MARKER}-oracle"}`],
] as const;

const TREE = { role: "frame", name: "Calc", childCount: 0 };

describe("D7, server: the foreign-content flag is mandatory and withholds", () => {
  const content = {
    state_list_sheets: [{}, { sheets: [], sheetCount: 0, truncated: false }],
    state_read_range: [
      { range: "I1" },
      {
        sheet: { index: 0, name: "seed" },
        range: "I1:I1",
        rows: [[{ ref: "I1", kind: "formula", formula: "=H1", value: 0, display: "0" }]],
      },
    ],
    state_ui_tree: [{}, { tree: TREE, nodes: 1, truncated: false }],
  } as const;

  it.each(Object.entries(content))("%s without the flag: BACKEND_ERROR", async (tool, pair) => {
    const [args, data] = pair;
    const service = createStateService({
      backend: rawBackend(data, { omitForeignFlag: true }),
      withheld: ["/srv/myco/trials/run-a"],
    });
    expect(await service.call(tool, args)).toMatchObject({ ok: false, code: "BACKEND_ERROR" });
  });

  it.each(Object.entries(content))(
    "%s with a non-boolean flag: BACKEND_ERROR",
    async (tool, pair) => {
      const [args, data] = pair;
      const service = createStateService({
        backend: rawBackend({ ...data, documentForeignContent: "false" }),
      });
      expect(await service.call(tool, args)).toMatchObject({ ok: false, code: "BACKEND_ERROR" });
    },
  );

  it.each(Object.entries(content))("%s with the flag true: OUTPUT_WITHHELD", async (tool, pair) => {
    const [args, data] = pair;
    const service = createStateService({
      backend: rawBackend({ ...data, documentForeignContent: true }),
    });
    expect(await service.call(tool, args)).toMatchObject({ ok: false, code: "OUTPUT_WITHHELD" });
  });

  it.each(Object.entries(content))(
    "%s with the flag false: ok, flag not echoed",
    async (tool, pair) => {
      const [args, data] = pair;
      const service = createStateService({ backend: rawBackend(data) });
      const reply: Json = await service.call(tool, args);
      expect(reply.ok, JSON.stringify(reply)).toBe(true);
      expect(JSON.stringify(reply)).not.toContain("documentForeignContent");
    },
  );

  it("document status carries no document content and needs no flag", async () => {
    const service = createStateService({
      backend: rawBackend(
        { modified: false, hasStorageLocation: true, readOnly: false, sheetCount: 1 },
        { omitForeignFlag: true },
      ),
    });
    expect((await service.call("state_document_status", {})).ok).toBe(true);
  });

  it.each(PULLED)(
    "a pulled value from %s never reaches the agent while the document links out",
    async (_from, value) => {
      // The verifier's shape: `I1` is `=H1`; `H1` (not read) holds the external reference.
      const backend = fakeBackend({
        sheets: [{ name: "seed", rows: [["id", value]] }],
        modified: false,
        tree: { role: "frame", name: value, childCount: 0 },
        links: true,
      });
      const service = createStateService({ backend, withheld: ["/srv/myco/trials/run-a"] });
      const replies = [
        await service.call("state_read_range", { range: "A1:B1" }),
        await service.call("state_list_sheets", {}),
        await service.call("state_ui_tree", {}),
      ];
      for (const reply of replies)
        expect(reply).toMatchObject({ ok: false, code: "OUTPUT_WITHHELD" });
      expect(JSON.stringify(replies)).not.toContain(MARKER);
    },
  );
});

describe("D7, server: a returned formula that reads another file is withheld whatever the flag says", () => {
  it.each([
    [
      "the verifier's relative reference (as Calc holds it)",
      "='file:///tmp/p/runs/run probe/fixture/fixture.csv'#$fixture.B2",
    ],
    ["an external named range", "='file:///tmp/vault/sealed.ods'#secret"],
    ["a space before the marker", "='x.csv' #$x.B2"],
    ["an unquoted external reference", "=x.csv#$Sheet1.B2"],
    ["INDIRECT", `=INDIRECT("'../fixture/fixture.csv'#$fixture.B2")`],
    ["lower-case indirect", "=indirect(A9)"],
    ["DDE", '=DDE("soffice";"/srv/vault/sealed.csv";"B2")'],
    ["WEBSERVICE", '=WEBSERVICE("file:///srv/vault/sealed.csv")'],
    ["a space before the paren", "=DDE (A1;A2;A3)"],
  ])("%s", async (_name, formula) => {
    expect(FOREIGN_REFERENCE.test(formula)).toBe(true);
    const service = createStateService({
      backend: rawBackend({
        sheet: { index: 0, name: "seed" },
        range: "A1:A1",
        rows: [[{ ref: "A1", kind: "formula", formula, value: 0, display: "0" }]],
        documentPathFunctions: false,
        documentForeignContent: false,
      }),
    });
    expect(await service.call("state_read_range", { range: "A1" })).toMatchObject({
      ok: false,
      code: "OUTPUT_WITHHELD",
    });
  });

  it.each([
    ["an in-document reference", "=$seed.B2"],
    ["a sheet-qualified range", "=SUM($Sheet2.A1:A9)"],
    ["an error constant", '=IFERROR(A1;"#N/A")'],
    ["a hash in text", '="item #3"'],
  ])("%s is not foreign", (_name, formula) => {
    expect(FOREIGN_REFERENCE.test(formula)).toBe(false);
  });
});

/**
 * Run `expr` against the reader module with a stand-in UNO document. The stand-in models
 * everything `document_foreign_content` and `document_links` read: formula cells, sheet-
 * and document-scoped names, validation formulas, the external-document, DDE, area and
 * sheet link containers, each sheet's link mode, database ranges (named and unnamed) and
 * pilot tables. `spec` overrides any part.
 */
function py(expr: string, spec: object = {}): Json {
  const code = [
    "import importlib.util, json, sys",
    "spec = importlib.util.spec_from_file_location('calc_state', sys.argv[1])",
    "m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)",
    "d = json.loads(sys.stdin.read())",
    "class O:",
    "    def __init__(s, **kw): s.__dict__.update(kw)",
    "class Enum:",
    "    def __init__(s, xs): s.xs = list(xs)",
    "    def hasMoreElements(s): return bool(s.xs)",
    "    def nextElement(s): return s.xs.pop(0)",
    "class Names:",
    "    def __init__(s, xs): s.xs = list(xs)",
    "    def getElementNames(s): return tuple('n%d' % i for i in range(len(s.xs)))",
    "    def getByName(s, n): return s.xs[int(n[1:])]",
    "    def getCount(s): return len(s.xs)",
    "    def getByIndex(s, i): return s.xs[i]",
    "def desc(t): return (O(Name='DatabaseName', Value=''), O(Name='SourceType', Value=O(value=t)))",
    "class Db:",
    "    def __init__(s, t): s.t = t",
    "    def getImportDescriptor(s): return desc(s.t)",
    "class Unnamed:",
    "    def __init__(s, ts): s.ts = ts",
    "    def hasByTable(s, i): return s.ts[i] is not None",
    "    def getByTable(s, i): return Db(s.ts[i])",
    "class Cells:",
    "    def __init__(s, fs): s.fs = fs",
    "    def getCells(s): return s",
    "    def createEnumeration(s): return Enum(O(getFormula=(lambda f=f: f)) for f in s.fs)",
    "class Sheet:",
    "    def __init__(s, sd):",
    "        s.sd = sd",
    "        s.NamedRanges = Names(O(getContent=(lambda c=c: c)) for c in sd.get('names', []))",
    "        vs = sd.get('validations', [['', '']])",
    "        s.CellFormatRanges = Names(O(Validation=O(getFormula1=(lambda v=v: v[0]), getFormula2=(lambda v=v: v[1]))) for v in vs)",
    "    def queryContentCells(s, flags):",
    "        assert flags == 16",
    "        return Cells(s.sd.get('cells', []))",
    "    def getLinkMode(s): return O(value=s.sd.get('linkMode', 'NONE'))",
    "    def getDataPilotTables(s):",
    "        return Names(O(SourceServiceName=p.get('service', ''), ImportDescriptor=desc(p.get('import', 'NONE'))) for p in s.sd.get('pilots', []))",
    "class Sheets:",
    "    def __init__(s, xs): s.xs = [Sheet(x) for x in xs]",
    "    def getCount(s): return len(s.xs)",
    "    def getByIndex(s, i): return s.xs[i]",
    "class Doc:",
    "    def __init__(s, d):",
    "        s.d = d",
    "        s.sheets = Sheets(d.get('sheets', [{}]))",
    "        s.NamedRanges = Names(O(getContent=(lambda c=c: c)) for c in d.get('named', []))",
    "        s.ExternalDocLinks = Names(d.get('ext', []))",
    "        s.DDELinks = Names(d.get('dde', []))",
    "        s.AreaLinks = Names(d.get('area', []))",
    "        s.SheetLinks = Names(d.get('sheetLinks', []))",
    "        s.DatabaseRanges = Names(Db(t) for t in d.get('dbs', []))",
    "        s.unnamed = Unnamed(d.get('unnamed', [None] * s.sheets.getCount()))",
    "    def getSheets(s): return s.sheets",
    "    def getPropertyValue(s, n):",
    "        if n == 'UnnamedDatabaseRanges': return s.unnamed",
    "        if n == 'RuntimeUID': return d.get('uid', '7')",
    "        raise KeyError(n)",
    "    def supportsService(s, n): return n == 'com.sun.star.sheet.SpreadsheetDocument'",
    "doc = Doc(d)",
    `print(json.dumps(${expr}))`,
  ].join("\n");
  const r = spawnSync(process.env.MYCO_PYTHON ?? "python3", ["-I", "-c", code, READER], {
    input: JSON.stringify(spec),
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(`python failed: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

const foreign = (spec: object) => py("m.document_foreign_content(doc)", spec);

describe.runIf(python)("D7, reader: content from outside the document is flagged", () => {
  it("a document with only in-document formulas and no links: false", () => {
    expect(
      foreign({
        sheets: [
          {
            cells: ["=A1*2", "=SUM($Sheet2.B1:B9)", '=IFERROR(A1;"#N/A")', '="item #3"'],
            names: ["$Sheet1.$A$1"],
            validations: [["$Sheet1.$A$1:$A$9", ""]],
            pilots: [{}],
          },
          { cells: [] },
        ],
        named: ["SUM($A$1:$A$3)"],
        dbs: ["NONE"],
        unnamed: ["NONE", null],
      }),
    ).toBe(false);
  });

  it.each([
    // Formulas (the verifier's H1), in every place the path scan covers.
    [
      "an external reference in a cell",
      { sheets: [{ cells: ["='file:///t/fixture/fixture.csv'#$fixture.B2"] }] },
    ],
    ["an external reference on the second sheet", { sheets: [{}, { cells: ["='x.csv'#$x.B2"] }] }],
    ["an external named range", { sheets: [{ cells: ["='file:///t/v.ods'#secret"] }] }],
    ["an unquoted external reference", { sheets: [{ cells: ["=x.csv#$Sheet1.B2"] }] }],
    ["INDIRECT", { sheets: [{ cells: [`=INDIRECT("'../fixture/fixture.csv'#$fixture.B2")`] }] }],
    ["lower-case indirect over a cell", { sheets: [{ cells: ["=indirect(A9)"] }] }],
    ["DDE", { sheets: [{ cells: ['=DDE("soffice";"/srv/v/sealed.csv";"B2")'] }] }],
    ["WEBSERVICE", { sheets: [{ cells: ["=WEBSERVICE(A1)"] }] }],
    ["an external reference in a sheet-scoped name", { sheets: [{ names: ["'x.csv'#$x.B2"] }] }],
    ["INDIRECT in a document name", { named: ["INDIRECT($A$1)"] }],
    [
      "an external reference in a validation list",
      { sheets: [{ validations: [["'x.csv'#$x.A1:A9", ""]] }] },
    ],
    ["DDE in validation Formula2", { sheets: [{ validations: [["1", 'DDE("a";"b";"c")']] }] }],
    // Link containers: what Calc keeps once content came in, whatever the formula said.
    [
      "an external-document link (kept after the formula is gone)",
      { ext: ["file:///t/fixture/fixture.csv"] },
    ],
    ["a DDE link", { dde: ["soffice|/srv/v/sealed.csv!B2"] }],
    ["an area link (Insert > Link to External Data)", { area: ["a"] }],
    ["a sheet link (Insert Sheet from File, Link)", { sheetLinks: ["file:///t/other/saved.csv"] }],
    ["a linked sheet (link mode NORMAL)", { sheets: [{}, { linkMode: "NORMAL" }] }],
    ["a linked sheet (link mode VALUE)", { sheets: [{ linkMode: "VALUE" }] }],
    ["a database range importing from a data source", { dbs: ["NONE", "TABLE"] }],
    ["an unnamed database range importing (SQL)", { sheets: [{}, {}], unnamed: [null, "SQL"] }],
    [
      "a pilot table over an external source service",
      { sheets: [{ pilots: [{ service: "x.Source" }] }] },
    ],
    ["a pilot table importing from a data source", { sheets: [{ pilots: [{ import: "QUERY" }] }] }],
  ])("%s: true", (_name, spec) => {
    expect(foreign(spec)).toBe(true);
  });

  it("a link container it cannot read fails the call (raises), never reports false", () => {
    expect(() => py("m.document_links(O())")).toThrow(/AttributeError/);
  });
});

describe.runIf(python)("D7, reader: only the trial's own document is ever read", () => {
  /** `the_document` over a stand-in desktop holding `docs`: the doc, or the refusal code. */
  const attempt = (docs: string, uid: string) =>
    pyBlock(
      [
        "def attempt(docs, uid):",
        "    desktop = O(getComponents=lambda: O(createEnumeration=lambda: Enum(docs)))",
        "    ctx = O(ServiceManager=O(createInstanceWithContext=lambda name, c: desktop))",
        "    try:",
        "        return 'read' if m.the_document(ctx, uid) is doc else 'other'",
        "    except m.Refusal as r:",
        "        return r.code",
      ],
      `attempt(${docs}, ${JSON.stringify(uid)})`,
      { uid: "7" },
    );

  it("the bound document (its RuntimeUID matches) is read", () => {
    expect(attempt("[doc]", "7")).toBe("read");
  });

  it.each([
    ["another document opened in its place (other uid)", "[doc]", "8"],
    ["the trial's document reopened (new uid)", "[doc]", "70"],
    ["no document loaded", "[]", "7"],
    ["a second spreadsheet open beside it", "[doc, doc]", "7"],
  ])("%s: DOCUMENT_UNAVAILABLE", (_name, docs, uid) => {
    expect(attempt(docs, uid)).toBe("DOCUMENT_UNAVAILABLE");
  });

  it("main refuses a uid that is not a RuntimeUID before connecting (INVALID_REQUEST)", () => {
    for (const uid of ["0", "01", "x", "1 ", "1\n", "12345678901", "file:///tmp/x.xlsx"]) {
      const r = spawnSync(
        process.env.MYCO_PYTHON ?? "python3",
        ["-I", READER, "--pipe", "myco-state-none-000000", "--uid", uid, "--timeout", "0"],
        { input: JSON.stringify({ op: "document_status" }), encoding: "utf8" },
      );
      expect(JSON.parse(r.stdout.trim()), uid).toEqual({ ok: false, code: "INVALID_REQUEST" });
    }
  });

  it("main has no default: the reader will not start without --uid", () => {
    const r = spawnSync(
      process.env.MYCO_PYTHON ?? "python3",
      ["-I", READER, "--pipe", "myco-state-none-000000"],
      { input: JSON.stringify({ op: "document_status" }), encoding: "utf8" },
    );
    expect(r.status).not.toBe(0);
    expect(r.stdout).not.toContain('"ok": true');
  });
});

/** Like `py`, with statements before the printed expression. */
function pyBlock(lines: readonly string[], expr: string, spec: object = {}): Json {
  return py(`(lambda: (exec(${JSON.stringify(lines.join("\n"))}, globals()), ${expr})[1])()`, spec);
}

describe.runIf(python)(
  "UI tree: the document's file name is redacted (round-1 non-blocking)",
  () => {
    it.each([
      ["the window title", "saved.xlsx — LibreOffice Calc", "[document] — LibreOffice Calc"],
      ["every occurrence", "saved.xlsx/saved.xlsx", "[document]/[document]"],
      ["a name without it", "Sheet1", "Sheet1"],
    ])("%s", (_name, name, want) => {
      expect(py(`m.redact_title(${JSON.stringify(name)}, "saved.xlsx")`)).toBe(want);
    });

    it("an empty title leaves names alone", () => {
      expect(py('m.redact_title("Calc", "")')).toBe("Calc");
    });
  },
);
