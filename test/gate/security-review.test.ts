/**
 * Pins `docs/security/gate-api-review.md` (track H) to main. The review is the record the
 * H fix PRs cite by finding id and code ref, so a stale ref or a missing finding is a
 * defect (#519 round 1, D1-D4; round 2, D1'). Four layers:
 *
 *  1. Every code ref is `file › symbol`, and the symbol's body holds what the doc says is
 *     there. Renaming or deleting the symbol, or moving the cited code out of it, breaks this
 *     test; an unrelated edit to the same file does not (line refs broke on every one).
 *  1b. No PR that has merged is described as open, lock-holding or pending, and this track's
 *     open PRs carry a tripwire that fails when they merge (round 2, D1').
 *  2. The round-1 refs anchored to `12c35ea`, and the claims round 1 got wrong ("codes
 *     only", the #514 lock), do not come back.
 *  3. The behaviour H-16 and H-17 describe is real: oracle reason text and the sealed
 *     fixture's name and digest reach the agent through the MCP reply. When a fix changes
 *     that, this test fails and the doc must change with it.
 *
 * Fakes only: a temp evidence root and the in-process MCP handler. No model, no VM.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { calcRecordEditFamily } from "../../src/gate/families.ts";
import { buildRegistry, createGate, fileEvidenceReader } from "../../src/gate/gate.ts";
import { GATE_TOOL, handleLine } from "../../src/gate/mcp-server.ts";
import { generateFixture } from "../../src/tasks/fixture.ts";
import { groundTruth } from "../../src/tasks/intent.ts";
import { tempRoot, writeState } from "./helpers.ts";

const repo = (path: string) => new URL(`../../${path}`, import.meta.url);
const DOC = readFileSync(repo("docs/security/gate-api-review.md"), "utf8");
/** The doc wraps lines; compare claims with whitespace collapsed. */
const FLAT = DOC.replace(/\s+/g, " ");

/**
 * PRs the doc cites that are on `origin/main` (checked at `05a465b`), with their merge
 * commits. `track` marks this track's own fix and test PRs, which the doc must call merged.
 */
const MERGED = [
  { pr: 508, sha: "a0cf862", track: false },
  { pr: 511, sha: "d632628", track: false },
  { pr: 512, sha: "08f487f", track: false },
  { pr: 514, sha: "9388442", track: false },
  { pr: 520, sha: "b174eea", track: true },
  { pr: 522, sha: "db9c5a2", track: true },
  { pr: 521, sha: "9f8ce5e", track: true },
  { pr: 523, sha: "05a465b", track: true },
] as const;

/**
 * This track's open PRs, each with a file it adds that is not on main. When one merges, its
 * file lands and the tripwire below fails until the doc stops calling it open.
 */
const OPEN: ReadonlyArray<{ readonly pr: number; readonly witness: string }> = [
  // Empty at 05a465b: #520, #521, #522 and #523 have all merged. A new open track-H PR the
  // doc cites goes here, with a file it adds (e.g. { pr: 5NN, witness: "test/gate/x.test.ts" }).
];

/**
 * Open PRs off this track that the doc cites for their file locks: #503 (xlsx), #513 (watch
 * view), #518 (attempt ledger). No tripwire on purpose: it would turn their CI red for a
 * docs reason, and #503 is on the integrity critical path. They are re-checked by hand.
 */
const UNTRACKED_OPEN = [503, 513, 518];

/** Wording that treats PR `pr` as still open or pending. */
function pendingPhrases(pr: number): RegExp[] {
  return [
    new RegExp(`after #${pr} merges`),
    new RegExp(`#${pr}'s (file|to make)`),
    new RegExp(`#${pr} (owns|still owns|pins today)`),
    new RegExp(`(fix|test) now(\\*\\*)? \\(#${pr}\\b`),
    new RegExp(`Fix \\(this track, #${pr}\\)`),
    new RegExp(`#${pr} \\(H-\\d+ on this track\\)`),
    new RegExp(`\\bopen (PR )?#${pr}\\b`),
    new RegExp(`#${pr}\\b[^.]{0,120}(right after it merges|in its next round)`),
  ];
}

const FILES: Record<string, string> = {
  "api.ts": "src/gate/api.ts",
  "gate.ts": "src/gate/gate.ts",
  "mcp-server.ts": "src/gate/mcp-server.ts",
  "cli.ts": "src/gate/cli.ts",
  "sealed.ts": "src/gate/sealed.ts",
  "families.ts": "src/gate/families.ts",
  "calc-document.ts": "src/gate/calc-document.ts",
  "corrections.ts": "src/gate/corrections.ts",
  "multistep.ts": "src/gate/multistep.ts",
  "vault.ts": "src/integrity/vault.ts",
  "gate.test.ts": "test/gate/gate.test.ts",
  "sealed-gate.test.ts": "test/gate/sealed-gate.test.ts",
  "ledger.ts": "src/integrity/ledger.ts",
  "reasons.ts": "src/gate/reasons.ts",
  "stdio-frame.ts": "src/gate/stdio-frame.ts",
  "myco-gate.ts": "scripts/myco-gate.ts",
  "input-fuzz.test.ts": "test/gate/input-fuzz.test.ts",
};

