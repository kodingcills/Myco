/**
 * Capability track I: the state tools are read-only and scoped to the agent's own live
 * document (hermetic part; the real-Calc part is test/linux/state-e2e.test.ts).
 *
 * - Planted markers: a trial layout with PLANTED_FAKE_MARKER in the pristine fixture, the
 *   sealed vault, the oracle config and other trials' dirs. A battery of valid and hostile
 *   tool calls (path-like sheets and ranges, smuggled path / runId / taskId fields) never
 *   yields the marker or any of those host paths.
 * - The reader script (`calc_state.py`) has no write, dispatch, store, close or load call,
 *   takes no path, and never prints a document URL; the state modules import no file API.
 * - The CLI starts only when bound to one trial by the harness environment, and takes no
 *   argument but `mcp`.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { STATE_TOOL_NAMES } from "../../src/state/api.ts";
import { main } from "../../src/state/cli.ts";
import { createStateService, handleStateLine } from "../../src/state/server.ts";
import { fakeBackend } from "./fake-backend.ts";

const ROOT = resolve(import.meta.dirname, "..", "..");
const MARKER = "PLANTED_FAKE_MARKER";

let base: string;
let dirs: Record<"trial" | "agent" | "pristine" | "vault" | "oracle" | "other", string>;

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), "myco-state-scope-"));
  dirs = {
    trial: join(base, "runs", "run-a"),
    agent: join(base, "runs", "run-a", "agent"),
    pristine: join(base, "runs", "run-a", "fixture"),
    vault: join(base, "vault", "run-a"),
    oracle: join(base, "oracle"),
    other: join(base, "runs", "run-b", "agent"),
  };
  for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });
  writeFileSync(join(dirs.pristine, "fixture.csv"), `id,name\nEMP-0001,${MARKER}-pristine\n`);
  writeFileSync(
    join(dirs.vault, "ground-truth.json"),
    JSON.stringify({ expected: `${MARKER}-vault` }),
  );
  writeFileSync(join(dirs.vault, "receipt.json"), JSON.stringify({ hmac: `${MARKER}-receipt` }));
  writeFileSync(
    join(dirs.oracle, "config.json"),
    JSON.stringify({ expectedValue: `${MARKER}-oracle` }),
  );
  writeFileSync(join(dirs.other, "saved.csv"), `id,name\nEMP-0001,${MARKER}-other-trial\n`);
});
afterAll(() => rmSync(base, { recursive: true, force: true }));

/** Every call an agent could make, valid and hostile. */
function battery(): Array<[string, unknown]> {
  const hostile = [
    ...Object.values(dirs),
    "/etc/passwd",
    "../run-b/agent/saved.csv",
    "file:///etc/passwd",
    "C:\\Users\\agent\\vault",
    MARKER,
  ];
  const calls: Array<[string, unknown]> = [
    ["state_list_sheets", {}],
    ["state_document_status", {}],
    ["state_ui_tree", { maxDepth: 8, maxNodes: 200 }],
    ["state_read_range", { range: "A1:C3" }],
    ["state_read_range", { range: "A1:T20", sheet: 0 }],
  ];
  for (const h of hostile) {
    calls.push(["state_read_range", { range: h }]);
    calls.push(["state_read_range", { range: "A1", sheet: h }]);
    for (const field of ["path", "runId", "taskId", "file", "trial"])
      for (const tool of STATE_TOOL_NAMES)
        calls.push([tool, { ...(tool === "state_read_range" ? { range: "A1" } : {}), [field]: h }]);
  }
  calls.push([`../../${MARKER}`, {}]);
  return calls;
}

describe("planted markers never reach a state tool's output", () => {
  it("the agent's own live document is readable; nothing else is", async () => {
    const backend = fakeBackend({
      sheets: [
        {
          name: "employees",
          rows: [
            ["id", "name"],
            ["EMP-0001", "Ann (live)"],
          ],
        },
      ],
      modified: true,
      tree: {
        role: "root_pane",
        name: `${join(dirs.agent, "saved.xlsx")} — LibreOffice Calc`,
        childCount: 0,
      },
    });
    const service = createStateService({ backend, withheld: Object.values(dirs) });
    const outputs: string[] = [];
    for (const [name, args] of battery()) {
      const line = await handleStateLine(
        service,
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name, arguments: args },
        }),
      );
      outputs.push(line ?? "");
    }
    const all = outputs.join("\n");
    expect(all).toContain("Ann (live)");
    expect(all).not.toContain(MARKER);
    for (const d of [...Object.values(dirs), base]) expect(all).not.toContain(d);
    // The tree's window title held the agent dir; it was scrubbed, not withheld wholesale.
    expect(all).toContain("[path] — LibreOffice Calc");
  });
});

