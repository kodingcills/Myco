/**
 * Track Q (replayable proof): a static, offline HTML report of a VERIFIED bundle.
 *
 * Replay is read-only and needs no server: the report is one HTML file with no script, no
 * link, no image and no remote resource, and a Content-Security-Policy of `default-src
 * 'none'` so a browser fetches nothing even if a value slipped through. Every value is
 * HTML-escaped. A bundle that does not verify is never rendered (fail closed): a report of
 * an unverified bundle would look like proof.
 *
 * The rendered HTML is itself scanned for leaks (`findLeaks`, every decoded form, HTML
 * entities included) before it is returned. A leak throws and no report is produced: the
 * report is an output in its own right, not only a view of a scanned bundle.
 */
import type {
  ActionBody,
  CheckpointBody,
  EvidenceBody,
  HandoffBody,
  LedgerAnchorBody,
  PolicyBody,
  ProofBundle,
  ProofRecord,
  VerdictBody,
  VerifyResult,
} from "./bundle.ts";
import { EMPTY_REDACTION, findLeaks, type RedactionContext } from "./redact.ts";

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const CSP = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";

function detail(r: ProofRecord): string {
  const e = escapeHtml;
  switch (r.kind) {
    case "action": {
      const b = r.body as ActionBody;
      return `<b>${e(b.actor)}</b> ${e(b.tool)}: ${e(b.summary)}`;
    }
    case "evidence": {
      const b = r.body as EvidenceBody;
      const where = b.path === undefined ? "" : ` ${e(b.path)}`;
      const how =
        b.content !== undefined
          ? `<details><summary>inline text (digest recomputed)</summary><pre>${e(b.content)}</pre></details>`
          : `digest only (${e(b.withheld ?? "")})`;
      return `${e(b.evidenceId)} [${e(b.kind)}, ${e(b.mediaType)}]${where}<br><code>sha256 ${e(b.sha256)}</code>, ${b.bytes} bytes, ${how}`;
    }
    case "verdict": {
      const b = r.body as VerdictBody;
      return `What the gate said: <b>${e(b.verdict.toUpperCase())}</b> (accepted: ${b.accepted}; whether it was right is the independent grader's call, not this bundle's) codes: ${b.reasonCodes.map(e).join(", ")}; evidence: ${b.evidence.map(e).join(", ") || "none"}`;
    }
    case "checkpoint": {
      const b = r.body as CheckpointBody;
      return `checkpoint ${b.checkpoint}: ${e(b.verdict)}`;
    }
    case "handoff": {
      const b = r.body as HandoffBody;
      return `${e(b.from)} &rarr; ${e(b.to)}: ${e(b.summary)}`;
    }
    case "policy": {
      const b = r.body as PolicyBody;
      return `${e(b.policyId)} on ${e(b.subject)}: <b>${e(b.decision)}</b> (${e(b.reasonCode)})`;
    }
    case "ledger-anchor": {
      const b = r.body as LedgerAnchorBody;
      return `trial ${e(b.trialKey)}: ledger events ${b.startSeq}..${b.endSeq} of ${b.ledgerEvents}, head <code>${e(b.ledgerHeadSha256)}</code>`;
    }
  }
}

export class ProofReportError extends Error {}

/**
 * Render a verified bundle. Throws when `verification.ok` is false, or when the rendered
 * HTML carries anything `findLeaks` (with `redaction`) refuses.
 */
export function renderProofReport(
  bundle: ProofBundle,
  verification: VerifyResult,
  redaction: RedactionContext = EMPTY_REDACTION,
): string {
  if (!verification.ok)
    throw new ProofReportError("refusing to render a bundle that does not verify");
  const html = renderHtml(bundle, verification);
  const leaks = findLeaks(html, redaction);
  if (leaks.length > 0)
    throw new ProofReportError(
      `refusing to write a report that carries ${leaks.length} unredacted value(s): ${[
        ...new Set(leaks.map((l) => l.kind)),
      ].join(", ")}`,
    );
  return html;
}

function renderHtml(bundle: ProofBundle, verification: VerifyResult): string {
  const e = escapeHtml;
  const rows = bundle.records
    .map(
      (r) =>
        `<tr><td>${r.seq}</td><td>${e(r.kind)}</td><td>${detail(r)}</td><td><code>${e(r.prevSha256.slice(0, 12))}</code></td></tr>`,
    )
    .join("\n");
  const ledger =
    bundle.ledger === null
      ? "<p>No attempt ledger in this bundle.</p>"
      : `<p>Attempt ledger: ${bundle.ledger.events.length} events, head <code>${e(verification.ledgerHead?.headSha256 ?? "")}</code> (recomputed).</p>`;
  const ref = bundle.run.episode;
  const episode =
    ref === null
      ? "<p>No episode record referenced (a run written before <code>myco.episode/1</code>).</p>"
      : `<p>Episode <code>${e(ref.episodeId)}</code>, sha256 <code>${e(ref.sha256)}</code> (${
          verification.episodeChecked === true
            ? "recomputed and cross-checked"
            : "reference only: not checked here"
        }).</p>`;
  const simulated = bundle.run.simulated
    ? `<p class="sim">SIMULATED RUN: scripted or mock. Not evidence; never counted.</p>`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${CSP}">
<meta name="referrer" content="no-referrer">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Myco proof ${e(bundle.run.runId)}</title>
<style>
body{font:14px/1.45 system-ui,sans-serif;margin:16px;max-width:1100px;background:#fff;color:#111}
table{border-collapse:collapse;width:100%}td,th{border:1px solid #ccc;padding:4px 6px;vertical-align:top;text-align:left}
code,pre{font:12px ui-monospace,monospace;white-space:pre-wrap;word-break:break-all}
.ok{color:#075;font-weight:600}.sim{background:#fff3cd;padding:6px;font-weight:600}
.claim{border-left:4px solid #888;padding-left:8px}
@media (prefers-color-scheme:dark){body{background:#111;color:#eee}td,th{border-color:#444}.sim{background:#553;color:#fff}}
</style>
</head>
<body>
<h1>Proof bundle: run ${e(bundle.run.runId)}</h1>
<p>Task ${e(bundle.run.taskId)}${bundle.run.arm === undefined ? "" : `, arm ${e(bundle.run.arm)}`}.</p>
${simulated}
${episode}
<p class="ok">Verified: every record hash, chain link and inline evidence digest was recomputed. Head <code>${e(bundle.head.headSha256)}</code> (${bundle.head.records} records).</p>
<p>Digest-only evidence not recomputed here: ${verification.evidenceDigestOnly.map(e).join(", ") || "none"}.</p>
<p class="claim">${e(bundle.claim)}</p>
${ledger}
<table>
<thead><tr><th>#</th><th>kind</th><th>record</th><th>prev</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>
</body>
</html>
`;
}