/**
 * Files the doc may cite by symbol without a pin, each with why. Every other `›` ref must
 * name a file in FILES, so a typo'd or unknown filename fails instead of passing unpinned.
 */
const UNPINNED_FILES: Readonly<Record<string, string>> = {
  "src/watch/page.ts": "on #513's branch, not on main; cited for what that branch will add",
};

/**
 * Doc ref, then what the named symbol's body must contain. A ref is `file › symbol`, and
 * `›` steps into a nested symbol (`gate.ts › createGate › decide`). A symbol is a function,
 * class, interface, type, enum, const/let or method name; a quoted segment is a
 * `describe`/`it` title prefix in a test file; `(module comment)` is the file's leading doc
 * comment. One symbol can back several claims, each with its own regex. The regex must
 * match the symbol's code with comments blanked; a third element `"comment"` marks a claim
 * about a comment, which must then match only inside one.
 */
const ANCHORS: ReadonlyArray<readonly [string, RegExp] | readonly [string, RegExp, "comment"]> = [
  // Threat model and authz design
  ["gate.ts › Assignment", /export interface Assignment/],
  ["gate.ts › GateConfig", /readonly assignment: Assignment/],
  ["gate.ts › GateConfig", /readonly onDecision\?/],
  ["api.ts › GateRequest", /export interface GateRequest/],
  ["api.ts › parseGateRequest", /export function parseGateRequest/],
  ["mcp-server.ts › serveStdio", /export function serveStdio/],
  ["gate.ts › STATE_FILE_LIMIT", /STATE_FILE_LIMIT = 16 \* 1024 \* 1024/],
  ["gate.ts › fileEvidenceReader › read", /opened\.size > STATE_FILE_LIMIT/],
  ["api.ts › GateResult", /export interface GateResult/],
  ["mcp-server.ts › callTool", /structuredContent: result/],
  ["cli.ts › operatorGate", /function operatorGate/],
  ["api.ts › parseGateRequest", /unknown request field\(s\): \$\{unknown\.join/],
  ["sealed.ts › createSealedGate", /export function createSealedGate/],
  [
    "gate.ts › createGate › decide",
    /taskId !== assignment\.taskId \|\| runId !== assignment\.runId/,
  ],
  ["gate.ts › createGate › finish", /await config\.onDecision\(result\)/],
  // D4: CLI scope
  ["cli.ts › parseFlags", /function parseFlags\(argv/],
  ["cli.ts › main", /gate\.check\(\{\s*taskId: task,\s*runId: run/],
  ["cli.ts › operatorGate", /loadTasksFile\(tasksFile\)/],
  // H-01 (fixed by #520, merged)
  ["stdio-frame.ts › MAX_FRAME_BYTES", /export const MAX_FRAME_BYTES = 1024 \* 1024;/],
  ["stdio-frame.ts › OVERSIZED_FRAME_LINE", /OVERSIZED_FRAME_LINE = '\{"id":null\}'/],
  ["myco-gate.ts › stdin", /boundFrames\(process\.stdin/],
  ["mcp-server.ts › serveStdio", /createInterface\(/],
  ["mcp-server.ts › handleLine", /export async function handleLine/],
  ["api.ts › parseGateRequest", /record\.claim\.length > CLAIM_LIMIT/],
  // H-02
  ["mcp-server.ts › callTool", /unknown tool: \$\{params\.name\}/],
  ["mcp-server.ts › handleLine", /method not found: \$\{request\.method\}/],
  // H-03
  ["api.ts › parseGateRequest", /claim is longer than/],
  ["cli.ts › operatorGate", /appendFileSync\(audit/],
  ["api.ts › GateRequest", /never read by the oracle/, "comment"],
  // H-04
  ["corrections.ts › documentCorrections", /chars\.slice\(0, CORRECTION_VALUE_LIMIT\)/],
  // H-05
  ["gate.ts › createGate › check", /async check\(raw\)/],
  ["cli.ts › main", /serveStdio\(gate, io\.stdin, io\.stdout/],
  ["multistep.ts › MultiStepTrialRecord", /retryBudget: 0 \| 1/],
  ["multistep.ts › runMultiStepTrial", /retryBudget must be 0 or 1/],
  ["mcp-server.ts › serveStdio", /chain = chain\.then\(/],
  ["sealed.ts › BEFORE_CAPTURE", /BEFORE_CAPTURE = new Set/],
  ["sealed.ts › sealedEvidenceReader › read", /no sealed capture yet/],
  // H-06
  [
    "sealed.ts › sealedEvidenceReader › read",
    /bytes\.length > STATE_FILE_LIMIT[\s\S]*cause: "unreadable"/,
  ],
  ["sealed.ts › sealedEvidenceReader › read", /if \(bytes\.length > STATE_FILE_LIMIT\)/],
  ["vault.ts › VerdictVault › readChecked", /readRegularNoBlock\(path, \{ maxBytes: VAULT_READ_LIMIT_BYTES/],
  // H-07, H-08
  ["api.ts › ID", /\^\[A-Za-z0-9\]\[A-Za-z0-9\._-\]\{0,127\}\$/],
  ["sealed.ts › sealedEvidenceReader › read", /openForTrial\(vault, binding, runId\)/],
  ["gate.ts › createGate", /const assignment = \{ \.\.\.config\.assignment \}/],
  ["gate.ts › fileEvidenceReader", /const segments = \[runId, \.\.\.stateFile\.split/],
  ["vault.ts › VerdictVault › seal", /existsSync\(dir\)/],
  // H-09
  ["mcp-server.ts › serveStdio", /\} catch \{[\s\S]*code: -32603/],
  [
    'input-fuzz.test.ts › "H-09: a deeply nested JSON-RPC id"',
    /-32603 from serveStdio[\s\S]*code: -32603/,
  ],
  // H-10..H-15
  ["vault.ts › VerdictVault › runDir", /join\(this\.root, runId\)/],
  ["vault.ts › SealReceipt", /export interface SealReceipt/],
  ["ledger.ts › appendChainedRow", /export function appendChainedRow/],
  ["vault.ts › VaultOptions", /export interface VaultOptions/],
  ["vault.ts › SealInput", /sourceFiles: readonly string\[\]/],
  ["sealed.ts › (module comment)", /Agent-facing details carry `integrity:<code>` only/, "comment"],
  [
    'gate.test.ts › "gate: the assignment binds the gate to one trial"',
    /function spyReader[\s\S]*invalid gate assignment/,
  ],
  [
    "sealed-gate.test.ts › \"the agent's run id never selects another trial's sealed bytes\"",
    /naming an earlier honest trial is ASSIGNMENT_MISMATCH/,
  ],
  ["vault.ts › VerdictVault › seal", /oracle source \$\{path\} is not absolute/],
  ["gate.ts › GateConfig", /export interface GateConfig/],
  // H-16
  ["gate.ts › createGate › decide", /reasons: \[\.\.\.valid\.reasons\]/],
  ["families.ts › targetReason", /TARGET_MISMATCH: cell \$\{ref\}/],
  ["calc-document.ts › collateralReason", /DOCUMENT_COLLATERAL: \$\{collateral\.length\}/],
  ["families.ts › calcRecordEditFamily › decide", /persisted as \$\{JSON\.stringify\(newValue\)\}/],
  ["gate.ts › createGate › decide", /could not look: \$\{read\.detail\}/],
  ["gate.ts › bindDescriptorPath", /descriptor path check/],
  ["gate.ts › createGate › decide", /could not look: \$\{corrupt\.message\}/],
  ["gate.ts › EvidenceReader", /must name paths relative to the run/, "comment"],
  ["gate.ts › bindDescriptorPath", /const shown = actual\.startsWith\(`\$\{realRoot\}\/`\)/],
  ["reasons.ts › errorCode", /export function errorCode\(error: unknown\): string/],
  ["gate.ts › fileEvidenceReader › read", /open failed: \$\{errorCode\(error\)\}/],
  ["gate.ts › fileEvidenceReader › read", /read failed: \$\{errorCode\(error\)\}/],
  ["gate.ts › createGate › diagnose", /function diagnose\([\s\S]*errorCode\(error\)/],
  // H-17
  [
    "gate.ts › createGate › decide",
    /kind: "sealed-fixture",[\s\S]*path: sealed\.file,[\s\S]*sha256: digest/,
  ],
];

/** `file › symbol` refs in the doc, optionally under a `src/…/` or `test/…/` path. */
const SYMBOL_REF =
  /`((?:[\w.-]+\/)*)([\w.-]+\.ts)((?: › (?:[\w$]+|"[^"`]+"|\(module comment\)))+)`/g;

/** The name a declaration introduces, or a test block's title. */
function declaredName(node: ts.Node): string | undefined {
  // An overload signature has no body: the implementation is the declaration.
  if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && !node.body) {
    return undefined;
  }
  if (
    (ts.isFunctionDeclaration(node) ||
      ts.isClassDeclaration(node) ||
      ts.isInterfaceDeclaration(node) ||
      ts.isTypeAliasDeclaration(node) ||
      ts.isEnumDeclaration(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isVariableDeclaration(node)) &&
    node.name &&
    ts.isIdentifier(node.name)
  ) {
    return node.name.text;
  }
  if (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    ["describe", "it", "test"].includes(node.expression.text) &&
    node.arguments[0] &&
    ts.isStringLiteralLike(node.arguments[0])
  ) {
    return JSON.stringify(node.arguments[0].text);
  }
  return undefined;
}

function matchesSegment(node: ts.Node, segment: string): boolean {
  const name = declaredName(node);
  if (name === undefined) return false;
  // A quoted segment is a title prefix: `"H-09: a deeply nested"` names that `it` block.
  return segment.startsWith('"') ? name.startsWith(segment.slice(0, -1)) : name === segment;
}

/**
 * The nodes under `root` that `segment` names. A name is looked up among `root`'s own
 * members: the search does not enter another named declaration (a local `seal` inside
 * `VerdictVault › verify` is not `VerdictVault › seal`). A quoted test title is searched at
 * any depth.
 */
function findNamed(root: ts.Node, segment: string): ts.Node[] {
  const found: ts.Node[] = [];
  const anyDepth = segment.startsWith('"');
  const visit = (node: ts.Node) => {
    if (matchesSegment(node, segment)) found.push(node);
    else if (anyDepth || declaredName(node) === undefined) ts.forEachChild(node, visit);
  };
  ts.forEachChild(root, visit);
  return found;
}

/**
 * `text` with every comment blanked to spaces (newlines kept), so offsets still line up.
 * Comments are found in the trivia before each token in the AST, so `//` or `/*` inside
 * a string or template literal is code, not a comment.
 */
const BLANKED = new Map<string, string>();
function blankComments(source: ts.SourceFile): string {
  const cached = BLANKED.get(source.fileName);
  if (cached !== undefined) return cached;
  const text = source.getFullText();
  // UTF-16 units, as TypeScript's offsets count them (a spread would split by code point).
  const chars = text.split("");
  const blank = (pos: number, end: number) => {
    for (let i = pos; i < end; i++) if (chars[i] !== "\n") chars[i] = " ";
  };
  const visit = (node: ts.Node) => {
    if (ts.isJSDoc(node)) return;
    const children = node.getChildren(source);
    if (children.length === 0 || node.kind === ts.SyntaxKind.EndOfFileToken) {
      // Trivia before a token holds comments on the previous token's line ("trailing", in
      // TypeScript's terms) and comments on later lines ("leading"): blank both.
      ts.forEachTrailingCommentRange(text, node.getFullStart(), blank);
      ts.forEachLeadingCommentRange(text, node.getFullStart(), blank);
    }
    for (const child of children) visit(child);
  };
  visit(source);
  // A source with no code at all (or a file comment) leaves trivia on the first token only.
  ts.forEachLeadingCommentRange(text, 0, blank);
  const blanked = chars.join("");
  BLANKED.set(source.fileName, blanked);
  return blanked;
}

/** The node's [start, end) from its leading `/** … *\/` comment, if any, to its end. */
function bodyRange(source: ts.SourceFile, node: ts.Node): readonly [number, number] {
  // A const's doc comment and `export` sit on its statement, not its declaration.
  const outer =
    ts.isVariableDeclaration(node) && ts.isVariableStatement(node.parent.parent)
      ? node.parent.parent
      : node;
  const text = source.getFullText();
  const docs = (ts.getLeadingCommentRanges(text, outer.getFullStart()) ?? []).filter((range) =>
    text.startsWith("/**", range.pos),
  );
  const start = docs.at(-1)?.pos ?? outer.getStart(source);
  return [start, outer.getEnd()];
}

/** A symbol's text: `full` with its comments, `code` with them blanked. */
interface SymbolBody {
  readonly full: string;
  readonly code: string;
}

/**
 * Resolves `file › a › b` to the text of symbol `b` inside `a`. Each step must name exactly
 * one declaration: the first among the file's top-level statements (any depth for a quoted
 * test title), later ones among the previous step's members.
 */
function symbolBody(ref: string): SymbolBody {
  const [name, ...segments] = ref.split(" › ");
  const file = FILES[name ?? ""];
  if (!file || segments.length === 0) throw new Error(`bad ref ${ref}`);
  const path = fileURLToPath(repo(file));
  expect(existsSync(path), `${ref}: ${file} does not exist`).toBe(true);
  const text = readFileSync(path, "utf8");
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  if (segments.length === 1 && segments[0] === "(module comment)") {
    const first = ts.getLeadingCommentRanges(text, 0)?.[0];
    expect(first && text.startsWith("/**", first.pos), `${ref}: no module comment`).toBe(true);
    const full = text.slice(first?.pos, first?.end);
    return { full, code: "" };
  }
  let node: ts.Node = source;
  for (const [i, segment] of segments.entries()) {
    const candidates =
      i === 0 && !segment.startsWith('"')
        ? source.statements.flatMap((statement): ts.Node[] =>
            ts.isVariableStatement(statement)
              ? statement.declarationList.declarations.filter((d) => matchesSegment(d, segment))
              : matchesSegment(statement, segment)
                ? [statement]
                : [],
          )
        : findNamed(node, segment);
    expect(candidates.length, `${ref}: ${segment} is declared ${candidates.length} times`).toBe(1);
    node = candidates[0] as ts.Node;
  }
  const [start, end] = bodyRange(source, node);
  return { full: text.slice(start, end), code: blankComments(source).slice(start, end) };
}

/** Every `file › symbol` ref the doc makes into FILES, with any directory prefix dropped. */
const DOC_REFS = [...DOC.matchAll(SYMBOL_REF)]
  .filter(([, , name]) => (name ?? "") in FILES)
  .map(([, , name, path]) => `${name}${path}`);

describe("the security review's symbol refs hold on main (D1)", () => {
  it.each(ANCHORS)("%s holds %s", (ref, anchor, where?: "comment") => {
    expect(DOC_REFS, `the doc no longer cites ${ref}`).toContain(ref);
    const body = symbolBody(ref);
    // Code by default: a comment that merely mentions the code does not count. An anchor
    // that cites a comment says so, and must then match inside a comment.
    if (where === "comment") {
      expect(body.full).toMatch(anchor);
      expect(body.code).not.toMatch(anchor);
    } else {
      expect(body.code).toMatch(anchor);
    }
  });

  it("every symbol ref the doc makes into these files is pinned above", () => {
    const pinned = new Set(ANCHORS.map(([ref]) => ref));
    expect(new Set(DOC_REFS).size).toBeGreaterThan(40);
    expect(DOC_REFS.filter((ref) => !pinned.has(ref))).toEqual([]);
  });

  it("every symbol ref names a pinned file, or one allowlisted as unpinned", () => {
    const unknown: string[] = [];
    const cited = new Set<string>();
    for (const [ref, dir = "", name = ""] of DOC.matchAll(SYMBOL_REF)) {
      const full = `${dir}${name}`;
      if (full in UNPINNED_FILES) {
        cited.add(full);
        continue;
      }
      // A directory prefix must be the pinned file's own path, not just end in its name.
      const pinned = FILES[name];
      if (!pinned || (dir !== "" && pinned !== full)) unknown.push(ref);
    }
    expect(unknown).toEqual([]);
    // An allowlist entry the doc no longer cites is stale.
    expect([...cited].sort()).toEqual(Object.keys(UNPINNED_FILES).sort());
  });

  it("no line-number ref is left: every code ref is by symbol", () => {
    // Line refs broke on every unrelated edit to a gate file (#519 after #534, #542, #535).
    expect(DOC).not.toMatch(/\.ts:\d/);
    // A bare `:NNN` ref would name no file at all.
    expect(DOC).not.toMatch(/`:\d/);
    // A `›` ref the sweep above cannot parse would dodge it.
    const parsed = [...DOC.matchAll(SYMBOL_REF)].length;
    expect(DOC.match(/`[^`]*› [^`]*`/g)?.length ?? 0).toBe(parsed);
  });

  it("anchors match code: every comment is blanked, and only comments", () => {
    const sub = "$" + "{1}"; // a template substitution, spelled so it is not one here
    const text = [
      "/** doc A */",
      "function f() {",
      // A character outside the BMP is two UTF-16 units: offsets after it must still line up.
      '  const a = g("\u{1F344}", // trailing B',
      "    // own-line C",
      `    "// in a string", \`/* in a template ${sub} */\`); /* block D */`,
      "  return a; }",
      "// end E",
    ].join("\n");
    const code = blankComments(ts.createSourceFile("blank-probe.ts", text, ts.ScriptTarget.Latest));
    expect(code).toHaveLength(text.length);
    expect(code.split("\n")).toHaveLength(text.split("\n").length);
    for (const comment of ["doc A", "trailing B", "own-line C", "block D", "end E"]) {
      expect(code).not.toContain(comment);
    }
    expect(code.replace(/\s+/g, " ").trim()).toBe(
      `function f() { const a = g("\u{1F344}", "// in a string", \`/* in a template ${sub} */\`); return a; }`,
    );
  });

  it("the resolver rejects a symbol that is not declared, or declared twice", () => {
    expect(() => symbolBody("gate.ts › noSuchSymbol")).toThrow(/declared 0 times/);
    expect(() => symbolBody("gate.ts › createGate › noSuchSymbol")).toThrow(/declared 0 times/);
    // A local `const seal` in another method is not a member of the class.
    expect(() => symbolBody("vault.ts › VerdictVault › seal")).not.toThrow();
    expect(() => symbolBody('gate.test.ts › "gate: "')).toThrow(/declared \d{2,} times/);
  });

  it("re-anchors the status line past #514, #511, #520, #521, #522, #523 and #512", () => {
    expect(DOC).not.toMatch(
      /\*\*Status:\*\* review of `origin\/main` at `(12c35ea|d632628|08f487f|9f8ce5e)`/,
    );
    expect(DOC).toMatch(/\*\*Status:\*\* review of `origin\/main` at `05a465b`/);
    expect(FLAT).toContain("which includes #514 (agent-safe corrections) and #511");
    const status = FLAT.slice(0, FLAT.indexOf("**Scope.**"));
    // #508 is the starting list, not a merge the review is anchored past.
    for (const { pr } of MERGED.filter((p) => p.pr !== 508)) {
      expect(status, `#${pr}`).toContain(`#${pr}`);
    }
  });

  it("drops the round-1 refs that moved when #514 merged", () => {
    for (const stale of [
      "mcp-server.ts:154-155",
      "mcp-server.ts:65",
      "mcp-server.ts:162-166",
      "mcp-server.ts:154-175",
      "api.ts:270-277",
      "api.ts:270-278",
      "api.ts:301",
      "api.ts:228-233",
      "api.ts:254-316",
      "api.ts:298-313",
      "gate.ts:599",
      "gate.ts:673-682",
      "gate.ts:639-654",
      "gate.ts:825-840",
      "gate.ts:425-429",
      "gate.ts:168",
      "cli.ts:101-125",
      "cli.ts:122",
      "cli.ts:173-176",
    ]) {
      expect(DOC, stale).not.toContain(stale);
    }
    expect(DOC).not.toMatch(/`:145`/);
  });

  it("the coordination table no longer locks files on merged PRs", () => {
    const table = DOC.slice(DOC.indexOf("**Coordination.**"), DOC.indexOf("## Threat model"));
    expect(table).not.toMatch(/^\| #514/m);
    expect(table).not.toMatch(/^\| #511/m);
    expect(table).toMatch(/^\| #503 xlsx replacement/m);
    for (const { pr } of MERGED)
      expect(table, `#${pr}`).not.toMatch(new RegExp(`^\\| #${pr}\\b`, "m"));
    expect(FLAT).toContain("So `mcp-server.ts` is fixable now.");
  });

  it("re-decides the findings round 1 deferred on #514's locks", () => {
    expect(DOC).not.toContain("TO FILE on #514");
    expect(DOC).not.toContain("after #514 merges");
    expect(DOC).not.toContain("`gated-trial.ts` is in #514");
    expect(FLAT).toContain(
      "H-04: `corrections[].observed` carries document free text (Low; TO FILE on main)",
    );
    expect(FLAT).toContain("Fix (re-decided: unlocked, fix next)");
    expect(FLAT).toContain("MCP half (re-decided):");
    expect(FLAT).toContain("Fix (re-decided: still deferred)");
    expect(FLAT).toContain("Smallest future seam, now unblocked:");
  });
});

describe("the security review names no merged PR as open or pending (D1')", () => {
  it.each(MERGED)(
    "#$pr (merged $sha) is not described as open, owning files or pending",
    ({ pr }) => {
      for (const pending of pendingPhrases(pr)) {
        expect(FLAT, `#${pr} is merged, but the doc says: ${pending.source}`).not.toMatch(pending);
      }
    },
  );

  it.each(MERGED.filter((p) => p.track))(
    "this track's #$pr is marked merged with its commit $sha",
    ({ pr, sha }) => {
      expect(FLAT).toContain(`#${pr}, merged \``);
      expect(FLAT).toContain(sha);
    },
  );

  it("open track-H PRs the doc cites have not merged (tripwire: their witness file is absent)", () => {
    for (const { pr, witness } of OPEN) {
      // When the PR merges, its new file lands, this fails, and the doc's "fix now"/"test
      // now"/coordination text for it must become "fixed"/"tested (merged)".
      expect(
        existsSync(fileURLToPath(repo(witness))),
        `#${pr} has merged (${witness} exists): update docs/security/gate-api-review.md, then move #${pr} to MERGED here`,
      ).toBe(false);
      expect(FLAT).toContain(`#${pr}`);
    }
  });

  it("no track-H PR is left as 'fix now' or 'test now' (all merged at 05a465b)", () => {
    expect(OPEN).toEqual([]);
    expect(FLAT).not.toMatch(/\*\*(fix|test) now\*\*/);
    expect(FLAT).toContain("No track-H PR is open.");
  });

  it("every PR the doc mentions is classified as merged, open or reference-only", () => {
    const known = new Set<number>([...MERGED, ...OPEN].map(({ pr }) => pr));
    for (const pr of UNTRACKED_OPEN) known.add(pr);
    const mentioned = [...new Set([...DOC.matchAll(/#(\d{3})\b/g)].map(([, n]) => Number(n)))];
    expect(mentioned.filter((n) => !known.has(n))).toEqual([]);
  });

  it("code comments on the merged files agree with the doc (nits)", () => {
    const frame = readFileSync(repo("src/gate/stdio-frame.ts"), "utf8");
    expect(frame).not.toContain("about 250 times");
    expect(frame).toContain("about 43 times the largest valid request");
    const fuzz = readFileSync(repo("test/gate/input-fuzz.test.ts"), "utf8");
    expect(fuzz).not.toContain("mcp-server.ts is owned by #514");
    expect(fuzz).toContain("TO FILE 6 in docs/security/gate-api-review.md");
  });

  it("H-16's 'no host path' cites the enforcement, not only the rule's doc comment", () => {
    const h16 = FLAT.slice(FLAT.indexOf("### H-16:"), FLAT.indexOf("### H-17:"));
    expect(h16).toContain(
      "strips the evidence root before it names a path (`gate.ts › bindDescriptorPath`)",
    );
    expect(h16).toContain("`errorCode`, `reasons.ts › errorCode`");
  });

  it("H-06 says the sealed size cap has landed (#521), and the vault side stays deferred", () => {
    expect(FLAT).toContain("**fixed** (#521, merged `9f8ce5e`, gate side); vault side TO FILE 4");
    expect(DOC).toMatch(/^### H-06: .*\(Low; fixed by #521 gate side, merged\)$/m);
    expect(FLAT).not.toContain("Capped at 16 MiB on the mock path only");
    expect(FLAT).toContain("`test/gate/sealed-size-cap.test.ts` pins it");
  });

  it("the H-01/H-07/H-09 decisions say the merged work has landed", () => {
    expect(FLAT).toContain("**fixed** (#520, merged `b174eea`)");
    expect(FLAT).toContain("**tested** (#522, merged `db9c5a2`)");
    expect(FLAT).toContain("tested (#522, merged `db9c5a2`); fix next (unlocked): TO FILE 6");
    expect(DOC).toMatch(/^### H-01: .*\(Medium; fixed by #520, merged\)$/m);
    expect(DOC).toMatch(/^### H-07: Input fuzzing \(Info; tested by #522, merged\)$/m);
    expect(DOC).toMatch(/^### H-09: .*\(Info; tested by #522, fix next\)$/m);
  });
});

describe("the security review records what round 1 missed", () => {
  it("D2: H-16, oracle reason text reaches the agent, with a decision; 'codes' is scoped to error text", () => {
    expect(DOC).toMatch(
      /^### H-16: Oracle reason text reaches the agent verbatim \(Low; defer\)$/m,
    );
    expect(FLAT).toContain("even with corrections off");
    expect(FLAT).toContain("TO FILE 9");
    expect(FLAT).not.toContain("Agent-facing reasons carry codes (");
    expect(FLAT).not.toContain("- Agent-facing reasons carry codes.");
    expect(FLAT).toContain("Agent-facing *reasons* as a whole are not codes only");
  });

  it("D3: H-17, evidenceRefs carry the sealed fixture's name and sha256, with a decision", () => {
    expect(DOC).toMatch(
      /^### H-17: `evidenceRefs` give the agent the sealed fixture's name and digest/m,
    );
    expect(FLAT).toContain("**Decision:** keep for self-hosted.");
    expect(FLAT).toContain("TO FILE 10");
  });

  it("D4: the CLI reads no agent JSON", () => {
    expect(FLAT).toContain("The CLI reads no agent JSON: the request is built from argv flags");
    expect(FLAT).toContain("the only JSON it parses is the operator's trusted `--tasks` file");
  });

  it("#523's hosting observation: case-folding aliasing of operator run ids, with a decision", () => {
    expect(FLAT).toContain("Operator-side aliasing (from #523's verifier).");
    expect(FLAT).toContain(
      "operators must assign run ids that are unique after case folding and after stripping trailing dots",
    );
    expect(FLAT).toContain("TO FILE 8");
  });

  it("#520's nit 3: the frame cap bounds one frame, not the serveStdio queue (H-05)", () => {
    const h05 = FLAT.slice(FLAT.indexOf("### H-05:"), FLAT.indexOf("### H-06:"));
    expect(h05).toContain("Rate and backpressure:");
    expect(h05).toContain("the H-01 cap bounds one frame, not the queue");
  });

  it("nits: the frame-cap ratio is about 43x, and ASSIGNMENT_MISMATCH's echo is noted", () => {
    expect(FLAT).not.toContain("about 250 times");
    expect(FLAT).toContain("about 43 times the largest valid request");
    expect(FLAT).toContain(
      "`ASSIGNMENT_MISMATCH` (`gate.ts › createGate › decide`) also echoes the agent's task and run ids",
    );
  });
});

// ---------------------------------------------------------------------------
// Behaviour behind H-16 and H-17, through the MCP reply the agent reads.

const SEED = "security-review-seed";
const INTENT = { rowKey: "EMP-0004", column: "qty", newValue: "4242" };
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

function csvOf(rows: readonly (readonly string[])[]): string {
  return `${rows.map((r) => r.join(",")).join("\n")}\n`;
}

/** The pristine fixture with one non-target cell changed (B2) and the target left alone. */
function collateralOnly(fixture: string): string {
  const rows = fixture
    .trimEnd()
    .split("\n")
    .map((l) => l.split(","));
  const { location } = groundTruth({ fixtureSeed: SEED, ...INTENT });
  expect(location.dataRowIndex).not.toBe(0);
  (rows[1] as string[])[1] = "changed by the agent";
  return csvOf(rows);
}

async function agentReply(saved: string) {
  const fixture = generateFixture(SEED).csv;
  const root = tempRoot();
  writeState(root, "r", "sheet.csv", saved);
  writeState(root, "r", "fixture.csv", fixture);
  const spec = {
    fixtureSeed: SEED,
    ...INTENT,
    fixtureFile: "fixture.csv",
    fixtureSha256: sha256(fixture),
  };
  const gate = createGate({
    tasks: buildRegistry(
      [{ id: "calc", family: "calc-record-edit", stateFile: "sheet.csv", spec }],
      new Map([[calcRecordEditFamily.id, calcRecordEditFamily]]),
    ),
    reader: fileEvidenceReader(root),
    assignment: { taskId: "calc", runId: "r" },
    // corrections deliberately absent: off, the default
  });
  const line = await handleLine(
    gate,
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: GATE_TOOL, arguments: { taskId: "calc", runId: "r" } },
    }),
  );
  const reply = JSON.parse(line as string) as {
    result: { content: { text: string }[]; structuredContent: Record<string, unknown> };
  };
  return { fixture, reply: reply.result };
}

describe("H-16 and H-17 describe what the agent actually receives", () => {
  it("H-16: oracle reasons, including the collateral cell list, reach the agent with corrections off (mock/dev reader)", async () => {
    const { fixture, reply } = await agentReply(collateralOnly(generateFixture(SEED).csv));
    const result = reply.structuredContent as { verdict: string; reasons: string[] };
    expect(result.verdict).toBe("refuted");
    expect(result).not.toHaveProperty("corrections");
    const text = reply.content[0]?.text ?? "";
    expect(text).toMatch(/TARGET_MISMATCH: cell [A-Z]+\d+ \(/);
    expect(text).toMatch(/DOCUMENT_COLLATERAL: 1 cell\(s\)[^"]*: B2/);
    // No document value reaches a reason: not the agent's text, not the fixture's.
    expect(text).not.toContain("changed by the agent");
    expect(result.reasons.join("\n")).not.toContain(fixture.split("\n")[1]?.split(",")[1] ?? "?");
  });

  // The `sealed-fixture` ref kind names the operator's fixture binding, not the reader: it is
  // pushed on both reader paths. These pins use the mock/dev `fileEvidenceReader` (doc, H-17).
  it("H-17: the operator fixture's file name and sha256 reach the agent in evidenceRefs (kind sealed-fixture, mock/dev reader)", async () => {
    const { fixture, reply } = await agentReply(collateralOnly(generateFixture(SEED).csv));
    const refs = (reply.structuredContent as { evidenceRefs: unknown[] }).evidenceRefs;
    expect(refs).toContainEqual({
      kind: "sealed-fixture",
      runId: "r",
      path: "fixture.csv",
      sha256: sha256(fixture),
      bytes: Buffer.byteLength(fixture),
    });
    expect(reply.content[0]?.text).toContain(sha256(fixture));
  });
});
