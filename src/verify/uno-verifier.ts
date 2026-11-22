/**
 * Independent UNO verifier for calc-record-edit, host-side (M1-007 / TIF-11).
 *
 * ADR-0002: the verifier reads only UNO object-model state and the persisted
 * file, never the runner's or adapter's claims. Expected values come from
 * host-side ground truth (fixtureSeed + intent params). Verdicts are
 * three-valued; "could not look" (agent unreachable, UNO error, unreadable
 * file) is `uncertain`, never `refuted`, never `verified`.
 *
 * Three independent checks (docs/architecture/m1.md, "smallest rigorous slice"):
 *   (a) edit landed — read-only UNO readback of the live document;
 *   (b) save state — XModifiable.isModified() (cheap missed-save catch);
 *   (c) edit persisted — headless `soffice --convert-to csv` with an isolated
 *       profile + nonce outdir (stale-output guard), read back via read_file,
 *       parsed with the existing CSV persisted-state reader. Dependency-free;
 *       no in-process xlsx parser.
 *
 * The verifier NEVER writes to the document. `uno_eval` is read-only by
 * contract; the only ops it issues are ping, uno_eval, launch (soffice
 * convert), and read_file — no mutating op is in its vocabulary.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCsvSpreadsheet } from "../core/filepersist.ts";
import type { PersistedState, TaskIntent, Verdict } from "../core/verify.ts";
import { calcRecordEditVerifier, normalizeParams } from "../tasks/calc-record-edit.ts";
import { groundTruth } from "../tasks/intent.ts";
import {
  type AgentClient,
  AgentOpError,
  AgentUnreachableError,
  type UnoEvalResult,
} from "../win/agent-client.ts";

// ---------------------------------------------------------------------------
// Verifier inputs (everything except the agent client is injected for tests)
// ---------------------------------------------------------------------------

/** Read-only UNO readback of the live document. */
export interface UnoReader {
  cellState(sheet: string, cell: string): Promise<UnoEvalResult>;
  isModified(): Promise<boolean>;
}

/** Read-only file access through the agent (and launch of a converter). */
export interface GuestFileReader {
  /** Convert `xlsxPath` to CSV via headless soffice in the guest, return CSV bytes. */
  readCsvViaSoffice(xlsxPath: string): Promise<Buffer>;
}

/**
 * Close the live document before reading the persisted file (check (c)).
 * Not a UNO call — `uno_eval` is read-only by contract — so it is an injected
 * seam the caller wires (agent kill/relaunch, or the program's own close).
 * Failure is `uncertain`, never a guess.
 */
export interface DocumentCloser {
  close(): Promise<void>;
}

/** The agent client implements both read-only seams. */
export class AgentUnoReader implements UnoReader {
  constructor(
    private readonly client: AgentClient,
    /** UNO accept socket of the live document (required by the deployed agent). */
    private socket?: string,
  ) {}

  cellState(sheet: string, cell: string): Promise<UnoEvalResult> {
    // The deployed agent resolves the sheet by name and falls back to the
    // ActiveSheet when none is given. A converted fixture's first sheet is
    // named after the CSV file, not "Sheet1", so pass no sheet: the trial
    // has exactly one open document and its active sheet is the fixture.
    void sheet;
    return this.client.unoEval({ call: "get_string", cell, socket: this.socket });
  }

  isModified(): Promise<boolean> {
    return this.client
      .unoEval({ call: "is_modified", socket: this.socket })
      .then((r) => unoResultModified(r));
  }

  setSocket(socket: string | undefined): void {
    this.socket = socket;
  }
}

/**
 * The deployed agent returns `{call, cell, value}` from uno_eval (pinned by
 * agent/tests/test_agent.py); the host-side `UnoEvalResult` shape is
 * `{get_string, is_modified}`. Accept both (additive, M1-013): a boolean
 * `value` is the deployed agent's is_modified.
 */
