/**
 * Track S: the s-v1 pre-registration (capability-spec §3, capability-spec-2 §1.1 and §2 S).
 *
 * `buildSV1Prereg` composes the pre-registration from the authored fields below and hashes
 * computed from the tree: the S bar text as it stands in capability-spec-2, the trg-v1
 * manifest, and the analysis script, its modules and the mutation proof script.
 * `scripts/s-v1-freeze.ts` writes it to `docs/product/capability-prereg/s-v1/prereg.json`.
 *
 * `loadSV1Prereg` is what the analysis trusts. It refuses, with a code, when any of these is
 * true: the pre-registration hash does not match its body; a recorded file's SHA-256 no longer
 * matches the tree (the analysis or corpus changed after the freeze); the S bar in the spec no
 * longer reads as frozen; or the committed corpus does not match its manifest.
 *
 * The pre-registration hash is the SHA-256 of the canonical JSON of `preregistration`.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type SV1Frozen, SV1RefusalError } from "./analysis.ts";
import { canonicalJson, sha256Hex } from "./canonical.ts";
import { manifestSha256, TRG_VERSION, type TrgCase, type TrgManifest } from "./trg-v1.ts";

export const PREREG_SCHEMA = "myco.capability-prereg/1" as const;
export const PREREG_PATH = "docs/product/capability-prereg/s-v1/prereg.json";
export const SPEC_PATH = "docs/product/capability-spec-2.md";
export const CORPUS_DIR = "benchmark/schedule/trg-v1";
export const CASES_PATH = `${CORPUS_DIR}/cases.jsonl`;
export const MANIFEST_PATH = `${CORPUS_DIR}/manifest.json`;
export const ANALYSIS_SCRIPT = "scripts/s-v1-analysis.ts";
export const ANALYSIS_MODULES = [
  "src/schedule/conformance/analysis.ts",
  "src/schedule/conformance/canonical.ts",
  "src/schedule/conformance/prereg.ts",
] as const;
export const CORPUS_BUILDER = "src/schedule/conformance/trg-v1.ts";
export const MUTATION_SCRIPT = "scripts/schedule-mutation-proof.py";
/** Mutants in MUTATION_SCRIPT at the freeze (#536's proof grew from 38 to 56 in review). */
export const MUTANT_COUNT = 56;

const S_HEADING = "### S. Scheduled and triggered runs";
const BAR_START = "**Pre-registered bar (property, all must hold).**";
const BAR_END = "**Guardrails.**";

/** The S bar exactly as written in capability-spec-2 §2 S, from its heading to Guardrails. */
export function extractSBar(specText: string): string {
  const s = specText.indexOf(S_HEADING);
  if (s < 0) throw new SV1RefusalError("SPEC_S_SECTION_MISSING");
  const a = specText.indexOf(BAR_START, s);
  const b = a < 0 ? -1 : specText.indexOf(BAR_END, a);
  if (a < 0 || b < 0) throw new SV1RefusalError("SPEC_S_BAR_MISSING");
  return specText.slice(a, b).trimEnd();
}

export interface FileRef {
  readonly path: string;
  readonly sha256: string;
}

export interface SV1Preregistration {
  readonly track: "S";
  readonly version: "s-v1";
  readonly capability: string;
  readonly status: string;
  readonly spec: {
    readonly source: string;
    readonly sharedRules: readonly string[];
    readonly barKind: "property";
  };
  readonly bar: {
    readonly text: string;
    readonly sha256: string;
    readonly passRule: readonly string[];
  };
  readonly primaryMetric: string;
  readonly secondary: readonly string[];
  readonly corpus: {
    readonly version: typeof TRG_VERSION;
    readonly manifest: FileRef;
    readonly manifestSha256: string;
    readonly cases: FileRef;
    readonly counts: TrgManifest["counts"];
    readonly deferred: TrgManifest["deferred"];
    readonly builder: FileRef;
  };
  readonly seeds: {
    readonly caseOrder: string;
    readonly marker: string;
    readonly taskBuild: null;
    readonly note: string;
  };
  readonly stepBudget: null;
  readonly stepBudgetNote: string;
  readonly modelId: null;
  readonly modelIdNote: string;
  readonly executor: string;
  readonly analysis: {
    readonly script: FileRef;
    readonly modules: readonly FileRef[];
    readonly command: string;
  };
  readonly mutationProof: {
    readonly script: FileRef;
    readonly mutants: number;
    readonly command: string;
  };
  readonly evidence: {
    readonly evidence: false;
    readonly simulated: true;
    readonly r1Evidence: false;
    readonly note: string;
  };
  readonly constraints: readonly string[];
  readonly notPreregisteredHere: readonly string[];
  readonly leadRulingPending: readonly string[];
}

export interface SV1PreregFile {
  readonly schema: typeof PREREG_SCHEMA;
  readonly preregistration: SV1Preregistration;
  readonly preregSha256: string;
}

