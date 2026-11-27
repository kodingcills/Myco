/**
 * The committed third-party workbooks (`test/fixtures/calc-xlsx-writers/`, written by
 * `scripts/calc-xlsx-writer-fixtures.ts`): their manifest and bytes, shared by
 * `xlsx-writers.test.ts` and the soundness table in `xlsx-parity.test.ts`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { INTENT } from "./calc-probes.ts";

export const WRITERS_DIR = join(import.meta.dirname, "..", "fixtures", "calc-xlsx-writers");

interface Manifest {
  readonly seed: string;
  readonly edit: typeof INTENT;
  readonly soffice: string;
  readonly openpyxl: string;
  readonly files: Record<string, { sha256: string; writer: string; from: string }>;
}

export const WRITERS_MANIFEST: Manifest = JSON.parse(
  readFileSync(join(WRITERS_DIR, "manifest.json"), "utf8"),
);

export function writerBytes(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(WRITERS_DIR, name)));
}
