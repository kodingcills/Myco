/**
 * Deterministic fixture generation for the calc-record-edit family.
 *
 * The canonical fixture format is CSV — the fake app's persisted format
 * (src/fake/app.ts). On the real Windows VM the same CSV bytes are converted
 * guest-side to `.xlsx` via `soffice --convert-to xlsx` before LibreOffice Calc
 * opens the document, and the persisted-state reader parses the `.xlsx`
 * instead. That conversion is a guest-agent op, not host code; the host-side
 * seam is {@link FixtureConverter}, which the Windows path implements.
 */

import { createHash } from "node:crypto";

/** FNV-1a 32-bit string hash. Stable across runs and processes, but not
 * collision-proof; eval seed lists are curated to avoid collisions. */
export function hash32(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Mulberry32 PRNG: small, fast, deterministic from a 32-bit seed. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type ColumnType = "key" | "text" | "integer" | "date" | "currency";

export interface FixtureColumn {
  name: string;
  type: ColumnType;
}

/**
 * Fixed column layout: a key column plus the four typed data columns from the
 * architecture doc (text, integer, date, currency). The header row is fixture
 * row 0; data rows follow. Column A is always `id`.
 */
export const FIXTURE_COLUMNS: readonly FixtureColumn[] = [
  { name: "id", type: "key" },
  { name: "name", type: "text" },
  { name: "qty", type: "integer" },
  { name: "joined", type: "date" },
  { name: "salary", type: "currency" },
];

export const COLUMN_COUNT = FIXTURE_COLUMNS.length;

/** Data columns an intent may target. The `id` key column is not editable. */
export const DATA_COLUMNS: readonly FixtureColumn[] = FIXTURE_COLUMNS.slice(1);

const FIRST_NAMES = ["Ada", "Bruno", "Cleo", "Dara", "Enzo", "Faye", "Gil", "Hana"];
const LAST_NAMES = ["Ito", "Jovic", "Kaur", "Larsen", "Mora", "Nakamura", "Ortiz", "Petrov"];

const DATE_BASE_MS = Date.UTC(2020, 0, 1);
const DAY_MS = 86_400_000;

function isoDate(daysAfterBase: number): string {
  return new Date(DATE_BASE_MS + daysAfterBase * DAY_MS).toISOString().slice(0, 10);
}

/** Deterministic record key for a 0-based data row: EMP-0001, EMP-0002, ... */
export function recordKey(dataRowIndex: number): string {
  return `EMP-${String(dataRowIndex + 1).padStart(4, "0")}`;
}

/**
 * Deterministic fixture size for a seed: 5–200 data rows (architecture doc,
 * "The smallest rigorous slice"). Depends only on the seed, never on guest or
 * app state.
 */
export function dataRowsForSeed(seed: string): number {
  return 5 + (hash32(`rows:${seed}`) % 196);
}

export interface Fixture {
  seed: string;
  /** Number of data rows (excluding the header row). */
  dataRows: number;
  /** Column names, in order — the header row of the sheet. */
  header: string[];
  /** Data rows as cell values, in column order. Row i is record key `EMP-i+1`. */
  rows: string[][];
  csv: string;
}

/**
 * Generate the fixture sheet for a seed: header row + `dataRowsForSeed(seed)`
 * typed data rows. Deterministic: same seed, same bytes, host-side only.
 */
export function generateFixture(seed: string): Fixture {
  const dataRows = dataRowsForSeed(seed);
  const rng = mulberry32(hash32(`fixture:${seed}`));
  const rows: string[][] = [];
  for (let i = 0; i < dataRows; i++) {
    const first = FIRST_NAMES[Math.floor(rng() * FIRST_NAMES.length) % FIRST_NAMES.length];
    const last = LAST_NAMES[Math.floor(rng() * LAST_NAMES.length) % LAST_NAMES.length];
    const qty = String(1 + Math.floor(rng() * 999));
    const joined = isoDate(Math.floor(rng() * 2000));
    const salary = `$${30000 + Math.floor(rng() * 50000)}.${String(Math.floor(rng() * 100)).padStart(2, "0")}`;
    rows.push([recordKey(i), `${first} ${last}`, qty, joined, salary]);
  }
  const header = FIXTURE_COLUMNS.map((c) => c.name);
  const csv = `${[header, ...rows].map((r) => r.join(",")).join("\n")}\n`;
  return { seed, dataRows, header, rows, csv };
}

/**
 * Seam to the persisted spreadsheet format. The default is the identity over
 * CSV (the fake app's format). The Windows path implements this with a
 * guest-agent op (`soffice --convert-to xlsx`): the host hands the agent the
 * CSV bytes, the agent returns the `.xlsx` bytes Calc will open and later
 * persist. Keeping it an interface means CI exercises the identical program
 * and verifier against the fake while the real guest only swaps this edge.
 */
export interface FixtureConverter {
  readonly format: "csv" | "xlsx";
  convert(csvBytes: Buffer): Promise<Buffer>;
}

export const csvIdentityConverter: FixtureConverter = {
  format: "csv",
  convert: async (csvBytes) => csvBytes,
};

/**
 * Identity of the exact fixture bytes a trial hands the guest (M1-013 sweep
 * seed check). SHA-256 over the UTF-8 CSV, which is what the converter
 * uploads. A sweep compares each trial's reported fingerprint with the one
 * expected for that trial's `fixtureSeed`, so a seed that silently fails to
 * reach the trial (every run on one sheet) fails loudly instead.
 */
export interface FixtureFingerprint {
  seed: string;
  dataRows: number;
  csvSha256: string;
}

export function fixtureFingerprint(fixture: Fixture): FixtureFingerprint {
  return {
    seed: fixture.seed,
    dataRows: fixture.dataRows,
    csvSha256: createHash("sha256").update(Buffer.from(fixture.csv, "utf8")).digest("hex"),
  };
}
