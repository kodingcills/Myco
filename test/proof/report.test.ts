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
import { renderProofReport } from "../../src/proof/report.ts";
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
    expect(html).toContain("REFUTED");
    expect(html).toContain("ORACLE_FAIL");
  });

  it("loads nothing: no script, no remote URL, no src/href, a default-src 'none' CSP", () => {
    const { b, r } = verified();
    const html = renderProofReport(b, r);
    expect(html).not.toMatch(/<script|<link|<img|<iframe|<object|\bsrc=|\bhref=|@import|url\(/i);
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).toContain("default-src 'none'");
  });

  it("escapes hostile text", () => {
    const run = sampleRun();
    const steps = [...run.steps];
    steps[1] = {
      kind: "action",
      actor: "agent",
      tool: "typeTextGlobal",
      summary: `<script>alert(1)</script><img src=x onerror=1>`,
    };
    const { b, r } = verified({ ...run, steps });
    const html = renderProofReport(b, r);
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("refuses to render a bundle that does not verify", () => {
    const { b } = verified();
    const t = clone(b);
    (t.records[1]?.body as { summary: string }).summary = "edited";
    const r = verifyProofBundle(serializeProofBundle(t));
    expect(r.ok).toBe(false);
    expect(() => renderProofReport(t, r)).toThrow(/does not verify/);
  });
});