function unoResultModified(result: UnoEvalResult): boolean {
  const raw = result as Record<string, unknown>;
  if (typeof raw.is_modified === "boolean") return raw.is_modified;
  if (typeof raw.value === "boolean") return raw.value;
  if (raw.value === 1 || raw.value === "True") return true;
  return false;
}

/** Same dual-shape rule for the string readback (check (a)). */
function unoResultString(result: UnoEvalResult): string {
  const raw = result as Record<string, unknown>;
  if (typeof raw.get_string === "string") return raw.get_string;
  if (typeof raw.value === "string") return raw.value;
  return "";
}

export interface SofficeDeps {
  launch(argv: readonly string[], cwd?: string): Promise<number>;
  readFile(path: string): Promise<Buffer>;
}

/** Per-verifier-invocation nonce: prevents reading a stale CSV from a prior convert. */
function nonce(): string {
  return `myco-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

/**
 * Convert the persisted `.xlsx` to CSV in the guest with a separate,
 * throwaway user profile (`-env:UserInstallation`) so the headless convert
 * cannot touch the interactive Calc instance's profile, then read the CSV
 * bytes back via `read_file`. The output directory is a fresh nonce dir, so
 * `--convert-to` can never silently return a previous run's CSV.
 */
export async function sofficeCsvBytes(
  deps: SofficeDeps,
  xlsxPath: string,
  soffice = "soffice.com",
  guestTempDir = "C:\\Users\\myco\\AppData\\Local\\Temp",
  pollTimeoutMs = 60_000,
): Promise<Buffer> {
  const outDir = `${guestTempDir}\\${nonce()}`;
  const profile = `${guestTempDir}\\${nonce()}\\profile`;
  await deps.launch([
    soffice,
    "--headless",
    "--norestore",
    `-env:UserInstallation=file:///${profile.replaceAll("\\", "/")}`,
    "--convert-to",
    "csv:Text - txt - csv (StarCalc):44,34,76,1,,0,false,true,true,false,false,0",
    "--outdir",
    outDir,
    xlsxPath,
  ]);
  // The headless convert is asynchronous relative to the fire-and-forget
  // `launch` op: poll for the output CSV (bounded) instead of reading once.
  // A nonce outDir guarantees a poll hit is THIS conversion's output.
  const base = xlsxPath.replaceAll("\\", "/").split("/").pop() ?? "";
  const csvName = base.endsWith(".xlsx") ? `${base.slice(0, -5)}.csv` : `${base}.csv`;
  const csvPath = `${outDir}\\${csvName}`;
  const deadline = Date.now() + pollTimeoutMs;
  for (;;) {
    try {
      return await deps.readFile(csvPath);
    } catch (error) {
      if (Date.now() >= deadline) {
        throw new Error(
          `headless csv convert did not produce ${csvPath} within ${pollTimeoutMs}ms — ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 500));
    }
  }
}

// ---------------------------------------------------------------------------
// Verifier
// ---------------------------------------------------------------------------

export interface UnoVerifierDeps {
  uno: UnoReader;
  files: GuestFileReader;
  closer?: DocumentCloser;
}

/** Sheet name Calc assigns to the first sheet. */
export const FIRST_SHEET = "Sheet1";

function uncertain(reason: string): Verdict {
  return { status: "uncertain", reasons: [reason] };
}

function refuted(reason: string): Verdict {
  return { status: "refuted", reasons: [reason] };
}

/**
 * The independent UNO verifier. Not a `Verifier` in the src/core/verify.ts
 * sense (that contract is a pure function over an already-parsed
 * PersistedState); this one OWNS the acquisition of persisted state via the
 * agent's read-only ops, then delegates the ground-truth comparison to the
 * family verifier over the CSV it converted.
 */
export class UnoVerifier {
  private readonly uno: UnoReader;
  private readonly files: GuestFileReader;
  private readonly closer: DocumentCloser | undefined;
  /** Every op issued, so tests can prove only read-only ops were used. */
  readonly opsIssued: string[] = [];

  constructor(deps: UnoVerifierDeps) {
    this.uno = deps.uno;
    this.files = deps.files;
    this.closer = deps.closer;
  }

  async verify(intent: TaskIntent, xlsxPath: string): Promise<Verdict> {
    const params = normalizeParams(intent.params);
    let expected: string;
    let cellRef: string;
    try {
      const gt = groundTruth(params);
      expected = gt.expectedValue;
      cellRef = gt.cellRef;
    } catch (error) {
      return uncertain(
        `could not look: ground truth not computable from intent params — ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    // --- (a) edit landed: live UNO readback (read-only) ---------------------
    let live: string;
    try {
      this.opsIssued.push("uno_eval");
      const r = await this.uno.cellState(FIRST_SHEET, cellRef);
      live = unoResultString(r);
    } catch (error) {
      // UNO unreachable / errored: could not look — never refuted, never verified.
      return uncertain(
        `could not look: UNO readback of ${cellRef} failed — ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (live !== expected) {
      return refuted(`cell ${cellRef} expected "${expected}" but live document has "${live}"`);
    }

    // --- (b) save state: isModified (cheap missed-save catch) ---------------
    let modified: boolean;
    try {
      this.opsIssued.push("uno_eval");
      modified = await this.uno.isModified();
    } catch (error) {
      return uncertain(
        `could not look: XModifiable.isModified() failed — ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (modified) {
      return refuted(`document still modified (isModified=true): the edit was never saved`);
    }

    // --- (c) edit persisted: close the document, then parse the file --------
    if (this.closer) {
      try {
        await this.closer.close();
      } catch (error) {
        return uncertain(
          `could not look: failed to close the live document — ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    // --- (c) edit persisted: convert + parse the persisted file -------------
    const readback = await this.readPersisted(xlsxPath);
    if ("error" in readback) return uncertain(readback.error);
    return calcRecordEditVerifier.verify(readback, intent);
  }

  /** Read the disk state even when an earlier live check ended verification. */
  async readPersisted(xlsxPath: string): Promise<PersistedState | { error: string }> {
    let csv: Buffer;
    try {
      this.opsIssued.push("launch", "read_file");
      csv = await this.files.readCsvViaSoffice(xlsxPath);
    } catch (error) {
      return {
        error: `could not look: persisted file not convertible/readable — ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    try {
      return parseCsvBytes(csv, xlsxPath);
    } catch (error) {
      return {
        error: `could not look: persisted CSV unparseable — ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
}

/** Parse converted CSV bytes with the existing persisted-state reader. */
function parseCsvBytes(csv: Buffer, xlsxPath: string): PersistedState {
  const dir = mkdtempSync(join(tmpdir(), "myco-uno-verify-"));
  const tmp = join(dir, "persisted.csv");
  try {
    writeFileSync(tmp, csv);
    const parsed = readCsvSpreadsheet(tmp);
    return { ...parsed, filePath: xlsxPath };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Wire an UnoVerifier directly over an AgentClient. `socket` is the UNO
 * accept socket of the live document; the deployed agent requires it.
 */
export function unoVerifierOverAgent(
  client: AgentClient,
  socket?: string,
  convertPollTimeoutMs = 60_000,
): UnoVerifier {
  const deps: SofficeDeps = {
    launch: (argv: readonly string[], cwd?: string) => client.launch(argv, cwd),
    readFile: (path: string) => client.readFile(path),
  };
  const files: GuestFileReader = {
    readCsvViaSoffice: (xlsxPath) =>
      sofficeCsvBytes(deps, xlsxPath, undefined, undefined, convertPollTimeoutMs),
  };
  const reader = new AgentUnoReader(client, socket);
  return new UnoVerifier({ uno: reader, files });
}

export { AgentOpError, AgentUnreachableError };
