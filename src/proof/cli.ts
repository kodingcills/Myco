/**
 * Track Q (replayable proof) CLI. Local only: no network, no model, no VM.
 *
 *   npx tsx scripts/proof.ts export RUN.json --out BUNDLE.json [--forbid-file F] [--user-file U]
 *                                   [--identity-file I]
 *   npx tsx scripts/proof.ts verify BUNDLE.json [--expect-head H] [--expect-ledger-head H]
 *                                   [--evidence-dir D] [--episode E] [--forbid-file F]
 *                                   [--user-file U] [--identity-file I]
 *   npx tsx scripts/proof.ts report BUNDLE.json --out REPORT.html [verify flags]
 *
 * RUN.json is a `ProofRunInput` (see bundle.ts) with two file conveniences: an evidence
 * step may give `contentFile` (relative to RUN.json) instead of `content`, and `ledger` may
 * give `attemptsFile` (an `attempts.jsonl`, relative to RUN.json) instead of `lines`, and
 * `episodeFile` (the attempt's `myco.episode/1` JSON, relative to RUN.json) names the
 * episode the bundle references. `--episode E` makes verify/report cross-check it.
 *
 * Export writes closed-type values only (`closed.ts`): no text from RUN.json reaches the
 * bundle, only digests. `--forbid-file` (literals, one per line) and `--user-file` (account
 * names, one per line, matched in any letter case) feed the BACKSTOP scanner: if any of them,
 * or the host's own account name, home, temp or checkout directory, still appears in an
 * output (for example as a closed id equal to the account name), the command fails closed.
 * Neither file's contents are ever printed.
 *
 * Identity guard (#553 r3): export digests any id whose value CONTAINS, case-insensitively,
 * the host's account name, hostname or home directory, a line of `--identity-file I` (a full
 * name, other names: one per line; the file is read, never printed) or a `--user-file` entry,
 * and refuses a ledger id that carries one. Verify and report refuse a bundle with any
 * non-constant string that carries one (`PROOF_IDENTITY`, classes only).
 *
 * Exit codes: 0 ok; 1 refused (verification failed, export refused, report not written);
 * 2 usage. Output is JSON on stdout; it never echoes a redacted value, and is itself scanned
 * before it is printed (a leak there prints only the error codes).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import { findLeaks, type RedactionContext } from "./backstop.ts";
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
import { hostIdentity, type IdentityContext } from "./identity.ts";
import { parseLedgerJsonl } from "./ledger.ts";
import { ProofReportError, renderProofReport } from "./report.ts";

export interface CliIo {
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
}

/** The exporting host's own context: its account name and directories. */
export function hostRedaction(
  extra: readonly string[] = [],
  users: readonly string[] = [],
): RedactionContext {
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
    usernames: [...(username === "" ? [] : [username]), ...users],
  };
}

function parseFlags(args: readonly string[]): { positional: string[]; flags: Map<string, string> } {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a.startsWith("--")) {
      const v = args[i + 1];
      if (v === undefined || v.startsWith("--")) throw new UsageError("a flag needs a value");
      flags.set(a, v);
      i++;
    } else positional.push(a);
  }
  return { positional, flags };
}

class UsageError extends Error {}

/** Each command's flags (exported so the doc test can pin the documented usage). */
export const KNOWN: Record<string, readonly string[]> = {
  export: ["--out", "--forbid-file", "--user-file", "--identity-file"],
  verify: [
    "--expect-head",
    "--expect-ledger-head",
    "--evidence-dir",
    "--episode",
    "--forbid-file",
    "--user-file",
    "--identity-file",
  ],
  report: [
    "--out",
    "--expect-head",
    "--expect-ledger-head",
    "--evidence-dir",
    "--episode",
    "--forbid-file",
    "--user-file",
    "--identity-file",
  ],
};

