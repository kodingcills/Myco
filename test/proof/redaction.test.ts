/**
 * Track Q (replayable proof): planted-marker redaction tests. Every marker is built at run
 * time from parts, so no tracked file carries a key-shaped string or a real home path.
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  exportProofBundle,
  type ProofBundle,
  serializeProofBundle,
  verifyProofBundle,
} from "../../src/proof/bundle.ts";
import { emit, main } from "../../src/proof/cli.ts";
import {
  findLeaks,
  findLeaksDeep,
  PLACEHOLDER,
  type RedactionContext,
  redactText,
} from "../../src/proof/redact.ts";
import { ProofReportError, renderProofReport } from "../../src/proof/report.ts";
import { clone, NO_CTX, rechain, sampleRun } from "./fixture.ts";

const j = (...parts: string[]) => parts.join("");
// Planted markers (fake, low-entropy, assembled at run time).
const SECRET_VALUE = j("PLANTED", "-SECRET-", "VALUE-0001");
const ANT_KEY = j("sk-", "ant-", "PLANTEDPLANTED0002");
const BEARER = j("Bearer ", "PLANTEDBEARERTOKEN0003");
const VAULT_KEY = j("vault", "-mac-key-", "PLANTED0004");
const USER = j("plantuser", "05");
const MAC_HOME = j("/", "Users", "/", USER, "/");
const LINUX_HOME = j("/", "home", "/", USER);
const WIN_HOME = j("C:", "\\", "Users", "\\", USER, "\\Desktop\\a.csv");
const PRIVATE_KEY = j(
  "-----BEGIN ",
  "OPENSSH PRIVATE KEY-----\nAAAA\n-----END ",
  "OPENSSH PRIVATE KEY-----",
);

const CTX: RedactionContext = {
  secrets: [SECRET_VALUE],
  vaultKeys: [VAULT_KEY],
  hostPaths: [LINUX_HOME],
  usernames: [USER],
};

const MARKERS = [
  SECRET_VALUE,
  ANT_KEY,
  "PLANTEDBEARERTOKEN0003",
  VAULT_KEY,
  USER,
  "BEGIN OPENSSH",
  "Users\\",
  "/Users/",
  "/home/",
];

function plantedRun() {
  const run = sampleRun();
  return {
    ...run,
    steps: [
      ...run.steps.slice(0, 1),
      {
        kind: "action" as const,
        actor: "agent" as const,
        tool: "typeTextGlobal",
        summary: `typed ${SECRET_VALUE} and ${ANT_KEY}`,
      },
      {
        kind: "action" as const,
        actor: "harness" as const,
        tool: "shell",
        summary: `opened ${MAC_HOME}Documents/report.csv as ${USER}`,
      },
      {
        kind: "action" as const,
        actor: "harness" as const,
        tool: "shell",
        summary: `copied ${WIN_HOME} with ${BEARER}`,
      },
      {
        kind: "action" as const,
        actor: "harness" as const,
        tool: "shell",
        summary: `cd ${LINUX_HOME}/work && cat file:///etc/hosts`,
      },
      {
        kind: "handoff" as const,
        from: "agent-a",
        to: "agent-b",
        summary: `vault key ${VAULT_KEY}; key ${PRIVATE_KEY}`,
      },
      // Encoded markers (vault key behind percent-encoding, a path behind JSON escapes).
      {
        kind: "action" as const,
        actor: "harness" as const,
        tool: "shell",
        summary: `key ${VAULT_KEY.replace(/-/g, "%2D")} at ${MAC_HOME.replace(/\//g, "\\/")}x`,
      },
      // Evidence (fixture file) holding encoded markers: digest-only, never inlined.
      {
        kind: "evidence" as const,
        evidenceId: "ev-encoded",
        evidenceKind: "log",
        mediaType: "text/plain",
        path: "run-1/encoded.txt",
        content: `${LINUX_HOME.replace(/\//g, "%2F")}%2Fx ~${USER}/y`,
      },
      // Evidence whose text holds a secret and a path: digest-only, never inlined.
      {
        kind: "evidence" as const,
        evidenceId: "ev-dirty",
        evidenceKind: "log",
        mediaType: "text/plain",
        path: "run-1/log.txt",
        content: `token=${SECRET_VALUE} at ${LINUX_HOME}/x`,
      },
      ...run.steps.slice(1),
    ],
  };
}

describe("redaction: no secret, host path, username or vault key reaches a bundle", () => {
  it("planted markers are removed from the bundle and the report", () => {
    const b = exportProofBundle(plantedRun(), CTX);
    const text = serializeProofBundle(b);
    for (const m of MARKERS) expect(text, m).not.toContain(m);
    expect(text).toContain(PLACEHOLDER.secret);
    expect(text).toContain(PLACEHOLDER.vaultKey);
    expect(text).toContain(PLACEHOLDER.hostPath);
    expect(text).toContain(PLACEHOLDER.username);
    const result = verifyProofBundle(text, { redaction: CTX });
    expect(result.ok).toBe(true);
    const html = renderProofReport(b, result);
    for (const m of MARKERS) expect(html, m).not.toContain(m);
  });

  it("evidence text that would need redaction is digest-only (the digest stays the original's)", () => {
    const b = exportProofBundle(plantedRun(), CTX);
    for (const id of ["ev-dirty", "ev-encoded"]) {
      const dirty = b.records.find((r) => (r.body as { evidenceId?: string }).evidenceId === id);
      expect(dirty?.body, id).toMatchObject({ withheld: "redaction" });
      expect(dirty?.body, id).not.toHaveProperty("content");
    }
  });

  it("generic shapes are caught with no context at all", () => {
    for (const s of [
      ANT_KEY,
      BEARER,
      `${MAC_HOME}x`,
      WIN_HOME,
      PRIVATE_KEY,
      `${LINUX_HOME}/x`,
      j("ghp_", "PLANTED0000000000"),
    ]) {
      expect(findLeaks(s), s).not.toEqual([]);
      expect(findLeaks(redactText(s, NO_CTX)), s).toEqual([]);
    }
  });

  it("ordinary text is left alone: relative paths, media types, URLs, gate codes", () => {
    const ok =
      "run-1/.myco-todo.json text/csv https://example.org/a/b myco.gate/v1 ORACLE_FAIL ~/notes";
    expect(redactText(ok, CTX)).toBe(ok);
    expect(findLeaks(ok, CTX)).toEqual([]);
  });

  it("a username is removed as a whole word only", () => {
    expect(redactText(`${USER} ran; ${USER}x stays`, CTX)).toBe(
      `${PLACEHOLDER.username} ran; ${USER}x stays`,
    );
  });

  it("the leak report never contains the leaked value", () => {
    const leaks = findLeaks(`x ${SECRET_VALUE} y`, CTX);
    expect(JSON.stringify(leaks)).not.toContain(SECRET_VALUE);
  });

  it("the verifier refuses a hand-edited bundle that carries a planted leak (fail closed)", () => {
    const b = clone(exportProofBundle(sampleRun(), NO_CTX));
    (b.records[1]?.body as { summary: string }).summary = `see ${MAC_HOME}secret.txt`;
    const forged = rechain(b);
    const r = verifyProofBundle(serializeProofBundle(forged));
    expect(r.ok).toBe(false);
    expect(r.errors.map((e) => e.code)).toEqual(["PROOF_REDACTION"]);
    expect(JSON.stringify(r)).not.toContain(USER);
  });

  it("schema refusals name the path and keyword, never the offending value or key", () => {
    const b = clone(exportProofBundle(sampleRun(), NO_CTX)) as unknown as Record<string, unknown>;
    b[SECRET_VALUE] = SECRET_VALUE;
    (b.run as Record<string, unknown>).arm = SECRET_VALUE.replace(/-/g, " ");
    const r = verifyProofBundle(JSON.stringify(b));
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r.errors)).not.toContain("PLANTED");
  });

  it("a path hidden after an escaped newline in a JSON string is still found", () => {
    const b = clone(exportProofBundle(sampleRun(), NO_CTX));
    (b.records[1]?.body as { summary: string }).summary = `line one\n${LINUX_HOME}/notes.txt`;
    const r = verifyProofBundle(serializeProofBundle(rechain(b)));
    expect(r.errors.map((e) => e.code)).toEqual(["PROOF_REDACTION"]);
  });

  it("the verifier refuses a forbidden literal it was given (vault key names)", () => {
    const b = clone(exportProofBundle(sampleRun(), NO_CTX));
    (b.records[1]?.body as { summary: string }).summary = `uses ${VAULT_KEY}`;
    const r = verifyProofBundle(serializeProofBundle(rechain(b)), { redaction: CTX });
    expect(r.errors.map((e) => e.code)).toEqual(["PROOF_REDACTION"]);
  });

  it("the exporter refuses when a leak would survive (it never writes a leaking bundle)", () => {
    // A value only the verifier's scan knows (shape) but that redaction cannot rewrite
    // inside an id field: ids are schema-checked, so a key-shaped run id fails closed.
    expect(() =>
      exportProofBundle({ ...sampleRun(), runId: j("sk_", "PLANTEDPLANTED") }, NO_CTX),
    ).toThrow(/PROOF_REDACTION/);
  });
});

// ---------------------------------------------------------------------------------------
// Bypasses of a hand-rolled scanner (verifier round 1, D1, and the shared root cause): one
// case per bypass. Each must be (a) found by findLeaks with NO context, (b) removed by
// redactText, (c) refused by the verifier in a hand-edited, re-chained bundle, and (d)
// absent from an exported bundle.
const BYPASSES: ReadonlyArray<readonly [string, string]> = [
  ["P3: a tab before the path (JSON \\t in the file)", `see\t${MAC_HOME}secret.txt`],
  ["JSON-escaped slashes inside a value", `see ${MAC_HOME.replace(/\//g, "\\/")}secret.txt`],
  ["JSON \\u002f escapes inside a value", `see ${MAC_HOME.replace(/\//g, "\\u002f")}x`],
  ["percent-encoded path", `see ${MAC_HOME.replace(/\//g, "%2F")}x`],
  ["percent-encoded file: URL", `see file%3A%2F%2F%2Fetc%2Fhosts`],
  ["HTML-entity path", `see ${MAC_HOME.replace(/\//g, "&#47;")}x`],
  ["leading-character bypass: *", `*${LINUX_HOME}/x`],
  ["leading-character bypass: !", `!${LINUX_HOME}/x`],
  ["leading-character bypass: em dash", `\u2014${LINUX_HOME}/x`],
  ["leading-character bypass on a drive path", `x${WIN_HOME}`],
  ["leading-character bypass on a one-segment drive path", j("x", "D:", "\\", "PLANTEDdir")],
  ["drive path with forward slashes", `see ${WIN_HOME.replace(/\\/g, "/")}`],
  ["UNC path", j("see ", "\\\\", "fileserver", "\\", "share", "\\", USER, "\\x")],
  ["rootless backslash home", j("see ", "\\", "Users", "\\", USER, "\\x")],
  ["home-relative ~user path", `see ~${USER}/notes.txt`],
  ["leading-character bypass on a key shape", `id_${ANT_KEY}`],
  ["leading-character bypass on a key shape (digit)", j("1", "ghp_", "PLANTED0000000000")],
  ["key=value without a boundary", j("my", "secret=", "PLANTEDVALUE9")],
  // Verifier round 2, R2-D1: a home root after a character the POSIX lookbehind skips.
  // Probe A (exported through the library with no registered literals).
  ["R2-D1 A: home after '...'", j("Saving...", "/home/", USER, "/notes.txt")],
  ["R2-D1 A: Users after '../../'", j("cd ../../", "Users/", USER, "/Desktop")],
  ["R2-D1 A: Users after a digit and '/'", j("v2/", "Users/", USER, "/x")],
  ["R2-D1 A: home after '-'", j("build-", "/home/", USER, "/work/x")],
  ["R2-D1 A: drive-relative Users", j("dir=C:", "Users\\", USER, "\\x")],
  // Probe B (hand-edited, re-chained bundles).
  ["R2-D1 B: Users after '.../'", j("see.../", "Users/", USER, "/secret.txt")],
  ["R2-D1 B: Users after '-'", j("a-/", "Users/", USER, "/secret.txt")],
  ["R2-D1 B: home after a digit", j("2/", "home/", USER, "/x")],
  ["R2-D1 B: mixed separators", j("/", "Users\\", USER, "\\x")],
  ["R2-D1 B: drive-relative, bare", j("C:", "Users\\", USER, "\\x")],
  // The same shapes under other home roots and encodings.
  ["R2-D1: root home after a letter-adjacent '.'", j("x./", "root/", USER, "/x")],
  ["R2-D1: upper-case Windows home", j("v1/", "USERS\\", USER)],
  ["R2-D1: macOS per-user temp after '.'", j("x.", "/private/var/folders/", USER, "/T/a")],
  ["R2-D1: percent-encoded, after '...'", j("...", "%2Fhome%2F", USER, "%2Fx")],
];

describe("scanner bypasses: every encoded or prefixed host path or key is caught", () => {
  for (const [name, value] of BYPASSES) {
    it(name, () => {
      expect(findLeaks(value), "findLeaks").not.toEqual([]);
      const redacted = redactText(value, NO_CTX);
      expect(findLeaks(redacted), "redactText").toEqual([]);
      expect(redacted).not.toContain(USER);
      // Verifier: a hand-edited bundle carrying the value, re-chained.
      const b = clone(exportProofBundle(sampleRun(), NO_CTX));
      (b.records[1]?.body as { summary: string }).summary = value;
      const r = verifyProofBundle(serializeProofBundle(rechain(b)));
      expect(
        r.errors.map((e) => e.code),
        "verifier",
      ).toEqual(["PROOF_REDACTION"]);
      // Exporter: the value never reaches a bundle.
      const run = sampleRun();
      const steps = [
        { kind: "action" as const, actor: "harness" as const, tool: "shell", summary: value },
        ...run.steps,
      ];
      const text = serializeProofBundle(exportProofBundle({ ...run, steps }, NO_CTX));
      expect(text).not.toContain(USER);
      expect(text).not.toContain("PLANTED");
    });
  }

  it("P4: a path written with JSON \\/ escapes in the bundle FILE is refused", () => {
    const b = clone(exportProofBundle(sampleRun(), NO_CTX));
    (b.records[1]?.body as { summary: string }).summary = `see\t${MAC_HOME}secret.txt`;
    const text = serializeProofBundle(rechain(b)).replace(MAC_HOME, MAC_HOME.replace(/\//g, "\\/"));
    expect(text).not.toContain(MAC_HOME);
    expect(verifyProofBundle(text).errors.map((e) => e.code)).toEqual(["PROOF_REDACTION"]);
  });

  it("an object KEY carrying a path is refused (keys are scanned too)", () => {
    expect(findLeaksDeep({ [`${LINUX_HOME}/x`]: 1 })).not.toEqual([]);
    const b = clone(exportProofBundle(sampleRun(), NO_CTX)) as unknown as Record<string, unknown>;
    b[`${LINUX_HOME}/x`] = 1;
    expect(verifyProofBundle(JSON.stringify(b)).errors.map((e) => e.code)).toContain(
      "PROOF_REDACTION",
    );
  });

  it("text that is not JSON is still scanned", () => {
    const codes = verifyProofBundle(`{ ${LINUX_HOME}/x`).errors.map((e) => e.code);
    expect(codes).toEqual(["PROOF_REDACTION", "PROOF_SCHEMA"]);
  });

  it("R2-D1: a guest's home (not the exporting host's) after '-' never reaches an export", () => {
    const guest = j("run", "ner", "PLANTED");
    const run = sampleRun();
    const value = j("build-", "/home/", guest, "/work/x");
    const steps = [
      { kind: "action" as const, actor: "harness" as const, tool: "shell", summary: value },
      ...run.steps,
    ];
    const text = serializeProofBundle(exportProofBundle({ ...run, steps }, NO_CTX));
    expect(text).not.toContain(guest);
    expect(verifyProofBundle(text).ok).toBe(true);
  });

  it("ordinary text stays clean in every decoded form (no false refusal)", () => {
    for (const ok of [
      "a%20b 50% done &amp; ok &lt;tag&gt;",
      "line\\nnext \\t tab",
      "https://example.org/a/b?x=%2Fy",
      "ratio 3:4, C: drive, path a/b/c, ~/notes, task_list_items, risk-assessment",
      "home page, root cause, users list, the users/ folder, myhome/x, rooted/x",
    ])
      expect(findLeaks(ok), ok).toEqual([]);
  });
});

describe("every registered literal kind is scanned (not only the vault key)", () => {
  const plant = (summary: string, ctx: RedactionContext) => {
    const b = clone(exportProofBundle(sampleRun(), NO_CTX));
    (b.records[1]?.body as { summary: string }).summary = summary;
    return verifyProofBundle(serializeProofBundle(rechain(b)), { redaction: ctx }).errors.map(
      (e) => e.code,
    );
  };
  const only = (k: Partial<RedactionContext>): RedactionContext => ({ ...NO_CTX, ...k });

  it("a registered secret value with no generic shape", () => {
    expect(findLeaks(SECRET_VALUE)).toEqual([]);
    expect(plant(`x ${SECRET_VALUE}`, only({ secrets: [SECRET_VALUE] }))).toEqual([
      "PROOF_REDACTION",
    ]);
    expect(plant(`x ${SECRET_VALUE}`, NO_CTX)).toEqual([]);
  });

  it("a registered host path with no generic shape", () => {
    const dir = j("/", "srvplanted");
    expect(findLeaks(`cd ${dir}`)).toEqual([]);
    expect(plant(`cd ${dir}`, only({ hostPaths: [dir] }))).toEqual(["PROOF_REDACTION"]);
  });

  it("a registered username, alone", () => {
    expect(plant(`ran as ${USER}`, only({ usernames: [USER] }))).toEqual(["PROOF_REDACTION"]);
  });

  it("a registered vault key behind percent-encoding", () => {
    const enc = VAULT_KEY.replace(/-/g, "%2D");
    expect(plant(`key ${enc}`, only({ vaultKeys: [VAULT_KEY] }))).toEqual(["PROOF_REDACTION"]);
  });
});

describe("the report is an output in its own right: its HTML is scanned", () => {
  // A verification result the verifier would never produce for this bundle: the report's
  // own scan is the last line, independent of the verifier.
  const forgedOk = {
    ok: true,
    errors: [],
    evidenceRecomputed: [],
    evidenceDigestOnly: [],
  } as const;
  const withSummary = (summary: string): ProofBundle => {
    const b = clone(exportProofBundle(sampleRun(), NO_CTX));
    (b.records[1]?.body as { summary: string }).summary = summary;
    return rechain(b);
  };

  it("a path in the rendered HTML stops the report (P3)", () => {
    expect(() => renderProofReport(withSummary(`see\t${MAC_HOME}x`), forgedOk)).toThrow(
      ProofReportError,
    );
  });

  it("a path that the HTML escaping turns into entities is still found", () => {
    const value = `see ${MAC_HOME.replace(/\//g, "&#47;")}x`;
    expect(() => renderProofReport(withSummary(value), forgedOk)).toThrow(/unredacted/);
  });

  it("R2-D1: a home root after a skipped leading character stops the report", () => {
    for (const value of [
      j("see.../", "Users/", USER, "/secret.txt"),
      j("a-/", "Users/", USER, "/secret.txt"),
      j("2/", "home/", USER, "/x"),
      j("/", "Users\\", USER, "\\x"),
      j("C:", "Users\\", USER, "\\x"),
    ])
      expect(() => renderProofReport(withSummary(value), forgedOk), value).toThrow(
        ProofReportError,
      );
  });

  it("a registered literal passed to the renderer stops the report", () => {
    const b = withSummary(`x ${SECRET_VALUE}`);
    expect(() => renderProofReport(b, forgedOk)).not.toThrow();
    expect(() => renderProofReport(b, forgedOk, { ...NO_CTX, secrets: [SECRET_VALUE] })).toThrow(
      ProofReportError,
    );
  });
});

describe("the CLI scans what it prints", () => {
  it("a result that would leak prints only codes", () => {
    const lines: string[] = [];
    const io = { out: (t: string) => lines.push(t), err: (t: string) => lines.push(t) };
    emit(io, { ok: false, code: "PROOF_X", message: `at ${LINUX_HOME}/x` }, NO_CTX);
    expect(lines.join("")).not.toContain(USER);
    expect(JSON.parse(lines.join(""))).toEqual({
      ok: false,
      codes: ["PROOF_X", "PROOF_OUTPUT_REDACTED"],
    });
    lines.length = 0;
    emit(io, { ok: true, head: "abc" }, NO_CTX);
    expect(JSON.parse(lines.join(""))).toEqual({ ok: true, head: "abc" });
  });
});

describe("redactText's last resort", () => {
  it("a decoded leak spanning tokens replaces the whole string", () => {
    const spaced = j("PLANTED ", "SPACED ", "VALUE");
    const ctx = { ...NO_CTX, secrets: [spaced] };
    const input = `x ${spaced.replace(" ", "&#32;")} y`;
    expect(findLeaks(input, ctx)).not.toEqual([]);
    expect(redactText(input, ctx)).toBe(PLACEHOLDER.secret);
  });
});

// ---------------------------------------------------------------------------------------
// Verifier round 3, R3-D1: a Windows home whose user folder contains a space, or that goes
// through `Documents and Settings` (or its 8.3 name), or a UNC share named after a user.
// Each case's user words are planted markers; NONE of them may survive in any output.
const FIRST = j("Plant", "first");
const LAST = j("Zq", "PLANTEDlast");
const GUEST = j("zq", "PLANTEDguest");
const SPACED: ReadonlyArray<readonly [string, string, readonly string[]]> = [
  [
    "R3-D1 probe: the verifier's own string",
    j(
      "saved C:\\",
      "Users\\",
      FIRST,
      " ",
      LAST,
      "\\Desktop\\out.csv; old C:\\Documents and Settings\\",
      GUEST,
      "\\x",
    ),
    [FIRST, LAST, GUEST],
  ],
  ["space in a Windows user folder", j("C:\\", "Users\\", FIRST, " ", LAST, "\\x"), [FIRST, LAST]],
  [
    "space in a Windows user folder, forward slashes",
    j("C:/", "Users/", FIRST, " ", LAST, "/x"),
    [FIRST, LAST],
  ],
  [
    "space in a user folder at the end of the string",
    j("open C:\\", "Users\\", FIRST, " ", LAST),
    [FIRST, LAST],
  ],
  ["two spaces in a user folder", j("C:\\", "Users\\", FIRST, " de ", LAST, "\\x"), [FIRST, LAST]],
  [
    "apostrophe and space in a user folder",
    j("C:\\", "Users\\", FIRST, " O'", LAST, "\\x"),
    [FIRST, LAST],
  ],
  ["Documents and Settings", j("C:\\Documents and Settings\\", GUEST, "\\x"), [GUEST]],
  [
    "Documents and Settings with a spaced user",
    j("C:\\Documents and Settings\\", FIRST, " ", LAST, "\\Local Settings\\x"),
    [FIRST, LAST],
  ],
  ["Documents and Settings, lower case", j("c:/documents and settings/", GUEST, "/x"), [GUEST]],
  ["8.3 short name of Documents and Settings", j("C:\\DOCUME~1\\", GUEST, "\\x"), [GUEST]],
  [
    "8.3 short name of Documents and Settings with a spaced user",
    j("C:\\DOCUME~1\\", FIRST, " ", LAST, "\\x"),
    [FIRST, LAST],
  ],
  ["8.3 short user folder", j("C:\\", "Users\\", "ZQPLAN~1", "\\x"), ["ZQPLAN~1"]],
  [
    "UNC share named after a spaced user",
    j("\\\\", "nas\\", FIRST, " ", LAST, "\\docs"),
    [FIRST, LAST],
  ],
  [
    "UNC homes share with a spaced user folder",
    j("see \\\\", "nas\\homes\\", FIRST, " ", LAST, "\\x"),
    [FIRST, LAST],
  ],
  [
    "UNC admin share into a spaced profile",
    j("\\\\", "pc\\c$\\", "Users\\", FIRST, " ", LAST, "\\x"),
    [FIRST, LAST],
  ],
  [
    "JSON \\u005c escapes around a spaced user (token-by-token rewrite would leak)",
    j("C:\\u005c", "Users\\u005c", FIRST, " ", LAST, "\\u005cx"),
    [FIRST, LAST],
  ],
  [
    "percent-encoded backslashes around a spaced user",
    j("C:%5C", "Users%5C", FIRST, " ", LAST, "%5Cx"),
    [FIRST, LAST],
  ],
  [
    "percent-encoded Documents and Settings",
    j("C:%5CDocuments%20and%20Settings%5C", GUEST, "%5Cx"),
    [GUEST],
  ],
  [
    "HTML-entity backslashes around a spaced user",
    j("C:&#92;", "Users&#92;", FIRST, " ", LAST, "&#92;x"),
    [FIRST, LAST],
  ],
];

const absentFrom = (text: string, words: readonly string[]) => {
  for (const w of words) expect(text, `contains ${w.length}-char user word`).not.toContain(w);
  expect(text).not.toContain("PLANTED");
};

describe("R3-D1: Windows homes with spaces, Documents and Settings, 8.3 and UNC", () => {
  for (const [name, value, words] of SPACED) {
    it(name, () => {
      expect(findLeaks(value), "findLeaks").not.toEqual([]);
      const redacted = redactText(value, NO_CTX);
      expect(findLeaks(redacted), "redactText").toEqual([]);
      absentFrom(redacted, words);
      // Verifier: a hand-edited, re-chained bundle carrying the value is refused.
      const b = clone(exportProofBundle(sampleRun(), NO_CTX));
      (b.records[1]?.body as { summary: string }).summary = value;
      expect(
        verifyProofBundle(serializeProofBundle(rechain(b))).errors.map((e) => e.code),
        "verifier",
      ).toEqual(["PROOF_REDACTION"]);
      // Exporter: no user word reaches the bundle.
      const run = sampleRun();
      const steps = [
        { kind: "action" as const, actor: "harness" as const, tool: "shell", summary: value },
        ...run.steps,
      ];
      const text = serializeProofBundle(exportProofBundle({ ...run, steps }, NO_CTX));
      absentFrom(text, words);
      expect(verifyProofBundle(text).ok).toBe(true);
    });
  }

  it("ordinary prose next to the roots is not a path", () => {
    for (const ok of [
      "the home/ directory",
      "users / admins",
      "Documents and Settings were removed",
    ])
      expect(findLeaks(ok), ok).toEqual([]);
  });
});

/** Run the real CLI in a fresh directory. */
function cliRun(args: string[]): { code: number; out: string } {
  let out = "";
  const code = main(args, { out: (t) => (out += t), err: (t) => (out += t) });
  return { code, out };
}

