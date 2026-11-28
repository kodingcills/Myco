/**
 * Windows FixtureConverter (M1-013 / TIF-17): the real implementation of the
 * src/tasks/fixture.ts seam. The host generates the deterministic CSV
 * guest-side via `write_file`, then a headless `soffice --convert-to xlsx`
 * with an isolated throwaway user profile lands the `.xlsx` at a known guest
 * path — the smoke-test pattern (docs/env/windows.md §Live environment).
 *
 * The convert must NOT use the interactive Calc instance's profile, or the
 * headless convert would fight the GUI instance over the profile lock. Same
 * `-env:UserInstallation` isolation the verifier uses for its CSV readback.
 */

import { loadavg } from "node:os";
import type { FixtureConverter } from "../tasks/fixture.ts";
import type { AgentClient } from "../win/agent-client.ts";

export interface WindowsFixtureConverterOptions {
  client: AgentClient;
  /** Guest dir fixtures land in; must exist (the caller creates C:\myco\runs). */
  guestDir: string;
  /** Guest dir for the throwaway convert profile. */
  profileDir?: string;
  /** Timeout for the convert round-trip, ms. */
  timeoutMs?: number;
  /** Host load-average reader (TESTS ONLY seam; defaults to `os.loadavg`). */
  loadAverage?: () => number[];
}

/**
 * Machine-readable record of the last convert (M1-013, convert-timeout decision):
 * how long the workbook took to appear in the guest, against which deadline.
 * `arrived` = the xlsx was readable before the deadline; `deadline` = it never
 * appeared in time; `error` = writing the CSV or launching soffice failed.
 * `durationMs` is wall time and can exceed `deadlineMs` on a miss: the deadline is
 * checked before each poll, so one in-flight `read_file` (up to its own RPC timeout)
 * may finish after the deadline passes.
 *
 * `hostLoadStart` / `hostLoadEnd` (TIF-219) are the host's 1-minute load average when
 * the convert began and when it ended, so a slow or missed convert can be attributed to
 * host CPU starvation (the guest's QEMU competes for the same cores) or ruled out.
 */
export interface ConvertTiming {
  deadlineMs: number;
  durationMs: number;
  outcome: "arrived" | "deadline" | "error";
  /** Host 1-minute load at convert start; `null` if it could not be read. */
  hostLoadStart: number | null;
  /** Host 1-minute load at the last timing update; `null` if it could not be read. */
  hostLoadEnd: number | null;
}

/**
 * Host 1-minute load average, two decimals, or `null`. Diagnostic only: it never
 * feeds a verdict, so a failed or nonsensical read must never fail a convert
 * (TIF-219 round-1 finding D1).
 */
function hostLoad1m(read: () => number[]): number | null {
  try {
    const value = read()[0];
    return typeof value === "number" && Number.isFinite(value) && value >= 0
      ? Math.round(value * 100) / 100
      : null;
  } catch {
    return null;
  }
}

interface ConvertResult {
  xlsxPath: string;
  guestCsvPath: string;
}

/** Per-invocation nonce: a stale xlsx from a prior convert can never be read. */
function nonce(): string {
  return `myco-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

export class WindowsFixtureConverter implements FixtureConverter {
  readonly format = "xlsx" as const;
  readonly #client: AgentClient;
  readonly #guestDir: string;
  readonly #profileDir: string;
  readonly #timeoutMs: number;
  readonly #loadAverage: () => number[];
  #lastConvert: ConvertResult | null = null;
  #lastTiming: ConvertTiming | null = null;
  /** Set before the first await so a half-failed convert can still be cleaned. */
  #lastDirs: { runDir: string; profile: string } | null = null;

  constructor(options: WindowsFixtureConverterOptions) {
    this.#client = options.client;
    this.#guestDir = options.guestDir.replaceAll("\\", "/").replace(/\/$/, "");
    this.#profileDir = options.profileDir ?? `${this.#guestDir}/profiles`;
    this.#timeoutMs = options.timeoutMs ?? 60_000;
    this.#loadAverage = options.loadAverage ?? loadavg;
  }

  /**
   * Write `csvBytes` into the guest, convert to `.xlsx` headlessly with an
   * isolated profile, and leave it at `<guestDir>/<nonce>/fixture.xlsx`.
   * Resolves the guest path of the converted fixture.
   */
  async convert(csvBytes: Buffer): Promise<Buffer> {
    const dir = `${this.#guestDir}/${nonce()}`;
    const guestCsv = `${dir}\\fixture.csv`;
    const xlsx = `${dir}\\fixture.xlsx`;
    const profile = `${this.#profileDir}/${nonce()}`;
    this.#lastDirs = { runDir: dir, profile };
    const started = Date.now();
    const hostLoadStart = hostLoad1m(this.#loadAverage);
    const timing = (outcome: ConvertTiming["outcome"]): ConvertTiming => {
      this.#lastTiming = {
        deadlineMs: this.#timeoutMs,
        durationMs: Date.now() - started,
        outcome,
        hostLoadStart,
        hostLoadEnd: hostLoad1m(this.#loadAverage),
      };
      return this.#lastTiming;
    };
    timing("error"); // overwritten below; stays "error" if the write/launch throws

    await this.#client.writeFile(guestCsv, csvBytes);
    await this.#client.launch([
      "soffice.com",
      "--headless",
      "--norestore",
      `-env:UserInstallation=file:///${profile}`,
      "--convert-to",
      "xlsx",
      "--outdir",
      dir,
      guestCsv,
    ]);

    // Headless convert is synchronous per document, but launch is
    // fire-and-forget — poll until the xlsx exists (bounded).
    const deadline = Date.now() + this.#timeoutMs;
    let stat: number | undefined;
    while (Date.now() < deadline) {
      await sleep(250);
      try {
        const bytes = await this.#client.readFile(xlsx);
        stat = bytes.length;
        break;
      } catch {
        // not converted yet
      }
    }
    if (stat === undefined) {
      timing("deadline");
      throw new Error(`fixture convert did not produce ${xlsx} within ${this.#timeoutMs}ms`);
    }
    timing("arrived");
    this.#lastConvert = { xlsxPath: xlsx, guestCsvPath: guestCsv };
    // The Buffer return value is unused on the Windows path (the fixture is
    // consumed guest-side by Calc); the contract keeps it for the fake path.
    return Buffer.alloc(0);
  }

  /** Timing of the most recent convert attempt, or null if none was attempted. */
  get lastTiming(): ConvertTiming | null {
    return this.#lastTiming;
  }

  /** Guest path of the most recently converted `.xlsx` (fixture landing spot). */
  get lastXlsxPath(): string | null {
    return this.#lastConvert?.xlsxPath ?? null;
  }
  /** Guest run dir of the last convert attempt (set before any await). */
  get lastRunDir(): string | null {
    return this.#lastDirs?.runDir ?? null;
  }

  /** Throwaway UNO profile dir of the last convert attempt. */
  get lastProfileDir(): string | null {
    return this.#lastDirs?.profile ?? null;
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
