/**
 * Track Q (replayable proof): the leak scanner as a BACKSTOP. It is not what keeps a path out
 * of a bundle (the allowlist is: `allowlist.test.ts`). It must still fire, and fail closed, on
 * every output: the export (self-verify), verify, the report HTML and every CLI line. The one
 * case where it matters in an honest run: a value that IS a closed id but equals something
 * registered (the guest's account name, a forbidden literal) or looks like a key.
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findLeaks, findLeaksDeep, type RedactionContext } from "../../src/proof/backstop.ts";
import {
  exportProofBundle,
  serializeProofBundle,
  verifyProofBundle,
} from "../../src/proof/bundle.ts";
import { emit, hostRedaction, main } from "../../src/proof/cli.ts";
import { hashedId } from "../../src/proof/closed.ts";
import { renderProofReport } from "../../src/proof/report.ts";
import { clone, NO_CTX, rechain, sampleRun } from "./fixture.ts";
import { exportVerifyReport, plantEverywhere } from "./plant.ts";
import { j, LINUX_HOME, SECRET_VALUE, USER, VAULT_KEY } from "./probe-corpus.ts";

const GUEST = j("qz", "plantedguest");
const ctxUser: RedactionContext = { ...NO_CTX, usernames: [GUEST] };
const codesOf = (text: string, ctx?: RedactionContext) =>
  verifyProofBundle(text, ctx === undefined ? {} : { redaction: ctx }).errors.map((e) => e.code);

/** `sampleRun()` with a different run id (the verdict's too, so the binding holds). */
function runAs(id: string) {
  const run = sampleRun();
  return {
    ...run,
    runId: id,
    steps: run.steps.map((s) => (s.kind === "verdict" ? { ...s, runId: id } : s)),
  };
}

function cliRun(args: string[]): { code: number; out: string } {
  let out = "";
  const code = main(args, { out: (t) => (out += t), err: (t) => (out += t) });
  return { code, out };
}

describe("the backstop never false-fires on an allowlisted bundle or its report", () => {
  it("an honest bundle, its verify result and its HTML have zero backstop hits", () => {
    const b = exportProofBundle(sampleRun(), NO_CTX);
    const text = serializeProofBundle(b);
    expect(findLeaksDeep(JSON.parse(text))).toEqual([]);
    const r = verifyProofBundle(text);
    expect(r.ok).toBe(true);
    expect(findLeaks(renderProofReport(b, r))).toEqual([]);
  });

  it("ordinary text stays clean in every decoded form", () => {
    for (const ok of [
      "a%20b 50% done &amp; ok &lt;tag&gt;",
      "https://example.org/a/b?x=%2Fy",
      "ratio 3:4, C: drive, path a/b/c, ~/notes, task_list_items, risk-assessment",
      "home page, root cause, users list, the users/ folder, myhome/x, rooted/x",
      "text/csv, myco.gate/v1, react@18, @types/node",
    ])
      expect(findLeaks(ok), ok).toEqual([]);
  });
});

describe("what the backstop reports", () => {
  it("kinds and offsets only, never the matched value", () => {
    const leaks = findLeaks(`see ${LINUX_HOME}/x and ${SECRET_VALUE}`, {
      ...NO_CTX,
      secrets: [SECRET_VALUE],
    });
    expect(leaks.length).toBeGreaterThan(0);
    expect(JSON.stringify(leaks)).not.toContain(USER);
    expect(JSON.stringify(leaks)).not.toContain("PLANTED");
  });

  it("every registered literal kind is flagged, including behind percent-encoding and in any case", () => {
    const ctx: RedactionContext = {
      secrets: [SECRET_VALUE],
      vaultKeys: [VAULT_KEY],
      hostPaths: [LINUX_HOME],
      usernames: [GUEST],
    };
    expect(findLeaks(`x ${SECRET_VALUE} y`, ctx).map((l) => l.kind)).toContain("secret");
    expect(findLeaks(VAULT_KEY.replace(/-/g, "%2D"), ctx).map((l) => l.kind)).toContain(
      "vault-key",
    );
    expect(findLeaks(`${LINUX_HOME}x`, ctx).map((l) => l.kind)).toContain("host-path");
    expect(findLeaks(`as ${GUEST.toUpperCase()} today`, ctx).map((l) => l.kind)).toContain(
      "username",
    );
  });

  it("object keys are scanned too, and text that is not JSON is scanned as text", () => {
    expect(findLeaksDeep({ [`${LINUX_HOME}/x`]: 1 })).not.toEqual([]);
    const b = clone(exportProofBundle(sampleRun(), NO_CTX)) as unknown as Record<string, unknown>;
    b[`${LINUX_HOME}/x`] = 1;
    expect(codesOf(JSON.stringify(b))).toContain("PROOF_REDACTION");
    expect(codesOf(`{ ${LINUX_HOME}/x`)).toEqual(["PROOF_REDACTION", "PROOF_SCHEMA"]);
  });
});