const fileRef = (root: string, path: string): FileRef => ({
  path,
  sha256: sha256Hex(readFileSync(join(root, path))),
});

export function preregSha256(p: SV1Preregistration): string {
  return sha256Hex(canonicalJson(p));
}

/** Compose the pre-registration from the tree. Deterministic for a given tree. */
export function buildSV1Prereg(root: string): SV1PreregFile {
  const barText = extractSBar(readFileSync(join(root, SPEC_PATH), "utf8"));
  const manifest = JSON.parse(readFileSync(join(root, MANIFEST_PATH), "utf8")) as TrgManifest;
  const preregistration: SV1Preregistration = {
    track: "S",
    version: "s-v1",
    capability: "Scheduled and triggered runs",
    status:
      "frozen before any conformance run; the bar is the spec's proposal, lead ruling pending (not ratified)",
    spec: {
      source: `${SPEC_PATH} §2 S`,
      sharedRules: [
        "docs/product/capability-spec.md §1 (shared rules), §3 (pre-registration), §4 (constraints)",
        `${SPEC_PATH} §1.1 (property bars), §1.5 (labels), §4 (evidence)`,
      ],
      barKind: "property",
    },
    bar: {
      text: barText,
      sha256: sha256Hex(barText),
      passRule: [
        "Every in-scope trg-v1 case matches its expected outcome: 100%, with the case count stated; one counterexample fails the bar.",
        "Every out-of-scope trg-v1 case matches its stated outcome (the limit is tested, not hidden); a mismatch fails the bar.",
        "0 bypasses over the in-scope runs; 0 double runs, 0 runs while paused, 0 accepted rows without verified + ORACLE_PASS, 0 evidence rows, 0 concurrency overruns, 0 ledger chain failures and 0 planted-marker leaks in every case.",
        `The mutation report lists exactly ${MUTANT_COUNT} mutants with unique labels, and every one is killed.`,
        "Anything else reads 'not shown', with codes; input that cannot be analysed is refused, never analysed.",
      ],
    },
    primaryMetric:
      "Bypasses: in-scope triggered runs that started without an allow from every policy, without a gate bound to exactly one trial, without passing their budget checks, or without exactly one chained ledger row; over all in-scope runs.",
    secondary: [
      "Schedule latency (reported, not gating).",
      "Skipped and missed counts (reported, not gating).",
      "Failure-notification recall (reported; the expected notification count is also checked per case).",
    ],
    corpus: {
      version: TRG_VERSION,
      manifest: fileRef(root, MANIFEST_PATH),
      manifestSha256: manifestSha256(manifest),
      cases: fileRef(root, CASES_PATH),
      counts: manifest.counts,
      deferred: manifest.deferred,
      builder: fileRef(root, CORPUS_BUILDER),
    },
    seeds: {
      caseOrder: "s-v1-case-order-2026-11-27-q7Tn",
      marker: "s-v1-marker-2026-11-27-Lw3c",
      taskBuild: null,
      note: "caseOrder fixes the order the runner executes cases in (one shuffled pass, to expose state leaking between cases); marker derives the planted marker values; the corpus build has no randomness, so there is no task-build seed.",
    },
    stepBudget: null,
    stepBudgetNote:
      "Not applicable: a property bar has no agent arm (spec-2 §2 S, Arms: none). The scripted executor takes no agent steps.",
    modelId: null,
    modelIdNote:
      "Not applicable: conformance runs use the $0 scripted executor, no model. The secondary unattended-completion experiment (#536 P1/P2), if the lead orders it, is pre-registered separately with its model id.",
    executor:
      "The scripted executor only (src/schedule/executor.ts scripted transport, through the real gate on fc-v1 tasks): $0, no model, no VM, no VM lock. Never a real trial.",
    analysis: {
      script: fileRef(root, ANALYSIS_SCRIPT),
      modules: ANALYSIS_MODULES.map((p) => fileRef(root, p)),
      command:
        "npx tsx scripts/s-v1-analysis.ts --results <results.json> --mutation-log <mutation-proof output>",
    },
    mutationProof: {
      script: fileRef(root, MUTATION_SCRIPT),
      mutants: MUTANT_COUNT,
      command: "python3 scripts/schedule-mutation-proof.py > <mutation-proof output>",
    },
    evidence: {
      evidence: false,
      simulated: true,
      r1Evidence: false,
      note: "Property-bar rows come from scripted runs: they prove the mechanism, never agent capability, are never mixed into a capability statistic and never count as R1 evidence (spec-2 §1.1, §1.5; capability-spec §3.4-3.5).",
    },
    constraints: [
      "No real trial, no Windows VM, no VM lock: a trigger never starts a Windows VM run on its own; S-live must check the VM lock and the critical-path window and record a skip.",
      "$0 Anthropic API: no Messages-API calls, no API key.",
      "Gate guarantees unchanged: myco.gate/v1 takes taskId, runId and claim only; agent-facing reasons stay codes only.",
      "Changes after the first conformance run make s-v2; runs under s-v1 stay reported under s-v1 (capability-spec §3.3).",
    ],
    notPreregisteredHere: [
      "#536's P1/P2 unattended-completion experiment (spec-2 §2 S: a secondary experiment, not this bar).",
      "The vm-lock-held case: deferred to the corpus version that ships S-live.",
    ],
    leadRulingPending: [
      "Ratification of S's property bar itself (spec-2 status: every bar is a proposal).",
      "Spec-2 §6: property bar for S, with #536's P1/P2 as a secondary experiment rather than part of S's decision.",
      "Proposed here: an out-of-scope case that does not match its stated outcome fails the bar (stricter than 'reported').",
      "Proposed here: the ledger-write-fails case is out of scope for bar item 1 (no chained row can be written when storage fails); its fail-closed report is still checked.",
    ],
  };
  return { schema: PREREG_SCHEMA, preregistration, preregSha256: preregSha256(preregistration) };
}

