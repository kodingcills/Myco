/**
 * Track Q (replayable proof): a shareable, tamper-evident record of one run.
 *
 * A proof bundle (`myco.proof.bundle/1`) is ONE self-contained JSON file:
 *  - `run`: the run and task ids, the arm, and whether it was simulated (a simulated bundle
 *    is never evidence; the verifier and the report say so), and `episode`: a reference
 *    (id + digest) to the attempt's canonical `myco.episode/1` record (#542), or null for a
 *    run written before episodes exist. The bundle is a CONTAINER over the episode, not a
 *    competing per-attempt record: with the episode at hand the verifier recomputes its id
 *    and digest and refuses any `run` field that disagrees with it (`episode-ref.ts`);
 *  - `records`: the ordered run, hash-chained. Each record is `{seq, prevSha256, kind, body}`
 *    and `prevSha256` is the sha256 of the previous record's canonical JSON: the attempt
 *    ledger's construction (#518), except that the first record's `prevSha256` is the sha256
 *    of the canonical `run` header (`runGenesis`), so the run's ids, arm, `simulated` flag and
 *    episode reference are covered by the chain and by the head. Kinds:
 *      action      what the agent or harness did (redacted summary);
 *      evidence    a digest (sha256 + bytes) of an artifact; text may be inlined, frames never;
 *      verdict     a myco.gate/v1 verdict: verdict, accepted, reason CODES (no free text);
 *      checkpoint  a per-checkpoint verdict of a multi-step task;
 *      handoff     a handoff between agents or sessions (shape lands with track N);
 *      policy      a policy decision (allow / deny / ask + code; shape lands with track O);
 *      ledger-anchor  binds the run to ONE trial of the attempt ledger: the trial's start and
 *                     end events (same trial key, the run's task and the run's arm) and the
 *                     ledger head. It does not bind the run id: the ledger has none;
 *  - `ledger`: the attempt ledger's events, verbatim, so the verifier can recompute it;
 *  - `head`: record count and the last record's hash;
 *  - `claim`: a FIXED statement of what the bundle proves. The verifier refuses any other
 *    wording, so no bundle can claim more than this module does.
 *
 * What it proves (security model, stated plainly; see docs/architecture/replayable-proof.md):
 * tamper-EVIDENCE against partial edits, gaps, reordering and truncation of the bundle and
 * of the ledger it carries, exactly as far as #518 does. The trusted harness that wrote the
 * run and the ledger is the boundary: the chains are unkeyed and the heads travel inside the
 * bundle, so a party that can write the whole bundle can regenerate a consistent one. Only an
 * out-of-band anchor (`expectHead`, `expectLedgerHead`) defeats that, and only for the party
 * that received the anchor separately. Nothing here is signed.
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { type JsonSchema, validateSchema } from "../../schemas/validate.ts";
import { GATE_API_VERSION, REASON_CODES } from "../gate/api.ts";
import { EPISODE_SCHEMA, type EpisodeRef, projectEpisode } from "./episode-ref.ts";
import {
  canonicalJson,
  type LedgerEvent,
  type LedgerHead,
  sha256Hex,
  verifyLedgerChain,
} from "./ledger.ts";
import {
  findLeaks,
  findLeaksDeep,
  type RedactionContext,
  redactDeep,
  redactText,
} from "./redact.ts";

export const PROOF_BUNDLE_SCHEMA = "myco.proof.bundle/1" as const;

/**
 * The only claim a bundle may make. Changing it is a reviewed code change, never an
 * exporter option.
 */
export const PROOF_CLAIM =
  "Tamper-evident, not tamper-proof: any edit, gap, reordering or truncation of these " +
  "records or of the attempt ledger they carry is detected when checked against the heads " +
  "pinned here (the attempt ledger's guarantee, #518, and no more). The trusted harness " +
  "that wrote the run is the boundary: the chains are unkeyed and unsigned, so whoever can " +
  "write the whole bundle can regenerate a consistent one; only a head received out of band " +
  "detects that.";

export const RECORD_KINDS = [
  "action",
  "evidence",
  "verdict",
  "checkpoint",
  "handoff",
  "policy",
  "ledger-anchor",
] as const;
export type RecordKind = (typeof RECORD_KINDS)[number];

