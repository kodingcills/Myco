/**
 * Track Q, #562 F1 (lead ruling 22:18Z / 22:27Z): agent-produced key names and app ids, and
 * the tool and policy-subject names, go out verbatim only when they are in a CLOSED
 * VOCABULARY (`src/proof/vocab.ts`); anything else is `h-<60hex>`. Required tests: a known
 * key or registered app passes; unknown, identity-like, path-like and near-miss values are
 * hashed; both vocabularies are mutation-proven (the pinned lists below, and the per-value
 * cases, each fail when a vocabulary is widened to a grammar or dropped).
 */
import { describe, expect, it } from "vitest";
import {
  exportProofBundle,
  type ProofBundle,
  type ProofRunInput,
  serializeProofBundle,
  verifyProofBundle,
} from "../../src/proof/bundle.ts";
import { hashedId } from "../../src/proof/closed.ts";
import {
  closedApp,
  closedKeys,
  closedSubject,
  closedTool,
  KEY_MODIFIERS,
  KEY_NAMES,
  MAX_KEY_CHORDS,
  REGISTERED_APPS,
  TOOL_NAMES,
} from "../../src/proof/vocab.ts";
import { clone, NO_CTX, rechain, sampleRun } from "./fixture.ts";

describe("the vocabularies are pinned (adding a member is a reviewed change)", () => {
  it("REGISTERED_APPS", () => {
    expect([...REGISTERED_APPS]).toEqual([
      "calc",
      "writer",
      "libreoffice-calc",
      "libreoffice-writer",
      "localc",
      "lowriter",
      "soffice",
      "myco-todo",
    ]);
  });
  it("KEY_NAMES, KEY_MODIFIERS, MAX_KEY_CHORDS", () => {
    expect([...KEY_NAMES]).toEqual([
      "Return",
      "Enter",
      "Tab",
      "Escape",
      "BackSpace",
      "Delete",
      "Insert",
      "Home",
      "End",
      "Page_Up",
      "Page_Down",
      "Up",
      "Down",
      "Left",
      "Right",
      "space",
      ...Array.from({ length: 12 }, (_, i) => `F${i + 1}`),
    ]);
    expect([...KEY_MODIFIERS]).toEqual(["ctrl", "shift", "alt", "super", "meta", "cmd"]);
    expect(MAX_KEY_CHORDS).toBe(4);
  });
  it("TOOL_NAMES", () => {
    expect([...TOOL_NAMES]).toEqual([
      "click",
      "type",
      "key",
      "scroll",
      "launch",
      "wait",
      "shell",
      "gate-check",
      "observe",
      "typeTextGlobal",
      "clickAt",
      "keyPress",
      "calc.set-cell",
      "doc.export-csv",
      "shell.run",
      "act",
      "act_script",
      "ping",
      "session_info",
      "uia_tree",
      "uia_invoke",
      "screenshot",
      "read_file",
      "write_file",
      "kill",
      "uno_eval",
      "myco_gate_check",
    ]);
  });
});

// ---------------------------------------------------------------------------------------
// The cases. Each hashed value is identifier-shaped (most match the closed id grammar), so
// only a VOCABULARY keeps it out; a grammar would write it verbatim.

const KNOWN_KEYS = [
  "Return",
  "Tab",
  "Escape",
  "F5",
  "space",
  "ctrl+s",
  "ctrl+w",
  "shift+Tab",
  "ctrl+shift+F5",
  "cmd+q",
  "ctrl+a ctrl+c",
  "Tab Tab Tab Return",
];
const HASHED_KEYS: ReadonlyArray<readonly [string, string]> = [
  ["unknown key name", "Hyper_L"],
  ["unknown key name 2", "XF86Launch1"],
  ["near miss: misspelled", "Retrun"],
  ["near miss: case", "return"],
  ["near miss: modifier case", "CTRL+s"],
  ["near miss: upper-case letter", "ctrl+S"],
  ["near miss: trailing space", "Return "],
  ["near miss: double space", "Tab  Return"],
  ["near miss: dangling plus", "ctrl+"],
  ["near miss: leading plus", "+s"],
  ["near miss: newline", "ctrl+s\n"],
  ["too many chords", "Tab Tab Tab Tab Return"],
  ["identity-like: a bare username", "jsmith"],
  ["identity-like: spelled letter by letter", "j s m i t h"],
  ["identity-like: a modifier and a word", "ctrl+jsmith"],
  ["identity-like: a bare letter", "s"],
  ["path-like", "/home/jsmith"],
  ["path-like: dotted", "Users.jsmith.Documents"],
];

