/**
 * Track Q (replayable proof): a shareable, tamper-evident record of one run, written by
 * ALLOWLIST (`closed.ts`): every field of a bundle is of a closed type, and no free text,
 * path, filename, command line or message is ever written, only its digest.
 *
 * A proof bundle (`myco.proof.bundle/1`) is ONE self-contained JSON file:
 *  - `run`: the run and task ids, the arm, whether it was simulated (a simulated bundle is
 *    never evidence; the verifier and the report say so), and `episode`: a reference (id +
 *    digest) to the attempt's canonical `myco.episode/1` record (#542), or null for a run
 *    written before episodes exist. The bundle is a CONTAINER over the episode, not a
 *    competing per-attempt record: with the episode at hand the verifier recomputes its id
 *    and digest and refuses any `run` field that disagrees with it (`episode-ref.ts`);
 *  - `records`: the ordered run, hash-chained. Each record is `{seq, prevSha256, kind, body}`
 *    and `prevSha256` is the sha256 of the previous record's canonical JSON: the attempt
 *    ledger's construction (#518), except that the first record's `prevSha256` is the sha256
 *    of the canonical `run` header (`runGenesis`), so the run's ids, arm, `simulated` flag and
 *    episode reference are covered by the chain and by the head. Kinds:
 *      action      who acted (enum), the tool (closed id), the summary as a TextRef (digest);
 *      evidence    an artifact's sha256 and byte count; its path as a TextRef; never inlined;
 *      verdict     a myco.gate/v1 verdict: verdict, accepted, reason CODES (no free text);
 *      checkpoint  a per-checkpoint verdict of a multi-step task;
 *      handoff     a handoff between agents or sessions (shape lands with track N);
 *      policy      a policy decision (allow / deny / ask + code; shape lands with track O);
 *      ledger-anchor  binds the run to ONE trial of the attempt ledger: the trial's start and
 *                     end events (same trial key, the run's task and the run's arm) and the
 *                     ledger head. It does not bind the run id: the ledger has none;
 *  - `ledger`: the attempt ledger's events, verbatim (closed under #518's schema), so the
 *    verifier can recompute it;
 *  - `head`: record count and the last record's hash;
 *  - `claim`: a FIXED statement of what the bundle proves. The verifier refuses any other
 *    wording, so no bundle can claim more than this module does.
 *
 * What it proves (#518's ruled threat model, stated plainly; see
 * docs/architecture/replayable-proof.md): the adversary is the checked agent and any
 * guest-side process; the harness that wrote the run is trusted. Against them the bundle is
 * tamper-EVIDENT: partial edits, gaps, reordering and truncation of the bundle and of the
 * ledger it carries are detected. The chains are unkeyed and the heads travel inside the
 * bundle, so it is NOT proof against a malicious bundle author, who can regenerate a
 * consistent one; only an out-of-band head (`expectHead`, `expectLedgerHead`) detects that,
 * for the party that received it. Nothing here is signed. A verdict record says what the gate
 * said, never that the gate was right: that is the independent grader's call.
 */
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { type JsonSchema, validateSchema } from "../../schemas/validate.ts";
import { GATE_API_VERSION, REASON_CODES } from "../gate/api.ts";
import { findLeaks, findLeaksDeep, type RedactionContext } from "./backstop.ts";
import {
  ARM_SOURCE,
  CLOSED_ID_SOURCE,
  CODE_SOURCE,
  closedArm,
  closedCode,
  closedId,
  closedMediaType,
  HEX64,
  HEX64_SOURCE,
  LEDGER_ID_SOURCE,
  MEDIA_TYPE_SOURCE,
  type TextRef,
  textDigest,
  textRef,
} from "./closed.ts";
import { EPISODE_SCHEMA, type EpisodeRef, projectEpisode } from "./episode-ref.ts";
import {
  canonicalJson,
  type LedgerEvent,
  type LedgerHead,
  sha256Hex,
  verifyLedgerChain,
} from "./ledger.ts";

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
  "detects that. A verdict record is what the gate said, not a finding that it was right.";

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

const ACTORS = ["agent", "harness"] as const;
const VERDICTS = ["verified", "refuted", "uncertain"] as const;
const CHECKPOINT_VERDICTS = ["verified", "refuted"] as const;
const DECISIONS = ["allow", "deny", "ask"] as const;