/** Longest free-text summary (action, handoff), in characters, after redaction. */
export const SUMMARY_LIMIT = 500;

/** Largest inline evidence text, in bytes. Larger artifacts are digest-only. */
export const INLINE_EVIDENCE_LIMIT = 64 * 1024;

export interface ActionBody {
  readonly actor: "agent" | "harness";
  readonly tool: string;
  readonly summary: string;
}
export interface EvidenceBody {
  readonly evidenceId: string;
  readonly kind: string;
  readonly mediaType: string;
  /** Relative to the run's evidence location; never absolute. */
  readonly path?: string;
  /** sha256 of the ORIGINAL artifact bytes. */
  readonly sha256: string;
  readonly bytes: number;
  /** The artifact as UTF-8 text, when it is text, small, and redaction left it unchanged. */
  readonly content?: string;
  /** Why the content is not inlined (digest-only). */
  readonly withheld?: "binary" | "frame" | "too-large" | "redaction";
}
export interface VerdictBody {
  readonly gateApi: typeof GATE_API_VERSION;
  readonly taskId: string;
  readonly runId: string;
  readonly verdict: "verified" | "refuted" | "uncertain";
  readonly accepted: boolean;
  readonly reasonCodes: readonly string[];
  /** evidenceIds of evidence records earlier in the chain. */
  readonly evidence: readonly string[];
  readonly oracle?: {
    readonly family: string;
    readonly version: string;
    readonly specSha256: string;
  };
}
export interface CheckpointBody {
  readonly checkpoint: number;
  readonly verdict: "verified" | "refuted";
}
/** Minimal handoff shape (lands with track N: N's record maps onto this, never the reverse). */
export interface HandoffBody {
  readonly from: string;
  readonly to: string;
  readonly summary: string;
  readonly checkpoint?: number;
}
/** Minimal policy-decision shape (lands with track O). */
export interface PolicyBody {
  readonly policyId: string;
  readonly subject: string;
  readonly decision: "allow" | "deny" | "ask";
  readonly reasonCode: string;
}
export interface LedgerAnchorBody {
  readonly trialKey: string;
  readonly startSeq: number;
  readonly endSeq: number;
  readonly ledgerEvents: number;
  readonly ledgerHeadSha256: string;
}

export type RecordBody =
  | ActionBody
  | EvidenceBody
  | VerdictBody
  | CheckpointBody
  | HandoffBody
  | PolicyBody
  | LedgerAnchorBody;

export interface ProofRecord {
  readonly seq: number;
  readonly prevSha256: string;
  readonly kind: RecordKind;
  readonly body: RecordBody;
}

export interface ProofBundle {
  readonly schema: typeof PROOF_BUNDLE_SCHEMA;
  /** Always `PROOF_CLAIM`; the verifier refuses anything else. */
  readonly claim: string;
  readonly run: {
    readonly runId: string;
    readonly taskId: string;
    readonly arm?: string;
    readonly simulated: boolean;
    /** The attempt's canonical episode (#542), by id and digest; null before episodes exist. */
    readonly episode: EpisodeRef | null;
  };
  readonly records: readonly ProofRecord[];
  readonly ledger: { readonly events: readonly LedgerEvent[] } | null;
  readonly head: { readonly records: number; readonly headSha256: string };
}

// ---------------------------------------------------------------------------------------
// Schemas (closed: an unknown field anywhere is a refusal)

const ID = "^[A-Za-z0-9._:-]{1,128}$";
/** Arms may carry `+` (`hcu+shell`, the ledger's second arm). */
const ARM = "^[A-Za-z0-9._:+-]{1,128}$";
const HEX64 = "^[0-9a-f]{64}$";
const CODE = "^[A-Z][A-Z0-9_]{1,63}$";
/** Relative path: no leading slash, no drive letter, no `..` segment, no backslash. */
const REL_PATH = "^(?![A-Za-z]:)(?!/)(?!.*(?:^|/)\\.\\.(?:/|$))[A-Za-z0-9._@+/-]{1,256}$";
const TEXT = (max: number): JsonSchema => ({ type: "string", maxLength: max });

