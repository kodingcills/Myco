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
import { createStateService, scrubPaths } from "../../src/state/server.ts";
import { rawBackend } from "./fake-backend.ts";

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

async function readA1(cell: object, withheld?: readonly string[]): Promise<Json> {
  const service = createStateService({ backend: rawBackend(oneCell(cell)), withheld });
  return service.call("state_read_range", { range: "A1" });
}

describe("D2: a formula-derived host path never reaches the agent", () => {
  it('=CELL("filename") whose path is NOT on the withheld list: scrubbed, flagged', async () => {
    const reply = await readA1({
      kind: "formula",
      formula: '=CELL("filename")',
      formulaResult: "text",
      value: CELL_FILENAME,
      display: CELL_FILENAME,
    });
    expect(reply.ok).toBe(true);
    const cell = reply.data.rows[0][0];
    expect(cell.display).toBe("'[path]'#$seed");
    expect(cell.value).toBe("'[path]'#$seed");
    expect(cell.formula).toBe('=CELL("filename")');
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
    expect(scrubPaths("C:\\Users\\u\\gt.json")).toBe("[path]");
    expect(scrubPaths("C:/Users/u/gt.json")).toBe("[path]");
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