export interface ActionBody {
  readonly actor: (typeof ACTORS)[number];
  readonly tool: string;
  readonly summary: TextRef;
}
export interface EvidenceBody {
  readonly evidenceId: string;
  readonly kind: string;
  readonly mediaType: string;
  /** The artifact's path as given by the harness, as a digest (never the path). */
  readonly path?: TextRef;
  /** sha256 of the ORIGINAL artifact bytes. */
  readonly sha256: string;
  readonly bytes: number;
}
export interface VerdictBody {
  readonly gateApi: typeof GATE_API_VERSION;
  readonly taskId: string;
  readonly runId: string;
  readonly verdict: (typeof VERDICTS)[number];
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
  readonly verdict: (typeof CHECKPOINT_VERDICTS)[number];
}
/** Minimal handoff shape (lands with track N: N's record maps onto this, never the reverse). */
export interface HandoffBody {
  readonly from: string;
  readonly to: string;
  readonly summary: TextRef;
  readonly checkpoint?: number;
}
/** Minimal policy-decision shape (lands with track O). */
export interface PolicyBody {
  readonly policyId: string;
  readonly subject: string;
  readonly decision: (typeof DECISIONS)[number];
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
// Schemas: CLOSED. Every leaf is an enum, a boolean, an integer, a digest or a closed-grammar
// string; an unknown field anywhere is a refusal. There is no free-text string type at all.

const ID: JsonSchema = { type: "string", pattern: CLOSED_ID_SOURCE };
const HEX: JsonSchema = { type: "string", pattern: HEX64_SOURCE };
const TEXT_REF: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["sha256", "chars"],
  properties: { sha256: HEX, chars: { type: "integer", minimum: 0 } },
};

export const BODY_SCHEMAS: Record<RecordKind, JsonSchema> = {
  action: {
    type: "object",
    additionalProperties: false,
    required: ["actor", "tool", "summary"],
    properties: { actor: { enum: [...ACTORS] }, tool: ID, summary: TEXT_REF },
  },
  evidence: {
    type: "object",
    additionalProperties: false,
    required: ["evidenceId", "kind", "mediaType", "sha256", "bytes"],
    properties: {
      evidenceId: ID,
      kind: ID,
      mediaType: { type: "string", pattern: MEDIA_TYPE_SOURCE },
      path: TEXT_REF,
      sha256: HEX,
      bytes: { type: "integer", minimum: 0 },
    },
  },
  verdict: {
    type: "object",
    additionalProperties: false,
    required: ["gateApi", "taskId", "runId", "verdict", "accepted", "reasonCodes", "evidence"],
    properties: {
      gateApi: { const: GATE_API_VERSION },
      taskId: ID,
      runId: ID,
      verdict: { enum: [...VERDICTS] },
      accepted: { type: "boolean" },
      reasonCodes: { type: "array", items: { enum: [...REASON_CODES] }, minItems: 1 },
      evidence: { type: "array", items: ID },
      oracle: {
        type: "object",
        additionalProperties: false,
        required: ["family", "version", "specSha256"],
        properties: { family: ID, version: ID, specSha256: HEX },
      },
    },
  },
  checkpoint: {
    type: "object",
    additionalProperties: false,
    required: ["checkpoint", "verdict"],
    properties: {
      checkpoint: { type: "integer", minimum: 1 },
      verdict: { enum: [...CHECKPOINT_VERDICTS] },
    },
  },
  handoff: {
    type: "object",
    additionalProperties: false,
    required: ["from", "to", "summary"],
    properties: {
      from: ID,
      to: ID,
      summary: TEXT_REF,
      checkpoint: { type: "integer", minimum: 1 },
    },
  },
  policy: {
    type: "object",
    additionalProperties: false,
    required: ["policyId", "subject", "decision", "reasonCode"],
    properties: {
      policyId: ID,
      subject: ID,
      decision: { enum: [...DECISIONS] },
      reasonCode: { type: "string", pattern: CODE_SOURCE },
    },
  },
  "ledger-anchor": {
    type: "object",
    additionalProperties: false,
    required: ["trialKey", "startSeq", "endSeq", "ledgerEvents", "ledgerHeadSha256"],
    properties: {
      trialKey: { type: "string", pattern: LEDGER_ID_SOURCE },
      startSeq: { type: "integer", minimum: 0 },
      endSeq: { type: "integer", minimum: 0 },
      ledgerEvents: { type: "integer", minimum: 1 },
      ledgerHeadSha256: HEX,
    },
  },
};