const bodySchemas: Record<RecordKind, JsonSchema> = {
  action: {
    type: "object",
    additionalProperties: false,
    required: ["actor", "tool", "summary"],
    properties: {
      actor: { enum: ["agent", "harness"] },
      tool: { type: "string", pattern: ID },
      summary: TEXT(SUMMARY_LIMIT),
    },
  },
  evidence: {
    type: "object",
    additionalProperties: false,
    required: ["evidenceId", "kind", "mediaType", "sha256", "bytes"],
    properties: {
      evidenceId: { type: "string", pattern: ID },
      kind: { type: "string", pattern: ID },
      mediaType: { type: "string", pattern: "^[a-z]+/[a-z0-9.+-]{1,64}$" },
      path: { type: "string", pattern: REL_PATH },
      sha256: { type: "string", pattern: HEX64 },
      bytes: { type: "integer", minimum: 0 },
      content: TEXT(INLINE_EVIDENCE_LIMIT),
      withheld: { enum: ["binary", "frame", "too-large", "redaction"] },
    },
  },
  verdict: {
    type: "object",
    additionalProperties: false,
    required: ["gateApi", "taskId", "runId", "verdict", "accepted", "reasonCodes", "evidence"],
    properties: {
      gateApi: { const: GATE_API_VERSION },
      taskId: { type: "string", pattern: ID },
      runId: { type: "string", pattern: ID },
      verdict: { enum: ["verified", "refuted", "uncertain"] },
      accepted: { type: "boolean" },
      reasonCodes: { type: "array", items: { enum: [...REASON_CODES] }, minItems: 1 },
      evidence: { type: "array", items: { type: "string", pattern: ID } },
      oracle: {
        type: "object",
        additionalProperties: false,
        required: ["family", "version", "specSha256"],
        properties: {
          family: { type: "string", pattern: ID },
          version: { type: "string", pattern: ID },
          specSha256: { type: "string", pattern: HEX64 },
        },
      },
    },
  },
  checkpoint: {
    type: "object",
    additionalProperties: false,
    required: ["checkpoint", "verdict"],
    properties: {
      checkpoint: { type: "integer", minimum: 1 },
      verdict: { enum: ["verified", "refuted"] },
    },
  },
  handoff: {
    type: "object",
    additionalProperties: false,
    required: ["from", "to", "summary"],
    properties: {
      from: { type: "string", pattern: ID },
      to: { type: "string", pattern: ID },
      summary: TEXT(SUMMARY_LIMIT),
      checkpoint: { type: "integer", minimum: 1 },
    },
  },
  policy: {
    type: "object",
    additionalProperties: false,
    required: ["policyId", "subject", "decision", "reasonCode"],
    properties: {
      policyId: { type: "string", pattern: ID },
      subject: { type: "string", pattern: ID },
      decision: { enum: ["allow", "deny", "ask"] },
      reasonCode: { type: "string", pattern: CODE },
    },
  },
  "ledger-anchor": {
    type: "object",
    additionalProperties: false,
    required: ["trialKey", "startSeq", "endSeq", "ledgerEvents", "ledgerHeadSha256"],
    properties: {
      trialKey: { type: "string", pattern: ID },
      startSeq: { type: "integer", minimum: 0 },
      endSeq: { type: "integer", minimum: 0 },
      ledgerEvents: { type: "integer", minimum: 1 },
      ledgerHeadSha256: { type: "string", pattern: HEX64 },
    },
  },
};

const bundleSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["schema", "claim", "run", "records", "ledger", "head"],
  properties: {
    schema: { const: PROOF_BUNDLE_SCHEMA },
    claim: { type: "string" },
    run: {
      type: "object",
      additionalProperties: false,
      required: ["runId", "taskId", "simulated", "episode"],
      properties: {
        runId: { type: "string", pattern: ID },
        taskId: { type: "string", pattern: ID },
        arm: { type: "string", pattern: ARM },
        simulated: { type: "boolean" },
        episode: {
          anyOf: [
            { type: "null" },
            {
              type: "object",
              additionalProperties: false,
              required: ["schema", "episodeId", "sha256"],
              properties: {
                schema: { const: EPISODE_SCHEMA },
                episodeId: { type: "string", pattern: HEX64 },
                sha256: { type: "string", pattern: HEX64 },
              },
            },
          ],
        },
      },
    },
    records: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["seq", "prevSha256", "kind", "body"],
        properties: {
          seq: { type: "integer", minimum: 0 },
          prevSha256: { type: "string", pattern: HEX64 },
          kind: { enum: [...RECORD_KINDS] },
          body: { type: "object" },
        },
      },
    },
    ledger: {
      anyOf: [
        { type: "null" },
        {
          type: "object",
          additionalProperties: false,
          required: ["events"],
          properties: { events: { type: "array", minItems: 1 } },
        },
      ],
    },
    head: {
      type: "object",
      additionalProperties: false,
      required: ["records", "headSha256"],
      properties: {
        records: { type: "integer", minimum: 1 },
        headSha256: { type: "string", pattern: HEX64 },
      },
    },
  },
};