const HASHED_APPS: ReadonlyArray<readonly [string, string]> = [
  ["unknown app id", "com.apple.Safari"],
  ["unknown app id 2", "org.mozilla.firefox"],
  ["near miss: case", "Calc"],
  ["near miss: separator", "libreoffice_calc"],
  ["near miss: suffix", "writerx"],
  ["near miss: trailing space", "calc "],
  ["a command line, not an app id", "soffice calc"],
  ["a command line 2", "localc a.csv"],
  ["identity-like: a bare username", "jsmith"],
  ["identity-like: a user's app", "jsmith-todo"],
  ["path-like", "/Applications/Safari.app"],
  ["path-like: dotted", "Users.jsmith.Documents"],
];

const HASHED_TOOLS: ReadonlyArray<readonly [string, string]> = [
  ["unknown tool", "Bash"],
  ["an app id as a tool", "com.apple.Safari"],
  ["near miss: case", "typetextglobal"],
  ["near miss: case 2", "KeyPress"],
  ["near miss: suffix", "act_scripts"],
  ["near miss: separator", "gate_check"],
  ["identity-like: a bare username", "jsmith"],
  ["path-like: dotted", "Users.jsmith.Documents"],
  ["path-like", "/usr/bin/xdotool"],
];

const action = (over: Record<string, string>): ProofRunInput => ({
  ...sampleRun(),
  ledger: undefined,
  steps: [{ kind: "action", actor: "agent", tool: "keyPress", summary: "s", ...over }],
});
const policy = (subject: string): ProofRunInput => ({
  ...sampleRun(),
  ledger: undefined,
  steps: [
    { kind: "policy", policyId: "pol-1", subject, decision: "deny", reasonCode: "POLICY_DENIED" },
  ],
});
const body = (b: ProofBundle) => b.records[0]?.body as unknown as Record<string, unknown>;
const noRaw = (b: ProofBundle, raw: string) =>
  raw.trim().length < 4 || !serializeProofBundle(b).toLowerCase().includes(raw.toLowerCase());

describe("F1: key names", () => {
  it("a known key sequence is written as is (and verifies)", () => {
    for (const keys of KNOWN_KEYS) {
      expect(closedKeys(keys), keys).toBe(keys);
      const b = exportProofBundle(action({ keys }), NO_CTX);
      expect(body(b).keys, keys).toBe(keys);
      expect(verifyProofBundle(serializeProofBundle(b)).ok, keys).toBe(true);
    }
  });
  it("unknown, identity-like, path-like and near-miss key sequences are hashed", () => {
    for (const [label, keys] of HASHED_KEYS) {
      expect(closedKeys(keys), label).toBe(hashedId(keys));
      const b = exportProofBundle(action({ keys }), NO_CTX);
      expect(body(b).keys, label).toBe(hashedId(keys));
      expect(noRaw(b, keys), label).toBe(true);
    }
  });
  it("a vocabulary-shaped sequence that carries a configured identity string is hashed", () => {
    const keys = "ctrl+s Return";
    const b = exportProofBundle(action({ keys }), NO_CTX, { names: ["ctrlsreturn"], homes: [] });
    expect(body(b).keys).toBe(hashedId(keys));
  });
});

