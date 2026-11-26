/**
 * Track Q (replayable proof): planted-marker redaction tests. Every marker is built at run
 * time from parts, so no tracked file carries a key-shaped string or a real home path.
 */
import { describe, expect, it } from "vitest";
import {
  exportProofBundle,
  serializeProofBundle,
  verifyProofBundle,
} from "../../src/proof/bundle.ts";
import {
  findLeaks,
  PLACEHOLDER,
  type RedactionContext,
  redactText,
} from "../../src/proof/redact.ts";
import { renderProofReport } from "../../src/proof/report.ts";
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
    const dirty = b.records.find(
      (r) => (r.body as { evidenceId?: string }).evidenceId === "ev-dirty",
    );
    expect(dirty?.body).toMatchObject({ withheld: "redaction" });
    expect(dirty?.body).not.toHaveProperty("content");
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