function writeRun(dir: string, summary: string): string {
  const run = sampleRun();
  const steps = [
    { kind: "action", actor: "harness", tool: "shell", summary },
    ...run.steps.filter((s) => !(s.kind === "evidence" && s.evidenceId === "ev-frame")),
  ];
  const path = join(dir, "RUN.json");
  writeFileSync(path, JSON.stringify({ ...run, steps }));
  return path;
}

describe("CLI export -> verify -> report: no user word in any output", () => {
  it("R3-D1: the verifier's probe through the real CLI", () => {
    const dir = mkdtempSync(join(tmpdir(), "proof-r3d1-"));
    const value = (SPACED[0] as readonly [string, string, readonly string[]])[1];
    const words = [FIRST, LAST, GUEST];
    const bundle = join(dir, "b.json");
    const exp = cliRun(["export", writeRun(dir, value), "--out", bundle]);
    expect(exp.code).toBe(0);
    absentFrom(exp.out, words);
    absentFrom(readFileSync(bundle, "utf8"), words);
    const ver = cliRun(["verify", bundle]);
    expect(ver.code).toBe(0);
    absentFrom(ver.out, words);
    const html = join(dir, "r.html");
    const rep = cliRun(["report", bundle, "--out", html]);
    expect(rep.code).toBe(0);
    absentFrom(rep.out, words);
    absentFrom(readFileSync(html, "utf8"), words);
  });

  it("R3-S1: export redacts --forbid-file values and the host account name", () => {
    const dir = mkdtempSync(join(tmpdir(), "proof-r3s1-"));
    const marker = j("forbidden", "-marker-", "PLANTED0006");
    const forbid = join(dir, "forbid.txt");
    writeFileSync(forbid, `${marker}\n`);
    let account = "";
    try {
      account = userInfo().username;
    } catch {
      account = "";
    }
    // The host account appears as a bare word, which no generic shape catches: only the
    // CLI's host redaction context removes it.
    const summary =
      account.length >= 3 ? `uses ${marker} as ${account} today` : `uses ${marker} today`;
    const bundle = join(dir, "b.json");
    const exp = cliRun([
      "export",
      writeRun(dir, summary),
      "--out",
      bundle,
      "--forbid-file",
      forbid,
    ]);
    expect(exp.code).toBe(0);
    const text = readFileSync(bundle, "utf8");
    expect(text).not.toContain(marker);
    expect(text).toContain(PLACEHOLDER.vaultKey);
    if (account.length >= 3) {
      expect(text).toContain(`as ${PLACEHOLDER.username} today`);
      expect(text).not.toMatch(
        new RegExp(`as ${account.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} today`),
      );
    }
    expect(cliRun(["verify", bundle, "--forbid-file", forbid]).code).toBe(0);
  });
});