describe("F1: app ids", () => {
  it("a registered app id is written as is (and verifies)", () => {
    for (const app of REGISTERED_APPS) {
      expect(closedApp(app), app).toBe(app);
      const b = exportProofBundle(action({ tool: "launch", app }), NO_CTX);
      expect(body(b).app, app).toBe(app);
      expect(verifyProofBundle(serializeProofBundle(b)).ok, app).toBe(true);
    }
  });
  it("unknown, identity-like, path-like and near-miss app ids are hashed", () => {
    for (const [label, app] of HASHED_APPS) {
      expect(closedApp(app), label).toBe(hashedId(app));
      const b = exportProofBundle(action({ tool: "launch", app }), NO_CTX);
      expect(body(b).app, label).toBe(hashedId(app));
      expect(noRaw(b, app), label).toBe(true);
    }
  });
});

describe("F1: tool names and policy subjects", () => {
  it("a known tool is written as is; others are hashed", () => {
    for (const tool of TOOL_NAMES) {
      expect(closedTool(tool), tool).toBe(tool);
      expect(body(exportProofBundle(action({ tool }), NO_CTX)).tool, tool).toBe(tool);
    }
    for (const [label, tool] of HASHED_TOOLS) {
      expect(closedTool(tool), label).toBe(hashedId(tool));
      const b = exportProofBundle(action({ tool }), NO_CTX);
      expect(body(b).tool, label).toBe(hashedId(tool));
      expect(noRaw(b, tool), label).toBe(true);
    }
  });
  it("a policy subject is written as is only when it is a known tool or a registered app", () => {
    for (const subject of [...TOOL_NAMES, ...REGISTERED_APPS]) {
      expect(closedSubject(subject), subject).toBe(subject);
      expect(body(exportProofBundle(policy(subject), NO_CTX)).subject, subject).toBe(subject);
    }
    for (const [label, subject] of [...HASHED_TOOLS, ...HASHED_APPS]) {
      if (TOOL_NAMES.includes(subject as never)) continue;
      const b = exportProofBundle(policy(subject), NO_CTX);
      expect(body(b).subject, label).toBe(hashedId(subject));
      expect(noRaw(b, subject), label).toBe(true);
    }
  });
});

describe("F1: verify refuses a forged bundle that writes a non-member verbatim", () => {
  const forge = (edit: (b: Record<string, unknown>) => void) => {
    const b = clone(exportProofBundle(sampleRun(), NO_CTX));
    edit(b.records[1]?.body as unknown as Record<string, unknown>);
    return verifyProofBundle(serializeProofBundle(rechain(b)));
  };
  it("tool, keys and app outside the vocabularies: PROOF_SCHEMA; members: accepted", () => {
    for (const [field, raw] of [
      ["tool", "jsmith"],
      ["tool", "com.apple.Safari"],
      ["keys", "j s m i t h"],
      ["keys", "Retrun"],
      ["app", "com.apple.Safari"],
      ["app", "Calc"],
    ] as const) {
      const r = forge((b) => {
        b[field] = raw;
      });
      expect(
        r.errors.map((e) => e.code),
        `${field}=${raw}`,
      ).toContain("PROOF_SCHEMA");
      expect(JSON.stringify(r).includes(raw), `${field}=${raw}: echo`).toBe(false);
    }
    for (const [field, raw] of [
      ["tool", "launch"],
      ["keys", "ctrl+s"],
      ["app", "calc"],
      ["app", hashedId("com.apple.Safari")],
    ] as const) {
      const r = forge((b) => {
        b[field] = raw;
      });
      expect(r.ok, `${field}=${raw}`).toBe(true);
    }
  });
  it("policy subject outside the vocabularies: PROOF_SCHEMA", () => {
    const b = clone(exportProofBundle(sampleRun(), NO_CTX));
    (b.records[0]?.body as unknown as Record<string, unknown>).subject = "jsmith";
    const r = verifyProofBundle(serializeProofBundle(rechain(b)));
    expect(r.errors.map((e) => e.code)).toContain("PROOF_SCHEMA");
  });
});
