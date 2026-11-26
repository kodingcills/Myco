/**
 * Pins `docs/security/gate-api-review.md` (track H) to main. The review is the record the
 * H fix PRs cite by finding id and file:line, so a stale ref or a missing finding is a
 * defect (#519 round 1, D1-D4; round 2, D1'). Four layers:
 *
 *  1. Every file:line the doc cites names a line that holds what the doc says is there, and
 *     both ends of every range are pinned. A code move breaks this test, not the doc silently.
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
 * PRs the doc cites that are on `origin/main` (checked at `9f8ce5e`), with their merge
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
] as const;

/**
 * This track's open PRs, each with a file it adds that is not on main. When one merges, its
 * file lands and the tripwire below fails until the doc stops calling it open.
 */
const OPEN = [{ pr: 523, witness: "test/gate/caller-isolation.test.ts" }] as const;

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

/** Doc ref, then what the cited line range must contain. */
const ANCHORS: ReadonlyArray<readonly [string, RegExp]> = [
  // Threat model and authz design
  ["gate.ts:430-433", /export interface Assignment/],
  ["gate.ts:439", /readonly assignment: Assignment/],
  ["gate.ts:448", /readonly onDecision\?/],
  ["api.ts:126-135", /export interface GateRequest/],
  ["api.ts:340-402", /export function parseGateRequest/],
  ["mcp-server.ts:180-206", /export function serveStdio/],
  ["gate.ts:178", /STATE_FILE_LIMIT = 16 \* 1024 \* 1024/],
  ["gate.ts:377", /opened\.size > STATE_FILE_LIMIT/],
  ["api.ts:151-191", /export interface GateResult/],
  ["mcp-server.ts:100-106", /structuredContent: result/],
  ["cli.ts:106-142", /function operatorGate/],
  ["api.ts:356-363", /unknown request field\(s\): \$\{unknown\.join/],
  ["sealed.ts:148-165", /export function createSealedGate/],
  ["gate.ts:712-721", /taskId !== assignment\.taskId \|\| runId !== assignment\.runId/],
  ["gate.ts:676-690", /await config\.onDecision\(result\)/],
  // D4: CLI scope
  ["cli.ts:75-88", /function parseFlags\(argv/],
  ["cli.ts:172-182", /gate\.check\(\{\s*taskId: task,\s*runId: run/],
  ["cli.ts:114-115", /loadTasksFile\(tasksFile\)/],
  // H-01 (fixed by #520, merged)
  ["stdio-frame.ts:26", /export const MAX_FRAME_BYTES = 1024 \* 1024;/],
  ["stdio-frame.ts:32", /OVERSIZED_FRAME_LINE = '\{"id":null\}'/],
  ["myco-gate.ts:21", /boundFrames\(process\.stdin/],
  ["mcp-server.ts:186", /createInterface\(/],
  ["mcp-server.ts:111-174", /export async function handleLine/],
  ["api.ts:387", /record\.claim\.length > CLAIM_LIMIT/],
  // H-02
  ["mcp-server.ts:87", /unknown tool: \$\{params\.name\}/],
  ["mcp-server.ts:171", /method not found: \$\{request\.method\}/],
  // H-03
  ["api.ts:384-393", /claim is longer than/],
  ["cli.ts:134", /appendFileSync\(audit/],
  ["api.ts:133", /never read by the oracle/],
  // H-04
  ["corrections.ts:241-246", /chars\.slice\(0, CORRECTION_VALUE_LIMIT\)/],
  // H-05
  ["gate.ts:878-890", /async check\(raw\)/],
  ["cli.ts:190-194", /serveStdio\(gate, io\.stdin, io\.stdout/],
  ["multistep.ts:71", /retryBudget: 0 \| 1/],
  ["multistep.ts:111-112", /retryBudget must be 0 or 1/],
  ["mcp-server.ts:191", /chain = chain\.then\(/],
  ["sealed.ts:82", /BEFORE_CAPTURE/],
  ["sealed.ts:106-111", /no sealed capture yet/],
  // H-06
  ["sealed.ts:117-133", /bytes\.length > STATE_FILE_LIMIT[\s\S]*cause: "unreadable"/],
  ["sealed.ts:127", /if \(bytes\.length > STATE_FILE_LIMIT\)/],
  ["vault.ts:632", /readFileSync\(path\)/],
  // H-07, H-08
  ["api.ts:314-319", /\^\[A-Za-z0-9\]\[A-Za-z0-9\._-\]\{0,127\}\$/],
  ["sealed.ts:102", /openForTrial\(vault, binding, runId\)/],
  ["gate.ts:615", /const assignment = \{ \.\.\.config\.assignment \}/],
  ["gate.ts:342-352", /const segments = \[runId, \.\.\.stateFile\.split/],
  ["vault.ts:313", /existsSync\(dir\)/],
  // H-09
  ["mcp-server.ts:195-198", /code: -32603/],
  ["input-fuzz.test.ts:348-380", /H-09: a deeply nested JSON-RPC id is -32603[\s\S]*code: -32603/],
  // H-10..H-15
  ["vault.ts:294-296", /join\(this\.root, runId\)/],
  ["vault.ts:98-102", /export interface SealReceipt/],
  ["ledger.ts:41-53", /export function appendChainedRow/],
  ["vault.ts:251-262", /export interface VaultOptions/],
  ["vault.ts:95", /sourceFiles: readonly string\[\]/],
  ["sealed.ts:20-21", /Agent-facing details carry `integrity:<code>` only/],
  ["gate.test.ts:654-750", /function spyReader[\s\S]*invalid gate assignment/],
  ["sealed-gate.test.ts:334-395", /naming an earlier honest trial is ASSIGNMENT_MISMATCH/],
  ["vault.ts:319-322", /oracle source \$\{path\} is not absolute/],
  ["gate.ts:435-464", /export interface GateConfig/],
  // H-16
  ["gate.ts:867", /reasons: \[\.\.\.valid\.reasons\]/],
  ["families.ts:144-145", /TARGET_MISMATCH: cell \$\{ref\}/],
  ["calc-document.ts:162-164", /DOCUMENT_COLLATERAL: \$\{collateral\.length\}/],
  ["families.ts:230", /persisted as \$\{JSON\.stringify\(newValue\)\}/],
  ["gate.ts:741", /could not look: \$\{read\.detail\}/],
  ["gate.ts:283-290", /descriptor path check/],
  ["gate.ts:837", /could not look: \$\{corrupt\.message\}/],
  ["gate.ts:162-166", /must name paths relative to the run/],
  ["gate.ts:283-286", /const shown = actual\.startsWith\(`\$\{realRoot\}\/`\)/],
  ["reasons.ts:22", /export function errorCode\(error: unknown\): string/],
  ["gate.ts:369", /open failed: \$\{errorCode\(error\)\}/],
  ["gate.ts:405", /read failed: \$\{errorCode\(error\)\}/],
  ["gate.ts:626-634", /function diagnose\([\s\S]*errorCode\(error\)/],
  // H-17
  ["gate.ts:780-786", /kind: "sealed-fixture",[\s\S]*path: sealed\.file,[\s\S]*sha256: digest/],
];

/**
 * Both ends of every cited range, as the exact trimmed text of its first and last line. An
 * anchor regex matches anywhere inside its range, so on its own it survives a one-line shift
 * (round-2 verifier mutation V6: one line inserted at the top of `calc-document.ts`). Pinning
 * the ends makes any shift, or a range that grew or shrank, fail here.
 */
const RANGE_ENDS: ReadonlyArray<readonly [string, string, string]> = [
  ["gate.ts:430-433", "export interface Assignment {", "}"],
  ["api.ts:126-135", "export interface GateRequest {", "}"],
  ["api.ts:340-402", "export function parseGateRequest(raw: unknown): ParsedRequest {", "}"],
  ["mcp-server.ts:180-206", "export function serveStdio(", "}"],
  ["api.ts:151-191", "export interface GateResult {", "}"],
  ["mcp-server.ts:100-106", "return {", "},"],
  ["cli.ts:106-142", "function operatorGate(flags: Flags, stderr: Writable) {", "}"],
  ["api.ts:356-363", "const unknown = keys.filter((key) => !ALLOWED_FIELDS.has(key));", "};"],
  ["sealed.ts:148-165", "export function createSealedGate(config: SealedGateConfig): Gate {", "}"],
  ["gate.ts:712-721", "if (taskId !== assignment.taskId || runId !== assignment.runId) {", "}"],
  [
    "gate.ts:676-690",
    "if (!config.onDecision) return result;",
    '`decision log write failed: $\u007bdiagnose("decision-log", error)}`,',
  ],
  ["cli.ts:75-88", "function parseFlags(argv: readonly string[]): Flags | string {", "}"],
  ["cli.ts:172-182", 'case "check": {', "});"],
  [
    "cli.ts:114-115",
    'const tasksFile = str(flags, "--tasks");',
    "if (tasksFile !== undefined) entries.push(...loadTasksFile(tasksFile));",
  ],
  ["mcp-server.ts:111-174", "export async function handleLine(", "}"],
  ["api.ts:384-393", 'if (record.claim !== undefined && typeof record.claim !== "string") {', "};"],
  [
    "corrections.ts:241-246",
    "const truncated = chars.length > CORRECTION_VALUE_LIMIT;",
    "...(truncated ? { observedTruncated: true as const } : {}),",
  ],
  ["gate.ts:878-890", "async check(raw) {", "},"],
  ["cli.ts:190-194", 'case "mcp": {', "}"],
  [
    "multistep.ts:111-112",
    "if (options.retryBudget !== 0 && options.retryBudget !== 1)",
    "throw new Error(`retryBudget must be 0 or 1, got $\u007bString(options.retryBudget)}`);",
  ],
  [
    "sealed.ts:106-111",
    "const early = codes.length > 0 && codes.every((code) => BEFORE_CAPTURE.has(code));",
    '? `no sealed capture yet: the gate decides from the host capture taken after the agent stops ($\u007bcodes.join(", ")})`',
  ],
  ["sealed.ts:117-133", "const { persisted } = opened.inputs;", "return { ok: true, bytes };"],
  ["api.ts:314-319", "const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;", "}"],
  [
    "gate.ts:342-352",
    "export function fileEvidenceReader(root: string, hooks: FileReaderHooks = {}): EvidenceReader {",
    "const first = walk(absoluteRoot, segments, where, hooks.beforeLstat);",
  ],
  ["mcp-server.ts:195-198", "} catch {", "}"],
  [
    "input-fuzz.test.ts:348-380",
    'it("H-09: a deeply nested JSON-RPC id is -32603 from serveStdio, and the next request is served", async () => {',
    "expect(spy.reads).toBe(2);",
  ],
  ["vault.ts:294-296", "private runDir(runId: string): string {", "return join(this.root, runId);"],
  [
    "vault.ts:98-102",
    "/** Held in harness memory from seal to verdict; the agent never sees it. */",
    "}",
  ],
  ["ledger.ts:41-53", "export function appendChainedRow(", "}"],
  ["vault.ts:251-262", "export interface VaultOptions {", "}"],
  [
    "sealed.ts:20-21",
    "* Agent-facing details carry `integrity:<code>` only (#478/#480): a violation's path can be",
    "* an absolute host path. The full violations go to the operator through `onIntegrity`.",
  ],
  [
    "gate.test.ts:654-750",
    'describe("gate: the assignment binds the gate to one trial (round 1 D1)", () => {',
    "});",
  ],
  [
    "sealed-gate.test.ts:334-395",
    "describe(\"the agent's run id never selects another trial's sealed bytes\", () => {",
    "});",
  ],
  [
    "vault.ts:319-322",
    "for (const path of input.oracle.sourceFiles) {",
    "sources[path] = sha256(readFileSync(path));",
  ],
  ["gate.ts:435-464", "export interface GateConfig {", "}"],
  [
    "families.ts:144-145",
    "function targetReason(ref: string, edit: CellEdit): string {",
    "return `TARGET_MISMATCH: cell $\u007bref} ($\u007bwhere(edit)}) does not hold the requested value`;",
  ],
  [
    "calc-document.ts:162-164",
    "export function collateralReason(collateral: readonly string[]): string {",
    "}",
  ],
  [
    "gate.ts:283-290",
    "// Report the path relative to the root: reasons reach the agent, host paths need not.",
    "detail: `$\u007bwhere}: the opened file is at $\u007bshown}, not at $\u007bwhere} (descriptor path check)`,",
  ],
  [
    "gate.ts:162-166",
    '* `detail` of a failed outcome reaches the agent (as "could not look: <detail>"), so it',
    "*/",
  ],
  [
    "gate.ts:283-286",
    "// Report the path relative to the root: reasons reach the agent, host paths need not.",
    ': "a path outside the evidence root";',
  ],
  [
    "gate.ts:626-634",
    'function diagnose(stage: GateDiagnostic["stage"], error: unknown): string {',
    "}",
  ],
  ["gate.ts:780-786", "const digest = sha256(got.bytes);", "bytes: got.bytes.length,"],
];

function lineAt(ref: string, which: "first" | "last"): string {
  const match = /^([\w.-]+\.ts):(\d+)-(\d+)$/.exec(ref);
  if (!match) throw new Error(`not a range ${ref}`);
  const [, name, from, to] = match as unknown as [string, string, string, string];
  const file = FILES[name];
  if (!file) throw new Error(`no file for ${name}`);
  const lines = readFileSync(repo(file), "utf8").split("\n");
  return (lines[Number(which === "first" ? from : to) - 1] ?? "").trim();
}

function cited(ref: string): string {
  const match = /^([\w.-]+\.ts):(\d+)(?:-(\d+))?$/.exec(ref);
  if (!match) throw new Error(`bad ref ${ref}`);
  const [, name, from, to] = match as unknown as [string, string, string, string | undefined];
  const file = FILES[name];
  if (!file) throw new Error(`no file for ${name}`);
  const lines = readFileSync(repo(file), "utf8").split("\n");
  const first = Number(from);
  const last = to === undefined ? first : Number(to);
  expect(last, `${ref}: past the end of ${file}`).toBeLessThanOrEqual(lines.length);
  return lines.slice(first - 1, last).join("\n");
}

describe("the security review's file:line refs hold on main (D1)", () => {
  it.each(ANCHORS)("%s holds %s", (ref, anchor) => {
    expect(DOC, `the doc no longer cites ${ref}`).toContain(ref);
    expect(cited(ref)).toMatch(anchor);
  });

  it.each(RANGE_ENDS)("%s starts and ends where the doc says (V6)", (ref, first, last) => {
    expect(lineAt(ref, "first"), `${ref}: first line moved`).toBe(first);
    expect(lineAt(ref, "last"), `${ref}: last line moved`).toBe(last);
  });

  it("every cited range has both ends pinned", () => {
    const ended = new Set(RANGE_ENDS.map(([ref]) => ref));
    const ranges = ANCHORS.map(([ref]) => ref).filter((ref) => /:\d+-\d+$/.test(ref));
    expect(ranges.filter((ref) => !ended.has(ref))).toEqual([]);
    expect([...ended].filter((ref) => !ranges.includes(ref))).toEqual([]);
  });

  it("every ref the doc makes into these files is pinned above", () => {
    const pinned = new Set(ANCHORS.map(([ref]) => ref));
    const refs = [...DOC.matchAll(/([\w.-]+\.ts):(\d+(?:-\d+)?)/g)]
      .map(([, name, lines]) => `${name}:${lines}`)
      .filter((ref) => (ref.split(":")[0] ?? "") in FILES);
    expect(refs.length).toBeGreaterThan(50);
    expect(refs.filter((ref) => !pinned.has(ref))).toEqual([]);
    // A bare `:NNN` ref would dodge the sweep: every ref names its file.
    expect(DOC).not.toMatch(/`:\d/);
  });

  it("re-anchors the status line past #514, #511, #520, #521, #522 and #512", () => {
    expect(DOC).not.toMatch(
      /\*\*Status:\*\* review of `origin\/main` at `(12c35ea|d632628|08f487f)`/,
    );
    expect(DOC).toMatch(/\*\*Status:\*\* review of `origin\/main` at `9f8ce5e`/);
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

  it.each(OPEN)(
    "#$pr, which the doc treats as open, has not merged: $witness is not on this tree",
    ({ pr, witness }) => {
      // Tripwire: when this PR merges, its new file lands, this fails, and the doc's
      // "fix now"/"test now"/coordination text for it must become "fixed"/"tested (merged)".
      expect(
        existsSync(fileURLToPath(repo(witness))),
        `#${pr} has merged (${witness} exists): update docs/security/gate-api-review.md, then move #${pr} to MERGED here`,
      ).toBe(false);
      expect(FLAT).toContain(`#${pr}`);
    },
  );

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
    expect(h16).toContain("strips the evidence root before it names a path (`gate.ts:283-286`)");
    expect(h16).toContain("`errorCode`, `reasons.ts:22`");
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
      "`ASSIGNMENT_MISMATCH` (`gate.ts:712-721`) also echoes the agent's task and run ids",
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
