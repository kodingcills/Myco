/**
 * Minimal read-only ZIP reader for the independent benchmark grader (TIF-267).
 *
 * Why a hand-rolled reader: the grader must not share a parsing path with the gate.
 * The gate reads a saved workbook through `soffice --convert-to csv` in the guest; the
 * grader reads the same saved bytes on the host, through this file and nothing else.
 * Supports exactly what an `.xlsx` needs: stored (0) and deflated (8) entries, no
 * encryption, no ZIP64. Anything else is an error, which the grader maps to
 * `ungradable` (it never guesses).
 */
import { inflateRawSync } from "node:zlib";

export class ZipReadError extends Error {
  override name = "ZipReadError";
}

/** Upper bound on total inflated bytes. A spreadsheet in this benchmark is a few KB. */
export const MAX_INFLATED_BYTES = 64 * 1024 * 1024;

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

function u16(buf: Buffer, at: number): number {
  if (at + 2 > buf.length) throw new ZipReadError(`truncated at offset ${at}`);
  return buf.readUInt16LE(at);
}
function u32(buf: Buffer, at: number): number {
  if (at + 4 > buf.length) throw new ZipReadError(`truncated at offset ${at}`);
  return buf.readUInt32LE(at);
}

/** Read every entry of a ZIP archive into memory, keyed by entry name. */
export function readZip(bytes: Uint8Array): Map<string, Buffer> {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buf.length < 22) throw new ZipReadError("not a zip archive (too short)");

  // End of central directory: last 22 bytes plus an optional comment of up to 64 KiB.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipReadError("not a zip archive (no end-of-central-directory)");

  const entryCount = u16(buf, eocd + 10);
  const centralSize = u32(buf, eocd + 12);
  const centralOffset = u32(buf, eocd + 16);
  if (entryCount === 0xffff || centralOffset === 0xffffffff) {
    throw new ZipReadError("zip64 archives are not supported");
  }
  if (centralOffset + centralSize > eocd) throw new ZipReadError("central directory out of range");

  const entries = new Map<string, Buffer>();
  let inflatedTotal = 0;
  let at = centralOffset;
  for (let n = 0; n < entryCount; n++) {
    if (u32(buf, at) !== CENTRAL_SIG) throw new ZipReadError(`bad central entry at ${at}`);
    const flags = u16(buf, at + 8);
    const method = u16(buf, at + 10);
    const compressedSize = u32(buf, at + 20);
    const size = u32(buf, at + 24);
    const nameLength = u16(buf, at + 28);
    const extraLength = u16(buf, at + 30);
    const commentLength = u16(buf, at + 32);
    const localOffset = u32(buf, at + 42);
    const name = buf.toString("utf8", at + 46, at + 46 + nameLength);
    at += 46 + nameLength + extraLength + commentLength;

    if (flags & 0x1) throw new ZipReadError(`entry ${name} is encrypted`);
    if (entries.has(name)) throw new ZipReadError(`duplicate entry ${name}`);
    if (u32(buf, localOffset) !== LOCAL_SIG) throw new ZipReadError(`bad local header for ${name}`);
    const dataStart = localOffset + 30 + u16(buf, localOffset + 26) + u16(buf, localOffset + 28);
    if (dataStart + compressedSize > buf.length) throw new ZipReadError(`entry ${name} truncated`);
    const raw = buf.subarray(dataStart, dataStart + compressedSize);

    inflatedTotal += size;
    if (inflatedTotal > MAX_INFLATED_BYTES) throw new ZipReadError("archive inflates too large");

    let data: Buffer;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) {
      try {
        data = inflateRawSync(raw, { maxOutputLength: Math.max(size, 1) });
      } catch (error) {
        throw new ZipReadError(`entry ${name} does not inflate: ${(error as Error).message}`);
      }
    } else throw new ZipReadError(`entry ${name} uses unsupported method ${method}`);
    if (data.length !== size) throw new ZipReadError(`entry ${name} size mismatch`);
    entries.set(name, data);
  }
  return entries;
}
