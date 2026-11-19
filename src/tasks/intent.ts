/**
 * calc-record-edit task family: intents, deterministic parameter generation,
 * and host-side ground truth.
 *
 * Ground truth discipline (ADR-0005, OSWorld `employee_age_reference`): the
 * expected cell value is computed from `fixtureSeed` + intent params on the
 * host, never from guest or app state.
 */

import {
  COLUMN_COUNT,
  DATA_COLUMNS,
  dataRowsForSeed,
  FIXTURE_COLUMNS,
  type Fixture,
  type FixtureColumn,
  generateFixture,
  hash32,
  recordKey,
} from "./fixture.ts";

/** Intent parameters: "set the cell at record `rowKey`, column `column`, to `newValue`, and save the file." */
export interface CalcRecordEditParams {
  fixtureSeed: string;
  rowKey: string;
  column: string;
  newValue: string;
}

export function columnByName(name: string): FixtureColumn | undefined {
  return DATA_COLUMNS.find((c) => c.name === name);
}

function formatValueFor(type: FixtureColumn["type"], r: () => number): string {
  switch (type) {
    case "text":
      return `revised-${Math.floor(r() * 1_000_000)}`;
    case "integer":
      return String(Math.floor(r() * 10_000));
    case "date":
      return new Date(Date.UTC(2024, 0, 1) + Math.floor(r() * 365) * 86_400_000)
        .toISOString()
        .slice(0, 10);
    case "currency":
      return `$${Math.floor(r() * 50_000)}.${String(Math.floor(r() * 100)).padStart(2, "0")}`;
    case "key":
      return `KEY-${Math.floor(r() * 1_000_000)}`;
  }
}

/**
 * Deterministic value for an intent's target cell. Same PRNG shape as the
 * fixture generator (`hash32` + slice), keyed by seed + params — never by
 * guest state.
 */
function newCellValue(seed: string, rowKey: string, column: string, index: number): string {
  const type = columnByName(column)?.type ?? "text";
  return formatValueFor(type, seededRandom(`value:${seed}:${rowKey}:${column}:${index}`));
}

/**
 * The 30 distinct parameter sets for the M1 eval, from a seed list. Varies
 * rowKey, column, newValue, and fixture size (5–200 rows) across the four
 * typed data columns. Deterministic: the same seed list yields byte-identical
 * parameter sets. Index (0-based) is stable and feeds the value PRNG so two
 * intents differing only in index still get distinct values.
 */
export function generateParameterSets(seeds: readonly string[]): CalcRecordEditParams[] {
  if (seeds.length === 0) {
    throw new Error("seed list must not be empty");
  }
  const sets: CalcRecordEditParams[] = [];
  for (let i = 0; i < 30; i++) {
    const fixtureSeed = seeds[i % seeds.length] ?? "";
    const dataRows = dataRowsForSeed(fixtureSeed);
    // Spread row picks across the sheet: cycle indices inside each fixture,
    // offset by the trial so distinct seeds and repeat seeds both vary.
    const rowIdx = Math.floor(hash32(`row:${fixtureSeed}:${i}`) % dataRows);
    const column = (
      DATA_COLUMNS[i % DATA_COLUMNS.length] ??
      DATA_COLUMNS[0] ?? { name: "name", type: "text" }
    ).name;
    const rowKey = recordKey(rowIdx);
    sets.push({
      fixtureSeed,
      rowKey,
      column,
      newValue: newCellValue(fixtureSeed, rowKey, column, i),
    });
  }
  return sets;
}

function seededRandom(tag: string): () => number {
  let a = hash32(tag) || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Ground truth
// ---------------------------------------------------------------------------

export interface FixtureLocation {
  /** Row of the target data record within the fixture grid. */
  dataRowIndex: number;
  /** 0-based column index of the target column. */
  colIndex: number;
}

export interface GroundTruth {
  location: FixtureLocation;
  /** Cell the intent targets, in A1 notation relative to the whole sheet (header = row 1). */
  cellRef: string;
  /** Value the target cell must hold after a successful run. */
  expectedValue: string;
  /** Value the target cell held in the pristine fixture. */
  previousValue: string;
}

/** Locate a record row and column within a generated fixture, or explain why not. */
export function locateInFixture(
  seed: string,
  rowKey: string,
  column: string,
): { location: FixtureLocation; col: FixtureColumn } | { error: string } {
  if (!DATA_COLUMNS.some((c) => c.name === column)) {
    return { error: `unknown or non-editable column "${column}"` };
  }
  const dataRows = dataRowsForSeed(seed);
  const idx = rowKeyNumber(rowKey);
  if (idx === null || idx < 1 || idx > dataRows) {
    return { error: `rowKey "${rowKey}" not present in fixture (1..${dataRows})` };
  }
  const colIndex = FIXTURE_COLUMNS.findIndex((c) => c.name === column);
  return {
    location: { dataRowIndex: idx - 1, colIndex },
    col: FIXTURE_COLUMNS[colIndex] ?? { name: column, type: "text" },
  };
}

function rowKeyNumber(rowKey: string): number | null {
  const match = /^EMP-(\d{4})$/.exec(rowKey);
  return match ? Number.parseInt(match[1] ?? "", 10) : null;
}

function columnLetters(colIndex: number): string {
  let name = "";
  let c = colIndex;
  do {
    name = String.fromCharCode(65 + (c % 26)) + name;
    c = Math.floor(c / 26) - 1;
  } while (c >= 0);
  return name;
}

/**
 * Host-side ground truth for an intent: the expected cell value computed from
 * `fixtureSeed` + params only (ADR-0005). Never consults guest/app state.
 */
export function groundTruth(params: CalcRecordEditParams): GroundTruth {
  const found = locateInFixture(params.fixtureSeed, params.rowKey, params.column);
  if ("error" in found) {
    throw new Error(`cannot compute ground truth: ${found.error}`);
  }
  const fixture = generateFixture(params.fixtureSeed);
  const { dataRowIndex, colIndex } = found.location;
  return {
    location: found.location,
    cellRef: `${columnLetters(colIndex)}${dataRowIndex + 2}`, // +1 header row, +1 for 1-based rows
    expectedValue: params.newValue,
    previousValue: fixture.rows[dataRowIndex]?.[colIndex] ?? "",
  };
}

/** Row count including the header row, for sizing the fake app grid. */
export function fixtureGridRows(fixture: Fixture): number {
  return fixture.dataRows + 1;
}

export const FIXTURE_COLUMN_COUNT = COLUMN_COUNT;