describe("the backstop fails every output closed", () => {
  it("EXPORT: a closed id that is key-shaped is digested (r3 identity guard; was a backstop refusal)", () => {
    const key = j("sk_", "PLANTEDPLANTED");
    const b = exportProofBundle(runAs(key), NO_CTX);
    expect(b.run.runId).toBe(hashedId(key));
    expect(serializeProofBundle(b)).not.toContain("PLANTEDPLANTED");
    // The backstop still refuses it if the allowlist ever wrote it (a forged bundle).
    const forged = clone(b) as unknown as { run: { runId: string } };
    forged.run.runId = key;
    expect(codesOf(JSON.stringify(forged))).toContain("PROOF_REDACTION");
  });

  it("EXPORT: a closed id equal to a registered account name is digested, in any case (r3)", () => {
    expect(exportProofBundle(runAs(GUEST), NO_CTX).run.runId).toBe(GUEST);
    for (const id of [GUEST, GUEST.toUpperCase()]) {
      const b = exportProofBundle(runAs(id), ctxUser);
      expect(b.run.runId).toBe(hashedId(id));
      expect(serializeProofBundle(b).toLowerCase()).not.toContain(GUEST.toLowerCase());
    }
  });

  it("VERIFY: a hand-edited, re-chained bundle whose closed id is a registered name is refused", () => {
    const b = clone(exportProofBundle(sampleRun(), NO_CTX));
    // `policyId` is a closed id (`tool` is a closed vocabulary since #562 F1: a forged
    // non-member is a schema refusal, `vocab.test.ts`).
    (b.records[0]?.body as { policyId: string }).policyId = GUEST;
    const text = serializeProofBundle(rechain(b));
    expect(codesOf(text)).toEqual([]);
    expect(codesOf(text, ctxUser)).toEqual(["PROOF_REDACTION"]);
  });

  it("REPORT: HTML that the backstop flags is not rendered", () => {
    const b = exportProofBundle(runAs(GUEST), NO_CTX);
    const r = verifyProofBundle(serializeProofBundle(b));
    // The CLI pairs verify and report; a library caller can render with its own context.
    expect(() => renderProofReport(b, r, ctxUser)).toThrow(/backstop/);
    expect(renderProofReport(b, r)).toContain(GUEST);
  });

  it("CLI: a line that would leak prints only codes", () => {
    let out = "";
    emit(
      { out: (t) => (out += t), err: (t) => (out += t) },
      { ok: false, code: "PROOF_X", message: `at ${LINUX_HOME}/x` },
      NO_CTX,
    );
    expect(out).not.toContain(USER);
    expect(JSON.parse(out)).toEqual({ ok: false, codes: ["PROOF_X", "PROOF_OUTPUT_REDACTED"] });
  });

  it("CLI --user-file and --forbid-file feed the backstop; their contents are never printed", () => {
    const dir = mkdtempSync(join(tmpdir(), "proof-backstop-"));
    const users = join(dir, "users.txt");
    writeFileSync(users, `${GUEST}\n`);
    const marker = j("forbidden", "-marker-", "PLANTED0006");
    const forbid = join(dir, "forbid.txt");
    writeFileSync(forbid, `${marker}\n`);
    const write = (name: string, run: unknown) => {
      const p = join(dir, name);
      writeFileSync(p, JSON.stringify(run));
      return p;
    };
    const { ledger: _l, ...run } = sampleRun();
    const steps = run.steps.map((s) =>
      s.kind === "evidence" && s.content instanceof Uint8Array ? { ...s, content: "png" } : s,
    );
    // The guest's name as a closed id: exported without the file, refused with it.
    const asId = write("id.json", {
      ...run,
      runId: GUEST.toUpperCase(),
      steps: steps.map((s) => (s.kind === "verdict" ? { ...s, runId: GUEST.toUpperCase() } : s)),
    });
    const b = join(dir, "b.json");
    expect(cliRun(["export", asId, "--out", b]).code).toBe(0);
    // With the file, the name is an identity string: the id is digested (r3), not written.
    const b2 = join(dir, "b2.json");
    const digested = cliRun(["export", asId, "--out", b2, "--user-file", users]);
    expect(digested.code).toBe(0);
    expect(readFileSync(b2, "utf8").toLowerCase()).not.toContain(GUEST);
    expect(digested.out.toLowerCase()).not.toContain(GUEST);
    // A bundle written without the file carries it: verify with the file refuses it.
    const ver = cliRun(["verify", b, "--user-file", users]);
    expect(ver.code).toBe(1);
    expect(ver.out.toLowerCase()).not.toContain(GUEST);
    // A forbidden literal in free text is never written (digest), so the export passes.
    const inText = write("text.json", {
      ...run,
      steps: [{ kind: "action", actor: "agent", tool: "t", summary: `uses ${marker}` }, ...steps],
    });
    const b3 = join(dir, "b3.json");
    const ok = cliRun(["export", inText, "--out", b3, "--forbid-file", forbid]);
    expect(ok.code).toBe(0);
    expect(readFileSync(b3, "utf8")).not.toContain(marker);
    expect(ok.out).not.toContain(marker);
  });

  it("the CLI registers the host's own account name and directories", () => {
    const ctx = hostRedaction();
    let account = "";
    try {
      account = userInfo().username;
    } catch {
      account = "";
    }
    if (account !== "") expect(ctx.usernames).toContain(account);
    expect(ctx.hostPaths.length).toBeGreaterThan(0);
  });
});

describe("the backstop is not the guarantee", () => {
  it("a form the scanner does NOT recognise still never reaches a bundle (allowlist)", () => {
    // `dest://` is an unlisted scheme: the scanner misses it (a #548 limit), the allowlist
    // does not care.
    const value = j("dest://nas/homes/", "Qzfirst", " ", "Qzlast");
    expect(findLeaks(value)).toEqual([]);
    const { text } = exportVerifyReport(plantEverywhere(value), ["Qzfirst", "Qzlast"]);
    expect(text).not.toContain("dest://");
  });
});
