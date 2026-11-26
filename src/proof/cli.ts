/**
 * Track Q (replayable proof) CLI. Local only: no network, no model, no VM.
 *
 *   npx tsx scripts/proof.ts export RUN.json --out BUNDLE.json [--forbid-file F]
 *   npx tsx scripts/proof.ts verify BUNDLE.json [--expect-head H] [--expect-ledger-head H]
 *                                   [--evidence-dir D] [--forbid-file F]
 *   npx tsx scripts/proof.ts report BUNDLE.json --out REPORT.html [verify flags]
 *
 * RUN.json is a `ProofRunInput` (see bundle.ts) with two file conveniences: an evidence
 * step may give `contentFile` (relative to RUN.json) instead of `content`, and `ledger` may
 * give `attemptsFile` (an `attempts.jsonl`, relative to RUN.json) instead of `lines`.
 * `--forbid-file` names a file of extra literals to redact and refuse, one per line (for
 * example vault key names); its contents are never printed.
 *
 * Exit codes: 0 ok; 1 refused (verification failed, export refused, report not written);
 * 2 usage. Output is JSON on stdout; it never echoes a redacted value.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import {
  exportProofBundle,
  type ProofBundle,
  ProofExportError,
  type ProofRunInput,
  type ProofStep,
  serializeProofBundle,
  type VerifyOptions,
  verifyProofBundle,
} from "./bundle.ts";
import { parseLedgerJsonl } from "./ledger.ts";
import type { RedactionContext } from "./redact.ts";
import { renderProofReport } from "./report.ts";

export interface CliIo {
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
}

/** The exporting host's own context: its account name and directories. */
export function hostRedaction(extra: readonly string[] = []): RedactionContext {
  let username = "";
  try {
    username = userInfo().username;
  } catch {
    username = "";
  }
  return {
    secrets: [],
    vaultKeys: [...extra],
    hostPaths: [homedir(), tmpdir(), process.cwd()].filter((p) => p.length > 1),
    usernames: username === "" ? [] : [username],
  };
}

function parseFlags(args: readonly string[]): { positional: string[]; flags: Map<string, string> } {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a.startsWith("--")) {
      const v = args[i + 1];
      if (v === undefined || v.startsWith("--")) throw new UsageError(`${a} needs a value`);
      flags.set(a, v);
      i++;
    } else positional.push(a);
  }
  return { positional, flags };
}

class UsageError extends Error {}

const KNOWN: Record<string, readonly string[]> = {
  export: ["--out", "--forbid-file"],
  verify: ["--expect-head", "--expect-ledger-head", "--evidence-dir", "--forbid-file"],
  report: ["--out", "--expect-head", "--expect-ledger-head", "--evidence-dir", "--forbid-file"],
};

function readForbid(path: string | undefined): string[] {
  if (path === undefined) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

function verifyOptions(flags: Map<string, string>, forbid: readonly string[]): VerifyOptions {
  return {
    ...(flags.has("--expect-head") ? { expectHead: flags.get("--expect-head") } : {}),
    ...(flags.has("--expect-ledger-head")
      ? { expectLedgerHead: flags.get("--expect-ledger-head") }
      : {}),
    ...(flags.has("--evidence-dir") ? { evidenceDir: flags.get("--evidence-dir") } : {}),
    redaction: { secrets: [], vaultKeys: [...forbid], hostPaths: [], usernames: [] },
  };
}

type RawStep =
  | ProofStep
  | (Omit<Extract<ProofStep, { kind: "evidence" }>, "content"> & { contentFile: string });

function loadRunInput(path: string): ProofRunInput {
  const base = dirname(resolve(path));
  const raw = JSON.parse(readFileSync(path, "utf8")) as Omit<ProofRunInput, "steps" | "ledger"> & {
    steps: RawStep[];
    ledger?: {
      attemptsFile?: string;
      lines?: unknown[];
      head: { events: number; headSha256: string };
      trialKey: string;
    };
  };
  const within = (rel: string) => {
    if (isAbsolute(rel)) throw new UsageError("file references in RUN.json must be relative");
    return resolve(base, rel);
  };
  const steps: ProofStep[] = raw.steps.map((s) => {
    if (s.kind === "evidence" && "contentFile" in s) {
      const { contentFile, ...rest } = s;
      return { ...rest, content: new Uint8Array(readFileSync(within(contentFile))) };
    }
    return s as ProofStep;
  });
  let ledger: ProofRunInput["ledger"];
  if (raw.ledger !== undefined) {
    let lines = raw.ledger.lines;
    if (raw.ledger.attemptsFile !== undefined) {
      const parsed = parseLedgerJsonl(readFileSync(within(raw.ledger.attemptsFile), "utf8"));
      if (parsed.errors.length > 0)
        throw new ProofExportError("PROOF_LEDGER_CHAIN", parsed.errors.join("; "));
      lines = parsed.lines;
    }
    ledger = { lines: lines ?? [], head: raw.ledger.head, trialKey: raw.ledger.trialKey };
  }
  const { ledger: _raw, ...run } = raw;
  return { ...run, steps, ...(ledger === undefined ? {} : { ledger }) };
}

export function main(argv: readonly string[], io: CliIo): number {
  const [command, ...rest] = argv;
  try {
    if (command === undefined || !(command in KNOWN))
      throw new UsageError("usage: proof.ts export|verify|report ...");
    const { positional, flags } = parseFlags(rest);
    for (const f of flags.keys())
      if (!KNOWN[command]?.includes(f)) throw new UsageError(`unknown flag ${f} for ${command}`);
    if (positional.length !== 1) throw new UsageError(`${command} takes exactly one input file`);
    const input = positional[0] as string;
    if (!existsSync(input)) throw new UsageError(`no such file: ${command} input`);
    const forbid = readForbid(flags.get("--forbid-file"));

    if (command === "export") {
      const out = flags.get("--out");
      if (out === undefined) throw new UsageError("export needs --out");
      const bundle = exportProofBundle(loadRunInput(input), hostRedaction(forbid));
      writeFileSync(out, serializeProofBundle(bundle));
      io.out(
        `${JSON.stringify({ ok: true, head: bundle.head, records: bundle.records.length })}\n`,
      );
      return 0;
    }

    const text = readFileSync(input, "utf8");
    const result = verifyProofBundle(text, verifyOptions(flags, forbid));
    if (command === "verify") {
      io.out(`${JSON.stringify(result, null, 2)}\n`);
      return result.ok ? 0 : 1;
    }
    const out = flags.get("--out");
    if (out === undefined) throw new UsageError("report needs --out");
    if (!result.ok) {
      io.out(`${JSON.stringify(result, null, 2)}\n`);
      return 1;
    }
    writeFileSync(out, renderProofReport(JSON.parse(text) as ProofBundle, result));
    io.out(`${JSON.stringify({ ok: true, head: result.head })}\n`);
    return 0;
  } catch (error) {
    if (error instanceof UsageError) {
      io.err(`${error.message}\n`);
      return 2;
    }
    if (error instanceof ProofExportError) {
      io.out(`${JSON.stringify({ ok: false, code: error.code, message: error.message })}\n`);
      return 1;
    }
    io.err(`proof: ${error instanceof Error ? error.name : "error"}\n`);
    return 1;
  }
}
