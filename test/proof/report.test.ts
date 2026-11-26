/**
 * Track Q (replayable proof): the static report is offline, escaped, and refuses an
 * unverified bundle.
 */
import { describe, expect, it } from "vitest";
import {
  exportProofBundle,
  serializeProofBundle,
  verifyProofBundle,
} from "../../src/proof/bundle.ts";
import { textDigest } from "../../src/proof/closed.ts";
import { escapeHtml, renderProofReport } from "../../src/proof/report.ts";
import { clone, NO_CTX, sampleRun } from "./fixture.ts";

function verified(run = sampleRun()) {
  const b = exportProofBundle(run, NO_CTX);
  return { b, r: verifyProofBundle(serializeProofBundle(b)) };
}

describe("static proof report", () => {
  it("renders every record in order with the claim and the simulated banner", () => {
    const { b, r } = verified();
    const html = renderProofReport(b, r);
    expect(html).toContain("SIMULATED RUN");
    expect(html).toContain("Tamper-evident, not tamper-proof");
    expect(html).toContain(b.head.headSha256);
    expect(html.match(/<tr><td>\d+<\/td>/g)).toHaveLength(b.records.length);
    expect(html).toContain("What the gate said: <b>REFUTED</b>");
    expect(html).toContain(
      "whether it was right is the independent grader's call, not this bundle's",
    );
    expect(html).toContain("ORACLE_FAIL");
  });

  it("loads nothing: no script, no remote URL, no src/href, a default-src 'none' CSP", () => {
    const { b, r } = verified();
    const html = renderProofReport(b, r);
    expect(html).not.toMatch(/<script|<link|<img|<iframe|<object|\bsrc=|\bhref=|@import|url\(/i);
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).toContain("default-src 'none'");
  });

  it("hostile text never reaches the report: a summary is shown as its digest only", () => {
    const run = sampleRun();
    const steps = [...run.steps];
    const hostile = `<script>alert(1)</script><img src=x onerror=1>`;
    steps[1] = { kind: "action", actor: "agent", tool: "typeTextGlobal", summary: hostile };
    const { b, r } = verified({ ...run, steps });
    const html = renderProofReport(b, r);
    expect(html).not.toContain("alert");
    expect(html).not.toContain("onerror");
    expect(html).toContain(`sha256 ${textDigest(hostile).slice(0, 16)}`);
    expect(html).toContain(`(${hostile.length} chars; text not carried)`);
  });

  it("every value it does print is HTML-escaped (the claim's apostrophe, escapeHtml itself)", () => {
    const { b, r } = verified();
    const html = renderProofReport(b, r);
    expect(html).toContain("attempt ledger&#39;s guarantee");
    expect(escapeHtml(`<a href="x">'&`)).toBe("&lt;a href=&quot;x&quot;&gt;&#39;&amp;");
  });

  it("refuses to render a bundle that does not verify", () => {
    const { b } = verified();
    const t = clone(b);
    (t.records[1]!.body as { summary: { chars: number } }).summary.chars = 99;
    const r = verifyProofBundle(serializeProofBundle(t));
    expect(r.ok).toBe(false);
    expect(() => renderProofReport(t, r)).toThrow(/does not verify/);
  });
});