/** The committed prereg file's text, as the freeze script writes it. */
export function preregFileText(p: SV1PreregFile): string {
  return `${JSON.stringify(p, null, 2)}\n`;
}

export interface LoadedSV1 {
  readonly frozen: SV1Frozen;
  readonly corpus: readonly TrgCase[];
  readonly prereg: SV1PreregFile;
}

const refuse = (code: string): never => {
  throw new SV1RefusalError(code);
};

/** Load and verify the committed pre-registration and corpus against the tree. */
export function loadSV1Prereg(root: string): LoadedSV1 {
  let file: SV1PreregFile;
  try {
    file = JSON.parse(readFileSync(join(root, PREREG_PATH), "utf8")) as SV1PreregFile;
  } catch {
    return refuse("PREREG_UNREADABLE");
  }
  if (file?.schema !== PREREG_SCHEMA || typeof file.preregistration !== "object")
    refuse("PREREG_SCHEMA");
  const p = file.preregistration;
  if (preregSha256(p) !== file.preregSha256) refuse("PREREG_HASH_MISMATCH");

  const check = (ref: FileRef | undefined, code: string) => {
    let actual: string;
    try {
      actual = ref ? fileRef(root, ref.path).sha256 : "";
    } catch {
      return refuse(code);
    }
    if (!ref || actual !== ref.sha256) refuse(code);
  };
  check(p.analysis?.script, "ANALYSIS_SCRIPT_CHANGED");
  if (!Array.isArray(p.analysis?.modules) || p.analysis.modules.length !== ANALYSIS_MODULES.length)
    refuse("ANALYSIS_MODULE_CHANGED");
  for (const m of p.analysis.modules) check(m, "ANALYSIS_MODULE_CHANGED");
  check(p.mutationProof?.script, "MUTATION_SCRIPT_CHANGED");
  check(p.corpus?.manifest, "CORPUS_CHANGED");
  check(p.corpus?.cases, "CORPUS_CHANGED");
  check(p.corpus?.builder, "CORPUS_CHANGED");

  const bar = extractSBar(readFileSync(join(root, SPEC_PATH), "utf8"));
  if (bar !== p.bar?.text || sha256Hex(bar) !== p.bar.sha256) refuse("SPEC_BAR_CHANGED");

  const manifest = JSON.parse(readFileSync(join(root, MANIFEST_PATH), "utf8")) as TrgManifest;
  if (manifestSha256(manifest) !== p.corpus.manifestSha256) refuse("CORPUS_CHANGED");
  const casesText = readFileSync(join(root, CASES_PATH), "utf8");
  if (sha256Hex(casesText) !== manifest.files["cases.jsonl"]) refuse("CORPUS_CHANGED");
  const corpus = casesText
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as TrgCase);
  if (corpus.length !== manifest.counts.total) refuse("CORPUS_CHANGED");

  return {
    frozen: {
      preregSha256: file.preregSha256,
      corpusVersion: p.corpus.version,
      manifestSha256: p.corpus.manifestSha256,
      mutationScriptSha256: p.mutationProof.script.sha256,
      mutantCount: p.mutationProof.mutants,
    },
    corpus,
    prereg: file,
  };
}

/**
 * Parse `scripts/schedule-mutation-proof.py`'s output ("label | file | status" per mutant, then
 * a summary line) into a mutation report bound to the script's SHA-256.
 */
export function parseMutationLog(text: string, scriptSha256: string) {
  const rows: { label: string; status: string }[] = [];
  for (const line of text.split("\n")) {
    const parts = line.split(" | ");
    if (parts.length !== 3) continue;
    const [label, , status] = parts as [string, string, string];
    rows.push({ label, status: status.trim() });
  }
  return { schema: "myco.schedule.mutation-report/1" as const, scriptSha256, rows };
}
