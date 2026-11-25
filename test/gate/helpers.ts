import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { generateFixture } from "../../src/tasks/fixture.ts";

export const S01_ITEMS = [
  "update the release notes",
  "write the incident summary",
  "verify database connection pool",
  "prepare deployment checklist",
];
export const S02_ITEMS = [
  "bug: login page crashes on save",
  "BUG: token expires too early",
  "update the release notes",
  "write the incident summary",
];
/** What the app persists for df-s02: the BUG items are silently dropped. */
export const S02_PERSISTED = ["update the release notes", "write the incident summary"];

export function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "myco-gate-test-"));
}

export function writeState(
  root: string,
  runId: string,
  file: string,
  content: string | Uint8Array,
) {
  const path = join(root, runId, file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return path;
}

export function todoStore(items: readonly string[]): string {
  return JSON.stringify({
    items: items.map((text) => ({ text, addedAt: "2026-11-25T00:00:00Z" })),
  });
}

export const CALC_SPEC = {
  fixtureSeed: "gate-seed",
  rowKey: "EMP-0002",
  column: "name",
  newValue: "Gate Ops",
};

/** The calc fixture as CSV; with `edit`, the target cell holds the new value. */
export function calcCsv(edit: boolean): string {
  const fixture = generateFixture(CALC_SPEC.fixtureSeed);
  const rows = fixture.rows.map((row) => [...row]);
  const target = fixture.header.indexOf(CALC_SPEC.column);
  const row = rows[1];
  if (edit && row) row[target] = CALC_SPEC.newValue;
  return `${[fixture.header, ...rows].map((r) => r.join(",")).join("\n")}\n`;
}
