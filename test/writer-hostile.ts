/**
 * Hostile Writer documents from the TIF-99 round-1 verifier report, generated in the test
 * (nothing large is committed). Each starts from an edited document that verifies, so a
 * guard that fails shows up as a false `verified`, not as a harmless refute.
 */

import { constants, crc32, deflateRawSync } from "node:zlib";
import {
  applyGroundTruth,
  groundTruth,
  type WriterPostconditionKind,
  writerFixture,
  writerTaskFor,
} from "../src/tasks/writer-doc-edit.ts";
import {
  docxEntries,
  ODT_MAIN_PART,
  odtEntries,
  type WriterFormat,
  writeZip,
  type ZipEntryInput,
} from "../src/tasks/writer-docgen.ts";

export const HOSTILE_SEED = "w-001";

export function hostileEntries(
  format: WriterFormat,
  kind: WriterPostconditionKind,
): ZipEntryInput[] {
  const params = writerTaskFor(HOSTILE_SEED, kind);
  const spec = applyGroundTruth(writerFixture(params.fixtureSeed), groundTruth(params));
  return format === "docx" ? docxEntries(spec) : odtEntries(spec);
}

/**
 * D1: the edited table-cell `.odt` plus one table whose single row repeats 1024 times and
 * holds `n` cells that each repeat 1024 columns: n * 1024 * 1024 cells from ~1.6 KB.
 */
export function odtRepeatBomb(n: number): Uint8Array {
  const cells = '<table:table-cell table:number-columns-repeated="1024"/>'.repeat(n);
  const bomb = `<table:table table:name="Bomb"><table:table-row table:number-rows-repeated="1024">${cells}</table:table-row></table:table>`;
  return writeZip(
    hostileEntries("odt", "table-cell").map((e) =>
      e.name === ODT_MAIN_PART
        ? {
            ...e,
            data: new TextEncoder().encode(
              new TextDecoder().decode(e.data).replace("</office:text>", `${bomb}</office:text>`),
            ),
          }
        : e,
    ),
  );
}

const MIB = 1024 * 1024;

const zerosCache = new Map<number, { body: Uint8Array; crc: number; size: number }>();

/**
 * An honest deflate stream of `mib` MiB of zeros, built without allocating them: one MiB
 * deflated with a full flush (a non-final block) repeated, then an empty final block.
 */
export function deflatedZeros(mib: number): { body: Uint8Array; crc: number; size: number } {
  const hit = zerosCache.get(mib);
  if (hit !== undefined) return hit;
  const chunk = Buffer.alloc(MIB);
  const block = deflateRawSync(chunk, { finishFlush: constants.Z_FULL_FLUSH });
  const final = deflateRawSync(Buffer.alloc(0));
  let crc = 0;
  for (let i = 0; i < mib; i++) crc = crc32(chunk, crc);
  const body = Buffer.concat([...Array.from({ length: mib }, () => block), final]);
  const out = { body: new Uint8Array(body), crc: crc >>> 0, size: mib * MIB };
  zerosCache.set(mib, out);
  return out;
}

/** D2: the edited document plus `count` extra entries, each `mib` MiB of zeros. */
export function zipBomb(format: WriterFormat, count: number, mib = 512): Uint8Array {
  const zeros = deflatedZeros(mib);
  const extra: ZipEntryInput[] = Array.from({ length: count }, (_, i) => ({
    name: `bomb/zeros-${i}.bin`,
    data: new Uint8Array(0),
    deflated: zeros,
  }));
  return writeZip([...hostileEntries(format, "table-cell"), ...extra]);
}