export const BUNDLE_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["schema", "claim", "run", "records", "ledger", "head"],
  properties: {
    schema: { const: PROOF_BUNDLE_SCHEMA },
    claim: { const: PROOF_CLAIM },
    run: {
      type: "object",
      additionalProperties: false,
      required: ["runId", "taskId", "simulated", "episode"],
      properties: {
        runId: ID,
        taskId: ID,
        arm: { type: "string", pattern: ARM_SOURCE },
        simulated: { type: "boolean" },
        episode: {
          anyOf: [
            { type: "null" },
            {
              type: "object",
              additionalProperties: false,
              required: ["schema", "episodeId", "sha256"],
              properties: { schema: { const: EPISODE_SCHEMA }, episodeId: HEX, sha256: HEX },
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
          prevSha256: HEX,
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
      properties: { records: { type: "integer", minimum: 1 }, headSha256: HEX },
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

/** One step of a run as the harness saw it: RAW values, before the allowlist. */
export type ProofStep =
  | {
      readonly kind: "action";
      readonly actor: string;
      readonly tool: string;
      readonly summary: string;
    }
  | {
      readonly kind: "evidence";
      readonly evidenceId: string;
      readonly evidenceKind: string;
      readonly mediaType: string;
      readonly path?: string;
      /** The artifact's bytes (or text). Hashed; never written. */
      readonly content: string | Uint8Array;
    }
  | {
      readonly kind: "verdict";
      readonly taskId: string;
      readonly runId: string;
      readonly verdict: string;
      readonly accepted: boolean;
      readonly reasonCodes: readonly string[];
      readonly evidence: readonly string[];
      readonly oracle?: {
        readonly family: string;
        readonly version: string;
        readonly specSha256: string;
      };
    }
  | { readonly kind: "checkpoint"; readonly checkpoint: number; readonly verdict: string }
  | {
      readonly kind: "handoff";
      readonly from: string;
      readonly to: string;
      readonly summary: string;
      readonly checkpoint?: number;
    }
  | {
      readonly kind: "policy";
      readonly policyId: string;
      readonly subject: string;
      readonly decision: string;
      readonly reasonCode: string;
    };

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

/** Messages are structural: a code, a field NAME from the allowlist, never a value. */
export class ProofExportError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`);
  }
}

const isStr = (v: unknown): v is string => typeof v === "string";
const isIn = <T extends string>(list: readonly T[], v: unknown): v is T =>
  typeof v === "string" && (list as readonly string[]).includes(v);
const isPosInt = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 1;

/** Refuse a field whose value is not of its closed type. Names the field, never the value. */
function need(ok: boolean, field: string): void {
  if (!ok) throw new ProofExportError("PROOF_INPUT", `${field} is not a value of its type`);
}

function stepBody(step: ProofStep): { kind: RecordKind; body: RecordBody } {
  const s = step as unknown as Record<string, unknown>;
  switch (step.kind) {
    case "action":
      need(isIn(ACTORS, s.actor), "action.actor");
      need(isStr(s.tool), "action.tool");
      need(isStr(s.summary), "action.summary");
      return {
        kind: "action",
        body: {
          actor: s.actor as ActionBody["actor"],
          tool: closedId(s.tool as string),
          summary: textRef(s.summary as string),
        },
      };
    case "evidence": {
      need(isStr(s.evidenceId), "evidence.evidenceId");
      need(isStr(s.evidenceKind), "evidence.evidenceKind");
      need(isStr(s.mediaType), "evidence.mediaType");
      need(s.path === undefined || isStr(s.path), "evidence.path");
      need(isStr(s.content) || s.content instanceof Uint8Array, "evidence.content");
      const bytes =
        typeof step.content === "string" ? new TextEncoder().encode(step.content) : step.content;
      return {
        kind: "evidence",
        body: {
          evidenceId: closedId(step.evidenceId),
          kind: closedId(step.evidenceKind),
          mediaType: closedMediaType(step.mediaType),
          ...(step.path === undefined ? {} : { path: textRef(step.path) }),
          sha256: sha256Hex(bytes),
          bytes: bytes.byteLength,
        },
      };
    }
    case "verdict": {
      need(isStr(s.taskId), "verdict.taskId");
      need(isStr(s.runId), "verdict.runId");
      need(isIn(VERDICTS, s.verdict), "verdict.verdict");
      need(typeof s.accepted === "boolean", "verdict.accepted");
      need(
        Array.isArray(s.reasonCodes) && s.reasonCodes.every((c) => isIn(REASON_CODES, c)),
        "verdict.reasonCodes",
      );
      need(Array.isArray(s.evidence) && s.evidence.every(isStr), "verdict.evidence");
      const o = s.oracle as Record<string, unknown> | undefined;
      if (o !== undefined) {
        need(o !== null && typeof o === "object", "verdict.oracle");
        need(isStr(o.family), "verdict.oracle.family");
        need(isStr(o.version), "verdict.oracle.version");
        need(isStr(o.specSha256) && HEX64.test(o.specSha256), "verdict.oracle.specSha256");
      }
      return {
        kind: "verdict",
        body: {
          gateApi: GATE_API_VERSION,
          taskId: closedId(s.taskId as string),
          runId: closedId(s.runId as string),
          verdict: s.verdict as VerdictBody["verdict"],
          accepted: s.accepted as boolean,
          reasonCodes: [...(s.reasonCodes as string[])],
          evidence: (s.evidence as string[]).map(closedId),
          ...(o === undefined
            ? {}
            : {
                oracle: {
                  family: closedId(o.family as string),
                  version: closedId(o.version as string),
                  specSha256: o.specSha256 as string,
                },
              }),
        },
      };
    }
    case "checkpoint":
      need(isPosInt(s.checkpoint), "checkpoint.checkpoint");
      need(isIn(CHECKPOINT_VERDICTS, s.verdict), "checkpoint.verdict");
      return {
        kind: "checkpoint",
        body: {
          checkpoint: s.checkpoint as number,
          verdict: s.verdict as CheckpointBody["verdict"],
        },
      };
    case "handoff":
      need(isStr(s.from), "handoff.from");
      need(isStr(s.to), "handoff.to");
      need(isStr(s.summary), "handoff.summary");
      need(s.checkpoint === undefined || isPosInt(s.checkpoint), "handoff.checkpoint");
      return {
        kind: "handoff",
        body: {
          from: closedId(s.from as string),
          to: closedId(s.to as string),
          summary: textRef(s.summary as string),
          ...(s.checkpoint === undefined ? {} : { checkpoint: s.checkpoint as number }),
        },
      };
    case "policy":
      need(isStr(s.policyId), "policy.policyId");
      need(isStr(s.subject), "policy.subject");
      need(isIn(DECISIONS, s.decision), "policy.decision");
      need(isStr(s.reasonCode), "policy.reasonCode");
      return {
        kind: "policy",
        body: {
          policyId: closedId(s.policyId as string),
          subject: closedId(s.subject as string),
          decision: s.decision as PolicyBody["decision"],
          reasonCode: closedCode(s.reasonCode as string),
        },
      };
    default:
      throw new ProofExportError("PROOF_INPUT", "a step of an unknown kind");
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
 * Build a bundle from a run. Every value goes through the allowlist (`stepBody`, `closed.ts`)
 * before it is written. Fails closed: a value of the wrong closed type, a broken or unpinned
 * ledger, a run the verifier would refuse, or anything the backstop scanner flags (with
 * `ctx`) throws instead of producing a bundle.
 */
export function exportProofBundle(input: ProofRunInput, ctx: RedactionContext): ProofBundle {
  const raw = input as unknown as Record<string, unknown>;
  need(isStr(raw.runId), "run.runId");
  need(isStr(raw.taskId), "run.taskId");
  need(raw.arm === undefined || isStr(raw.arm), "run.arm");
  need(typeof raw.simulated === "boolean", "run.simulated");
  need(Array.isArray(raw.steps), "run.steps");
  const items = input.steps.map((s) => {
    need(s !== null && typeof s === "object", "run.steps");
    return stepBody(s);
  });
  let ledger: ProofBundle["ledger"] = null;
  if (input.ledger !== undefined) {
    need(Array.isArray(input.ledger.lines), "ledger.lines");
    need(isStr(input.ledger.trialKey), "ledger.trialKey");
    const { events, head, errors } = verifyLedgerChain(input.ledger.lines);
    if (errors.length > 0) throw new ProofExportError("PROOF_LEDGER_CHAIN", errors.join("; "));
    if (
      head.events !== input.ledger.head?.events ||
      head.headSha256 !== input.ledger.head?.headSha256
    )
      throw new ProofExportError("PROOF_LEDGER_HEAD", "the ledger does not match its pinned head");
    const key = input.ledger.trialKey;
    const start = events.findIndex((e) => e.trialKey === key && e.kind === "start");
    const end = events.findIndex((e) => e.trialKey === key && e.kind === "end");
    const startEvent = events[start];
    if (start < 0 || end < 0 || startEvent === undefined)
      throw new ProofExportError("PROOF_LEDGER_ANCHOR", "the run's trial is not in the ledger");
    items.push({
      kind: "ledger-anchor",
      body: {
        // From the ledger (closed under #518's schema), never from the input.
        trialKey: startEvent.trialKey,
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
    runId: closedId(input.runId),
    taskId: closedId(input.taskId),
    ...(input.arm === undefined ? {} : { arm: closedArm(input.arm) }),
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
  // Self-verify: the closed schemas, the chain, the bindings and the BACKSTOP scanner.
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
  /** Structural: built from closed values and schema field names only. */
  readonly message: string;
}

export interface VerifyOptions {
  /** A bundle head received out of band: the only defense against a regenerated bundle. */
  readonly expectHead?: string;
  /** A ledger head received out of band (for example the pack's pin, recorded host-side). */
  readonly expectLedgerHead?: string;
  /**
   * Recompute evidence digests from the original artifacts here. A file is matched to an
   * evidence record by the digest of its path relative to this directory.
   */
  readonly evidenceDir?: string;
  /** Extra literals the backstop must refuse (the verifying host's own context). */
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
  /** Evidence ids whose digest was recomputed from `evidenceDir`. */
  readonly evidenceRecomputed: readonly string[];
  /** Evidence ids that were not recomputed (no `evidenceDir`, or no path recorded). */
  readonly evidenceDigestOnly: readonly string[];
  /** True when the referenced episode was given and cross-checked. */
  readonly episodeChecked?: boolean;
}

/** At most this many files are indexed under an evidence dir. */
export const EVIDENCE_DIR_FILE_LIMIT = 10_000;

interface EvidenceIndexEntry {
  readonly file?: string;
  readonly escapes: boolean;
}

/**
 * Index the files under `dir` by the digest of their relative path (both `/` and `\`
 * spellings, since the harness may have recorded either). A symlink is followed only to
 * check where it goes: one that resolves outside `dir` is indexed as an escape.
 */
function indexEvidenceDir(dir: string): Map<string, EvidenceIndexEntry> {
  const index = new Map<string, EvidenceIndexEntry>();
  const root = realpathSync(resolve(dir));
  let count = 0;
  const add = (rel: string, entry: EvidenceIndexEntry) => {
    const parts = rel.split(sep);
    index.set(textDigest(parts.join("/")), entry);
    index.set(textDigest(parts.join("\\")), entry);
  };
  const seen = new Set<string>();
  // `escaped`: we are below a symlink that resolves outside `dir`.
  const walk = (abs: string, escaped: boolean) => {
    const real = realpathSync(abs);
    if (seen.has(real)) return;
    seen.add(real);
    for (const name of readdirSync(abs)) {
      if (++count > EVIDENCE_DIR_FILE_LIMIT) return;
      const full = join(abs, name);
      const rel = relative(root, full);
      const st = lstatSync(full);
      if (st.isSymbolicLink()) {
        let target: string;
        try {
          target = realpathSync(full);
        } catch {
          continue;
        }
        const back = relative(root, target);
        const escapes = escaped || back === ".." || back.startsWith(`..${sep}`) || isAbsolute(back);
        const tst = lstatSync(target);
        // A symlinked directory: its files are indexed under the link's own relative path.
        if (tst.isDirectory()) walk(full, escapes);
        else if (tst.isFile()) add(rel, escapes ? { escapes: true } : { file: target, escapes });
      } else if (st.isDirectory()) walk(full, escaped);
      else if (st.isFile()) add(rel, escaped ? { escapes: true } : { file: full, escapes: false });
    }
  };
  walk(root, false);
  return index;
}

/**
 * Verify a serialized bundle. Every digest and chain link is recomputed; any edit, gap,
 * reordering, truncation, unknown field, non-closed value, inflated claim, inconsistent
 * verdict, broken or unbound ledger, or backstop hit is a refusal. `ok` is true only when
 * there is no error. Messages never quote a value from the bundle.
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

  // Backstop first: a value it recognises is refused whatever else is wrong. Every PARSED
  // string value and key is scanned in every decoded form; text that does not parse is
  // scanned as text.
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
    fail(
      "PROOF_REDACTION",
      `the bundle carries ${leaks.length} value(s) the backstop flags: ${kinds}`,
    );
  }
  if (!parseOk) {
    fail("PROOF_SCHEMA", "not JSON");
    return done();
  }
  // Schema paths are built from schema field names and indices only; the validator's own
  // messages (which may quote a value) are never passed on.
  const top = parsed as Record<string, unknown>;
  const claimWrong =
    top !== null && typeof top === "object" && "claim" in top && top.claim !== PROOF_CLAIM;
  if (claimWrong)
    fail("PROOF_CLAIM", "the claim is not the fixed tamper-evidence statement (no stronger claim)");
  const issues = validateSchema(parsed, BUNDLE_SCHEMA).filter(
    (i) => !(claimWrong && i.path === "$.claim"),
  );
  if (issues.length > 0) {
    for (const i of issues.slice(0, 10)) fail("PROOF_SCHEMA", `${i.path} fails ${i.keyword}`);
    return done();
  }
  if (claimWrong) return done();
  const bundle = parsed as ProofBundle;

  // The record chain, seeded with the run header.
  let prev = runGenesis(bundle.run);
  let chainOk = true;
  for (let i = 0; i < bundle.records.length; i++) {
    const r = bundle.records[i] as ProofRecord;
    const bodyIssues = validateSchema(r.body, BODY_SCHEMAS[r.kind], `$.records[${i}].body`);
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
  const index =
    options.evidenceDir === undefined ? undefined : indexEvidenceDir(options.evidenceDir);
  const seenEvidence = new Set<string>();
  for (const r of bundle.records) {
    if (r.kind === "evidence") {
      const e = r.body as EvidenceBody;
      if (seenEvidence.has(e.evidenceId)) fail("PROOF_EVIDENCE", `evidence ${e.evidenceId} twice`);
      seenEvidence.add(e.evidenceId);
      if (index !== undefined && e.path !== undefined) {
        const hit = index.get(e.path.sha256);
        if (hit?.escapes === true)
          fail("PROOF_EVIDENCE", `evidence ${e.evidenceId}: path escapes the evidence dir`);
        else if (hit?.file === undefined || !existsSync(hit.file))
          fail("PROOF_EVIDENCE_MISSING", `evidence ${e.evidenceId}: no file to recompute`);
        else {
          const bytes = readFileSync(hit.file);
          if (sha256Hex(bytes) !== e.sha256 || bytes.byteLength !== e.bytes)
            fail(
              "PROOF_EVIDENCE_DIGEST",
              `evidence ${e.evidenceId}: the file does not match its digest`,
            );
          else recomputed.push(e.evidenceId);
        }
      } else digestOnly.push(e.evidenceId);
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

  // The attempt ledger (#518) and its binding to this run.
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
      else if (
        closedId(s.taskId) !== bundle.run.taskId ||
        closedId(en.taskId) !== bundle.run.taskId
      )
        fail("PROOF_LEDGER_ANCHOR", "the ledger's trial is for another task");
      else if (bundle.run.arm === undefined)
        fail("PROOF_LEDGER_ANCHOR", "a run anchored to a ledger trial must state its arm");
      else if (closedArm(s.arm) !== bundle.run.arm || closedArm(en.arm) !== bundle.run.arm)
        fail("PROOF_LEDGER_ANCHOR", "the ledger's trial is for another arm");
    }
    if (options.expectLedgerHead !== undefined && head.headSha256 !== options.expectLedgerHead)
      fail("PROOF_ANCHOR_MISMATCH", "the ledger head differs from the out-of-band head");
  }

  // The canonical episode this bundle is a container over. Projected values are compared
  // through the same allowlist the exporter applied, so a hashed id still matches.
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
        if (closedId(p.runId) !== bundle.run.runId)
          fail("PROOF_EPISODE", "run.runId differs from the episode");
        if (closedId(p.taskId) !== bundle.run.taskId)
          fail("PROOF_EPISODE", "run.taskId differs from the episode");
        if (closedArm(p.arm) !== bundle.run.arm)
          fail("PROOF_EPISODE", "run.arm differs from the episode");
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