export function recordSha256(record: ProofRecord): string {
  return sha256Hex(canonicalJson(record));
}

/**
 * The first record's `prevSha256`: the sha256 of the canonical `run` header, tagged with
 * the bundle schema. Editing any `run` field (for example `simulated`) breaks the chain.
 */
export function runGenesis(run: ProofBundle["run"]): string {
  return sha256Hex(canonicalJson({ schema: PROOF_BUNDLE_SCHEMA, run }));
}

// ---------------------------------------------------------------------------------------
// Export

/** One step of a run as the harness saw it, before redaction and chaining. */
export type ProofStep =
  | ({ readonly kind: "action" } & ActionBody)
  | {
      readonly kind: "evidence";
      readonly evidenceId: string;
      readonly evidenceKind: string;
      readonly mediaType: string;
      readonly path?: string;
      /** The artifact's bytes (or text). Hashed; inlined only when text, small and clean. */
      readonly content: string | Uint8Array;
    }
  | ({ readonly kind: "verdict" } & Omit<VerdictBody, "gateApi">)
  | ({ readonly kind: "checkpoint" } & CheckpointBody)
  | ({ readonly kind: "handoff" } & HandoffBody)
  | ({ readonly kind: "policy" } & PolicyBody);

export interface ProofRunInput {
  readonly runId: string;
  readonly taskId: string;
  readonly arm?: string;
  readonly simulated: boolean;
  readonly steps: readonly ProofStep[];
  /** The attempt ledger (#518 format) and this run's trial key in it. */
  readonly ledger?: {
    readonly lines: readonly unknown[];
    /** The head the pack pinned. The exporter refuses a ledger that does not match it. */
    readonly head: LedgerHead;
    readonly trialKey: string;
  };
  /**
   * The attempt's `myco.episode/1` record (#542), parsed. The bundle carries only its id and
   * digest; the run fields must agree with it (the exporter refuses otherwise).
   */
  readonly episode?: unknown;
}

