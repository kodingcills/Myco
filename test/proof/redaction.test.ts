/**
 * Track Q (replayable proof): planted-marker redaction tests. Every marker is built at run
 * time from parts, so no tracked file carries a key-shaped string or a real home path.
 */
import { describe, expect, it } from "vitest";
import {
  exportProofBundle,
  type ProofBundle,
  serializeProofBundle,
  verifyProofBundle,
} from "../../src/proof/bundle.ts";
import { emit } from "../../src/proof/cli.ts";
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

  it("ordinary text stays clean in every decoded form (no false refusal)", () => {
    for (const ok of [
      "a%20b 50% done &amp; ok &lt;tag&gt;",
      "line\\nnext \\t tab",
      "https://example.org/a/b?x=%2Fy",
      "ratio 3:4, C: drive, path a/b/c, ~/notes, task_list_items, risk-assessment",
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