/** One literal per non-empty line (used for `--forbid-file` and `--user-file`). */
function readLines(path: string | undefined): string[] {
  if (path === undefined) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

function verifyOptions(
  flags: Map<string, string>,
  forbid: readonly string[],
  users: readonly string[],
  identity: IdentityContext,
): VerifyOptions {
  return {
    ...(flags.has("--expect-head") ? { expectHead: flags.get("--expect-head") } : {}),
    ...(flags.has("--expect-ledger-head")
      ? { expectLedgerHead: flags.get("--expect-ledger-head") }
      : {}),
    ...(flags.has("--evidence-dir") ? { evidenceDir: flags.get("--evidence-dir") } : {}),
    ...(flags.has("--episode")
      ? { episode: JSON.parse(readFileSync(flags.get("--episode") as string, "utf8")) }
      : {}),
    redaction: forbidRedaction(forbid, users),
    identity,
  };
}

function forbidRedaction(forbid: readonly string[], users: readonly string[]): RedactionContext {
  return { secrets: [], vaultKeys: [...forbid], hostPaths: [], usernames: [...users] };
}

/**
 * Print a JSON result, after scanning it: if anything in it would leak, print only the
 * error codes (never a message, never a value).
 */
export function emit(io: CliIo, value: unknown, ctx: RedactionContext, pretty = false): void {
  const text = JSON.stringify(value, null, pretty ? 2 : undefined);
  if (findLeaks(text, ctx).length === 0) {
    io.out(`${text}\n`);
    return;
  }
  const v = value as { ok?: unknown; code?: unknown; errors?: Array<{ code?: unknown }> };
  const codes = [
    ...(typeof v.code === "string" ? [v.code] : []),
    ...(v.errors ?? []).map((e) => String(e.code)),
    "PROOF_OUTPUT_REDACTED",
  ];
  io.out(`${JSON.stringify({ ok: false, codes })}\n`);
}

type RawStep =
  | ProofStep
  | (Omit<Extract<ProofStep, { kind: "evidence" }>, "content"> & { contentFile: string });

function loadRunInput(path: string): ProofRunInput {
  const base = dirname(resolve(path));
  const raw = JSON.parse(readFileSync(path, "utf8")) as Omit<ProofRunInput, "steps" | "ledger"> & {
    steps: RawStep[];
    episodeFile?: string;
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
  const { ledger: _raw, episodeFile, ...run } = raw;
  const episode =
    episodeFile === undefined
      ? undefined
      : (JSON.parse(readFileSync(within(episodeFile), "utf8")) as unknown);
  return {
    ...run,
    steps,
    ...(ledger === undefined ? {} : { ledger }),
    ...(episode === undefined ? {} : { episode }),
  };
}

export function main(argv: readonly string[], io: CliIo): number {
  const [command, ...rest] = argv;
  // Every line this CLI prints is scanned with the host's own context first.
  let outCtx: RedactionContext = hostRedaction();
  try {
    if (command === undefined || !(command in KNOWN))
      throw new UsageError("usage: proof.ts export|verify|report ...");
    const { positional, flags } = parseFlags(rest);
    for (const f of flags.keys())
      if (!KNOWN[command]?.includes(f)) throw new UsageError("unknown flag for this command");
    if (positional.length !== 1) throw new UsageError("the command takes exactly one input file");
    const input = positional[0] as string;
    if (!existsSync(input)) throw new UsageError("no such input file");
    const forbid = readLines(flags.get("--forbid-file"));
    const users = readLines(flags.get("--user-file"));
    outCtx = hostRedaction(forbid, users);
    const identityFile = flags.get("--identity-file");
    const identity = hostIdentity({
      ...(identityFile === undefined ? {} : { identityFile }),
      names: users,
    });

    if (command === "export") {
      const out = flags.get("--out");
      if (out === undefined) throw new UsageError("export needs --out");
      const bundle = exportProofBundle(loadRunInput(input), hostRedaction(forbid, users), identity);
      writeFileSync(out, serializeProofBundle(bundle));
      emit(io, { ok: true, head: bundle.head, records: bundle.records.length }, outCtx);
      return 0;
    }

    const text = readFileSync(input, "utf8");
    const options = verifyOptions(flags, forbid, users, identity);
    const result = verifyProofBundle(text, options);
    if (command === "verify") {
      emit(io, result, outCtx, true);
      return result.ok ? 0 : 1;
    }
    const out = flags.get("--out");
    if (out === undefined) throw new UsageError("report needs --out");
    if (!result.ok) {
      emit(io, result, outCtx, true);
      return 1;
    }
    const html = renderProofReport(
      JSON.parse(text) as ProofBundle,
      result,
      options.redaction ?? forbidRedaction(forbid, users),
    );
    writeFileSync(out, html);
    emit(io, { ok: true, head: result.head }, outCtx);
    return 0;
  } catch (error) {
    if (error instanceof UsageError) {
      io.err(`${error.message}\n`);
      return 2;
    }
    if (error instanceof ProofExportError) {
      emit(io, { ok: false, code: error.code, message: error.message }, outCtx);
      return 1;
    }
    if (error instanceof ProofReportError) {
      emit(io, { ok: false, code: "PROOF_REPORT_REFUSED", message: error.message }, outCtx);
      return 1;
    }
    io.err(`proof: ${error instanceof Error ? error.name : "error"}\n`);
    return 1;
  }
}