export class ProofExportError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`);
  }
}

function isFrame(mediaType: string): boolean {
  return mediaType.startsWith("image/") || mediaType.startsWith("video/");
}

function decodeUtf8(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

function evidenceBody(
  step: Extract<ProofStep, { kind: "evidence" }>,
  ctx: RedactionContext,
): EvidenceBody {
  const bytes =
    typeof step.content === "string" ? new TextEncoder().encode(step.content) : step.content;
  const base = {
    evidenceId: step.evidenceId,
    kind: step.evidenceKind,
    mediaType: step.mediaType,
    ...(step.path === undefined ? {} : { path: redactText(step.path, ctx) }),
    sha256: sha256Hex(bytes),
    bytes: bytes.byteLength,
  };
  if (isFrame(step.mediaType)) return { ...base, withheld: "frame" };
  const text = decodeUtf8(bytes);
  if (text === undefined) return { ...base, withheld: "binary" };
  if (bytes.byteLength > INLINE_EVIDENCE_LIMIT) return { ...base, withheld: "too-large" };
  // Inline only if redaction leaves the text exactly as it was: then the digest of the
  // inlined text IS the artifact's digest and the verifier can recompute it.
  if (redactText(text, ctx) !== text || findLeaks(text, ctx).length > 0)
    return { ...base, withheld: "redaction" };
  return { ...base, content: text };
}

function stepBody(step: ProofStep, ctx: RedactionContext): { kind: RecordKind; body: RecordBody } {
  switch (step.kind) {
    case "evidence":
      return { kind: "evidence", body: evidenceBody(step, ctx) };
    case "verdict": {
      const { kind: _k, ...rest } = step;
      return { kind: "verdict", body: { gateApi: GATE_API_VERSION, ...rest } };
    }
    default: {
      const { kind, ...rest } = step;
      const body = redactDeep(rest, ctx) as Record<string, unknown>;
      // Free text is capped after redaction (a cut can never expose a removed value).
      if (typeof body.summary === "string") body.summary = body.summary.slice(0, SUMMARY_LIMIT);
      return { kind, body: body as unknown as RecordBody };
    }
  }
}

function chain(
  run: ProofBundle["run"],
  items: ReadonlyArray<{ kind: RecordKind; body: RecordBody }>,
): ProofRecord[] {
  const out: ProofRecord[] = [];
  let prev = runGenesis(run);
  for (const item of items) {
    const record: ProofRecord = {
      seq: out.length,
      prevSha256: prev,
      kind: item.kind,
      body: item.body,
    };
    out.push(record);
    prev = recordSha256(record);
  }
  return out;
}

/**
 * Build a bundle from a run. Fails closed: a broken or unpinned ledger, a run the verifier
 * would refuse, or any leak that survived redaction throws instead of producing a bundle.
 */
export function exportProofBundle(input: ProofRunInput, ctx: RedactionContext): ProofBundle {
  const items = input.steps.map((s) => stepBody(s, ctx));
  let ledger: ProofBundle["ledger"] = null;
  if (input.ledger !== undefined) {
    const { events, head, errors } = verifyLedgerChain(input.ledger.lines);
    if (errors.length > 0) throw new ProofExportError("PROOF_LEDGER_CHAIN", errors.join("; "));
    if (
      head.events !== input.ledger.head.events ||
      head.headSha256 !== input.ledger.head.headSha256
    )
      throw new ProofExportError("PROOF_LEDGER_HEAD", "the ledger does not match its pinned head");
    const key = input.ledger.trialKey;
    const start = events.findIndex((e) => e.trialKey === key && e.kind === "start");
    const end = events.findIndex((e) => e.trialKey === key && e.kind === "end");
    if (start < 0 || end < 0)
      throw new ProofExportError("PROOF_LEDGER_ANCHOR", "the run's trial is not in the ledger");
    items.push({
      kind: "ledger-anchor",
      body: {
        trialKey: key,
        startSeq: start,
        endSeq: end,
        ledgerEvents: head.events,
        ledgerHeadSha256: head.headSha256,
      },
    });
    ledger = { events };
  }
  let episode: EpisodeRef | null = null;
  if (input.episode !== undefined) {
    const projected = projectEpisode(input.episode);
    if (!projected.ok) throw new ProofExportError("PROOF_EPISODE", projected.errors.join("; "));
    episode = projected.projection.ref;
  }
  const run: ProofBundle["run"] = {
    runId: input.runId,
    taskId: input.taskId,
    ...(input.arm === undefined ? {} : { arm: input.arm }),
    simulated: input.simulated,
    episode,
  };
  const records = chain(run, items);
  const last = records.at(-1);
  if (last === undefined) throw new ProofExportError("PROOF_EMPTY", "a run with no records");
  const bundle: ProofBundle = {
    schema: PROOF_BUNDLE_SCHEMA,
    claim: PROOF_CLAIM,
    run,
    records,
    ledger,
    head: { records: records.length, headSha256: recordSha256(last) },
  };
  const result = verifyProofBundle(serializeProofBundle(bundle), {
    redaction: ctx,
    ...(input.episode === undefined ? {} : { episode: input.episode }),
  });
  if (!result.ok)
    throw new ProofExportError(
      result.errors[0]?.code ?? "PROOF_INVALID",
      result.errors.map((e) => e.message).join("; "),
    );
  return bundle;
}

export function serializeProofBundle(bundle: ProofBundle): string {
  return `${JSON.stringify(bundle, null, 2)}\n`;
}

// ---------------------------------------------------------------------------------------
// Verify

export interface ProofError {
  readonly code: string;
  readonly message: string;
}

export interface VerifyOptions {
  /** A bundle head received out of band: the only defense against a regenerated bundle. */
  readonly expectHead?: string;
  /** A ledger head received out of band (for example the pack's pin, recorded host-side). */
  readonly expectLedgerHead?: string;
  /** Recompute digest-only evidence from the original artifacts here. */
  readonly evidenceDir?: string;
  /** Extra literals that must not appear (the verifying host's own context). */
  readonly redaction?: RedactionContext;
  /**
   * The attempt's `myco.episode/1` record, parsed. When given, its id and digest are
   * recomputed against `run.episode` and the projected `run` fields are cross-checked.
   */
  readonly episode?: unknown;
}

export interface VerifyResult {
  readonly ok: boolean;
  readonly errors: readonly ProofError[];
  readonly head?: { readonly records: number; readonly headSha256: string };
  readonly ledgerHead?: LedgerHead;
  readonly simulated?: boolean;
  /** Evidence ids whose digest was recomputed (inline, or from `evidenceDir`). */
  readonly evidenceRecomputed: readonly string[];
  /** Evidence ids that are digest-only and were not recomputed (no `evidenceDir`). */
  readonly evidenceDigestOnly: readonly string[];
  /** True when the referenced episode was given and cross-checked. */
  readonly episodeChecked?: boolean;
}

/** Resolve a bundle-relative evidence path inside `dir`, refusing escapes (symlinks too). */
function insideDir(dir: string, rel: string): string | undefined {
  if (isAbsolute(rel)) return undefined;
  const root = realpathSync(resolve(dir));
  const target = resolve(root, rel);
  if (!existsSync(target)) return target;
  const real = realpathSync(target);
  const back = relative(root, real);
  if (back === "" || back.startsWith(`..${sep}`) || back === ".." || isAbsolute(back))
    return undefined;
  return real;
}

/**
 * Verify a serialized bundle. Every digest and chain link is recomputed; any edit, gap,
 * reordering, truncation, unknown field, inflated claim, inconsistent verdict, broken or
 * unbound ledger, or surviving leak is a refusal. `ok` is true only when there is no error.
 */
export function verifyProofBundle(text: string, options: VerifyOptions = {}): VerifyResult {
  const errors: ProofError[] = [];
  const recomputed: string[] = [];
  const digestOnly: string[] = [];
  const fail = (code: string, message: string) => errors.push({ code, message });
  const done = (extra: Partial<VerifyResult> = {}): VerifyResult => ({
    ok: errors.length === 0,
    errors,
    evidenceRecomputed: recomputed,
    evidenceDigestOnly: digestOnly,
    ...extra,
  });

  // Redaction first: a leaked value is refused whatever else is wrong. Every PARSED string
  // value and key is scanned, each in every decoded form, so a path behind a JSON escape
  // (`\t`, `\/`, `\u002f`), percent-encoding or an HTML entity cannot hide. Text that does
  // not parse is scanned as text.
  let parsed: unknown;
  let parseOk = true;
  try {
    parsed = JSON.parse(text);
  } catch {
    parseOk = false;
  }
  const leaks = parseOk
    ? findLeaksDeep(parsed, options.redaction)
    : findLeaks(text, options.redaction);
  if (leaks.length > 0) {
    const kinds = [...new Set(leaks.map((l) => l.kind))].join(", ");
    fail("PROOF_REDACTION", `the bundle carries ${leaks.length} unredacted value(s): ${kinds}`);
  }
  if (!parseOk) {
    fail("PROOF_SCHEMA", "not JSON");
    return done();
  }
  const issues = validateSchema(parsed, bundleSchema);
  if (issues.length > 0) {
    for (const i of issues.slice(0, 10)) fail("PROOF_SCHEMA", `${i.path} fails ${i.keyword}`);
    return done();
  }
  const bundle = parsed as ProofBundle;
  if (bundle.claim !== PROOF_CLAIM)
    fail("PROOF_CLAIM", "the claim is not the fixed tamper-evidence statement (no stronger claim)");

  // The record chain, seeded with the run header.
  let prev = runGenesis(bundle.run);
  let chainOk = true;
  for (let i = 0; i < bundle.records.length; i++) {
    const r = bundle.records[i] as ProofRecord;
    const bodyIssues = validateSchema(r.body, bodySchemas[r.kind], `$.records[${i}].body`);
    for (const b of bodyIssues.slice(0, 5)) fail("PROOF_SCHEMA", `${b.path} fails ${b.keyword}`);
    if (r.seq !== i) {
      fail("PROOF_GAP", `record ${i}: seq ${r.seq}, expected ${i} (a gap or a reordering)`);
      chainOk = false;
      break;
    }
    if (r.prevSha256 !== prev) {
      fail(
        "PROOF_CHAIN",
        i === 0
          ? "record 0: the hash chain breaks (an edited run header, or an edited or removed first record)"
          : `record ${i}: the hash chain breaks (an edited, removed or reordered record)`,
      );
      chainOk = false;
      break;
    }
    prev = recordSha256(r);
  }
  if (chainOk && (bundle.head.records !== bundle.records.length || bundle.head.headSha256 !== prev))
    fail("PROOF_TRUNCATED", "the records do not reach the pinned head (truncated, or extended)");
  if (options.expectHead !== undefined && bundle.head.headSha256 !== options.expectHead)
    fail("PROOF_ANCHOR_MISMATCH", "the bundle head differs from the out-of-band head");
  if (errors.some((e) => e.code === "PROOF_SCHEMA")) return done();

  // Evidence digests, and the order rule: a verdict cites only evidence already recorded.
  const seenEvidence = new Set<string>();
  for (const r of bundle.records) {
    if (r.kind === "evidence") {
      const e = r.body as EvidenceBody;
      if (seenEvidence.has(e.evidenceId)) fail("PROOF_EVIDENCE", `evidence ${e.evidenceId} twice`);
      seenEvidence.add(e.evidenceId);
      if ((e.content === undefined) === (e.withheld === undefined))
        fail("PROOF_EVIDENCE", `evidence ${e.evidenceId}: exactly one of content or withheld`);
      if (e.content !== undefined) {
        if (isFrame(e.mediaType))
          fail("PROOF_EVIDENCE", `evidence ${e.evidenceId}: a frame is never inlined`);
        const bytes = new TextEncoder().encode(e.content);
        if (sha256Hex(bytes) !== e.sha256 || bytes.byteLength !== e.bytes)
          fail(
            "PROOF_EVIDENCE_DIGEST",
            `evidence ${e.evidenceId}: content does not match its digest`,
          );
        else if (options.evidenceDir === undefined || e.path === undefined)
          recomputed.push(e.evidenceId);
      }
      // With an evidence dir, every artifact that names a path is recomputed from the
      // original bytes too, inline or not: the run dir must still hold what was recorded.
      if (options.evidenceDir !== undefined && e.path !== undefined) {
        const file = insideDir(options.evidenceDir, e.path);
        if (file === undefined)
          fail("PROOF_EVIDENCE", `evidence ${e.evidenceId}: path escapes the evidence dir`);
        else if (!existsSync(file))
          fail("PROOF_EVIDENCE_MISSING", `evidence ${e.evidenceId}: no file to recompute`);
        else {
          const bytes = readFileSync(file);
          if (sha256Hex(bytes) !== e.sha256 || bytes.byteLength !== e.bytes)
            fail(
              "PROOF_EVIDENCE_DIGEST",
              `evidence ${e.evidenceId}: the file does not match its digest`,
            );
          else if (!recomputed.includes(e.evidenceId)) recomputed.push(e.evidenceId);
        }
      } else if (e.content === undefined) digestOnly.push(e.evidenceId);
    }
    if (r.kind === "verdict") {
      const v = r.body as VerdictBody;
      if (v.accepted !== (v.verdict === "verified"))
        fail("PROOF_VERDICT", "accepted must be true exactly when the verdict is verified");
      if (v.verdict === "verified" && !v.reasonCodes.includes("ORACLE_PASS"))
        fail("PROOF_VERDICT", "a verified verdict carries ORACLE_PASS");
      if (v.verdict !== "verified" && v.reasonCodes.includes("ORACLE_PASS"))
        fail("PROOF_VERDICT", "ORACLE_PASS goes with verified only");
      if (v.taskId !== bundle.run.taskId || v.runId !== bundle.run.runId)
        fail("PROOF_VERDICT", "a verdict for another task or run (the gate is bound to one trial)");
      for (const id of v.evidence)
        if (!seenEvidence.has(id))
          fail("PROOF_VERDICT", `verdict cites evidence ${id} not recorded before it`);
    }
  }

  // The attempt ledger (#518 format) and its binding to this run.
  const anchors = bundle.records.filter((r) => r.kind === "ledger-anchor");
  let ledgerHead: LedgerHead | undefined;
  if (bundle.ledger === null) {
    if (anchors.length > 0) fail("PROOF_LEDGER_ANCHOR", "an anchor but no ledger");
    if (options.expectLedgerHead !== undefined)
      fail("PROOF_ANCHOR_MISMATCH", "a ledger head was expected but the bundle carries no ledger");
  } else {
    const { events, head, errors: chainErrors } = verifyLedgerChain(bundle.ledger.events);
    for (const m of chainErrors) fail("PROOF_LEDGER_CHAIN", m);
    ledgerHead = head;
    if (anchors.length !== 1)
      fail("PROOF_LEDGER_ANCHOR", "a ledger needs exactly one anchor record");
    const a = anchors[0]?.body as LedgerAnchorBody | undefined;
    if (a !== undefined && chainErrors.length === 0) {
      if (a.ledgerEvents !== head.events || a.ledgerHeadSha256 !== head.headSha256)
        fail(
          "PROOF_LEDGER_HEAD",
          "the ledger does not reach the anchored head (truncated or edited)",
        );
      const starts = events.filter((e) => e.trialKey === a.trialKey && e.kind === "start");
      const ends = events.filter((e) => e.trialKey === a.trialKey && e.kind === "end");
      const s = events[a.startSeq];
      const en = events[a.endSeq];
      if (starts.length !== 1 || ends.length !== 1)
        fail("PROOF_LEDGER_ANCHOR", "the run's trial needs exactly one start and one end");
      if (
        s?.kind !== "start" ||
        s.trialKey !== a.trialKey ||
        en?.kind !== "end" ||
        en.trialKey !== a.trialKey
      )
        fail("PROOF_LEDGER_ANCHOR", "the anchor's seqs do not point at the trial's start and end");
      else if (a.startSeq >= a.endSeq)
        fail("PROOF_LEDGER_ANCHOR", "the trial ends before it starts");
      else if (s.taskId !== bundle.run.taskId || en.taskId !== bundle.run.taskId)
        fail("PROOF_LEDGER_ANCHOR", "the ledger's trial is for another task");
      else if (bundle.run.arm === undefined)
        fail("PROOF_LEDGER_ANCHOR", "a run anchored to a ledger trial must state its arm");
      else if (s.arm !== bundle.run.arm || en.arm !== bundle.run.arm)
        fail("PROOF_LEDGER_ANCHOR", "the ledger's trial is for another arm");
    }
    if (options.expectLedgerHead !== undefined && head.headSha256 !== options.expectLedgerHead)
      fail("PROOF_ANCHOR_MISMATCH", "the ledger head differs from the out-of-band head");
  }

  // The canonical episode this bundle is a container over.
  let episodeChecked = false;
  const ref = bundle.run.episode;
  if (options.episode !== undefined) {
    if (ref === null) fail("PROOF_EPISODE", "an episode was given but the bundle references none");
    else {
      const projected = projectEpisode(options.episode);
      if (!projected.ok) for (const m of projected.errors) fail("PROOF_EPISODE", m);
      else {
        const p = projected.projection;
        if (p.ref.episodeId !== ref.episodeId || p.ref.sha256 !== ref.sha256)
          fail("PROOF_EPISODE", "the episode's id or digest differs from the bundle's reference");
        if (p.runId !== bundle.run.runId)
          fail("PROOF_EPISODE", "run.runId differs from the episode");
        if (p.taskId !== bundle.run.taskId)
          fail("PROOF_EPISODE", "run.taskId differs from the episode");
        if (p.arm !== bundle.run.arm) fail("PROOF_EPISODE", "run.arm differs from the episode");
        if (p.simulated !== bundle.run.simulated)
          fail("PROOF_EPISODE", "run.simulated differs from the episode");
        const anchor = anchors[0]?.body as LedgerAnchorBody | undefined;
        if (p.trialKey !== null && anchor !== undefined && anchor.trialKey !== p.trialKey)
          fail("PROOF_EPISODE", "the anchored ledger trial differs from the episode's trial");
        episodeChecked = true;
      }
    }
  }

  return done({
    head: bundle.head,
    ...(ledgerHead === undefined ? {} : { ledgerHead }),
    simulated: bundle.run.simulated,
    episodeChecked,
  });
}

/** Read and verify a bundle file. */
export function verifyProofFile(path: string, options: VerifyOptions = {}): VerifyResult {
  return verifyProofBundle(readFileSync(path, "utf8"), options);
}
