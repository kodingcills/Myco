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
  #lastConvert: ConvertResult | null = null;

  constructor(options: WindowsFixtureConverterOptions) {
    this.#client = options.client;
    this.#guestDir = options.guestDir.replaceAll("\\", "/").replace(/\/$/, "");
    this.#profileDir = options.profileDir ?? `${this.#guestDir}/profiles`;
    this.#timeoutMs = options.timeoutMs ?? 60_000;
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
      throw new Error(`fixture convert did not produce ${xlsx} within ${this.#timeoutMs}ms`);
    }
    this.#lastConvert = { xlsxPath: xlsx, guestCsvPath: guestCsv };
    // The Buffer return value is unused on the Windows path (the fixture is
    // consumed guest-side by Calc); the contract keeps it for the fake path.
    return Buffer.alloc(0);
  }

  /** Guest path of the most recently converted `.xlsx` (fixture landing spot). */
  get lastXlsxPath(): string | null {
    return this.#lastConvert?.xlsxPath ?? null;
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