describe("the reader script only reads", () => {
  const reader = readFileSync(join(ROOT, "scripts", "linux", "calc_state.py"), "utf8");
  const code = reader
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n")
    .replace(/"""[\s\S]*?"""/g, "");

  it("has no UNO write, dispatch, store, close, load or terminate call", () => {
    for (const forbidden of [
      /\.store\w*\(/,
      /\.set(String|Value|Formula|Modified|PropertyValue|DataArray|FormulaArray)\(/,
      /executeDispatch/,
      /DispatchHelper/,
      /loadComponentFromURL/,
      /\.close\(/,
      /terminate\(/,
      /insertNew|removeByName|\.insert\(/,
      /\.select\(/,
    ])
      expect(code, String(forbidden)).not.toMatch(forbidden);
  });

  it("takes no path and never prints a URL or location", () => {
    expect(code).not.toMatch(/getURL|getLocation|systemPathToFileUrl|fileUrlToSystemPath|open\(/);
    expect(code).not.toMatch(/add_argument\("--(doc|path|file|out)/);
    expect(code).toContain('parser.add_argument("--pipe"');
  });

  it("never prints exception text", () => {
    expect(code).not.toMatch(/str\(exc\)|%s.*exc\b|exc\.args/);
  });
});

describe("state modules are file-free", () => {
  const files = ["api.ts", "backend.ts", "server.ts", "cli.ts", "linux/uno.ts"];
  it.each(files)("src/state/%s imports no file-system API", (file) => {
    const src = readFileSync(join(ROOT, "src", "state", file), "utf8");
    expect(src).not.toMatch(
      /from\s+["']node:fs|from\s+["']fs["']|readFile|writeFile|createReadStream/,
    );
  });
});

function sink(): Writable & { text: () => string } {
  let buf = "";
  const w = new Writable({
    write(chunk, _enc, cb) {
      buf += String(chunk);
      cb();
    },
  }) as Writable & { text: () => string };
  w.text = () => buf;
  return w;
}

describe("myco-state CLI binding", () => {
  const good = {
    MYCO_STATE_RUN_ID: "run-a",
    MYCO_STATE_UNO_PIPE: "myco-state-0123456789abcdef-a1b2c3d4e5f6",
    MYCO_STATE_WITHHELD: JSON.stringify(["/srv/myco/trials/run-a"]),
  };
  const run = async (argv: string[], env: Record<string, string>) => {
    const stdin = new PassThrough();
    stdin.end();
    const stderr = sink();
    const code = await main(argv, { stdin, stdout: sink(), stderr, env });
    return { code, stderr: stderr.text() };
  };

  it("serves when bound by the harness environment", async () => {
    expect((await run(["mcp"], good)).code).toBe(0);
  });

  it("refuses to start unbound, mis-bound, or with any extra argument", async () => {
    const cases: Array<[string[], Record<string, string>]> = [
      [["mcp"], {}],
      [["mcp"], { ...good, MYCO_STATE_RUN_ID: "" }],
      [["mcp"], { ...good, MYCO_STATE_RUN_ID: "../run-b" }],
      [["mcp"], { ...good, MYCO_STATE_UNO_PIPE: "/tmp/sock" }],
      [["mcp"], { ...good, MYCO_STATE_UNO_PIPE: "pipe,name=other" }],
      [["mcp"], { ...good, MYCO_STATE_WITHHELD: "{not json" }],
      // The withheld list is mandatory (D2, round 1): missing, empty or non-path refuses.
      [
        ["mcp"],
        {
          MYCO_STATE_RUN_ID: good.MYCO_STATE_RUN_ID,
          MYCO_STATE_UNO_PIPE: good.MYCO_STATE_UNO_PIPE,
        },
      ],
      [["mcp"], { ...good, MYCO_STATE_WITHHELD: "" }],
      [["mcp"], { ...good, MYCO_STATE_WITHHELD: "[]" }],
      [["mcp"], { ...good, MYCO_STATE_WITHHELD: JSON.stringify(["runs"]) }],
      [["mcp", "--doc", "/tmp/x.xlsx"], good],
      [["mcp", join(dirs.vault, "ground-truth.json")], good],
      [[], good],
    ];
    for (const [argv, env] of cases) {
      const r = await run(argv, env);
      expect(r.code, JSON.stringify([argv, env])).toBe(2);
      expect(r.stderr).not.toContain(MARKER);
    }
  });
});
