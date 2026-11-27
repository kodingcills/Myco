/**
 * Byte-level surgery on real zip archives, for the container probes of the gate-integrity PR
 * (round 1, V6, and the byte-coverage rule). Test-only; it reads the archive with plain
 * offsets so the shapes it builds do not depend on either judge's zip reader.
 */

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;

interface Layout {
  readonly eocd: number;
  readonly cdOffset: number;
  readonly cdSize: number;
  readonly total: number;
  /** Byte offset of each central-directory record's local-header-offset field. */
  readonly localOffsetFields: number[];
}

/** The layout of an archive with no comment (EOCD = last 22 bytes). */
export function layout(bytes: Uint8Array): Layout {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = bytes.length - 22;
  if (view.getUint32(eocd, true) !== EOCD_SIG) throw new Error("expected an EOCD at the end");
  const total = view.getUint16(eocd + 10, true);
  const cdSize = view.getUint32(eocd + 12, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  const localOffsetFields: number[] = [];
  let at = cdOffset;
  for (let n = 0; n < total; n++) {
    if (view.getUint32(at, true) !== CENTRAL_SIG) throw new Error("bad central record");
    localOffsetFields.push(at + 42);
    at +=
      46 +
      view.getUint16(at + 28, true) +
      view.getUint16(at + 30, true) +
      view.getUint16(at + 32, true);
  }
  return { eocd, cdOffset, cdSize, total, localOffsetFields };
}

/** A copy of `archive` whose every absolute offset is moved by `delta` (to sit at `delta`). */
export function relocate(archive: Uint8Array, delta: number): Uint8Array {
  const out = archive.slice();
  const view = new DataView(out.buffer);
  const l = layout(out);
  for (const field of l.localOffsetFields)
    view.setUint32(field, view.getUint32(field, true) + delta, true);
  view.setUint32(l.eocd + 16, l.cdOffset + delta, true);
  return out;
}

/**
 * Round 1, V6: `real` with its EOCD comment holding a complete `decoy` archive (relocated to
 * where it now sits) followed by `pad` bytes. A reader that scans back for the last EOCD
 * signature (the independent grader) reads the decoy; the real directory is still intact.
 */
export function withCommentDecoy(real: Uint8Array, decoy: Uint8Array, pad = 1): Uint8Array {
  const at = real.length; // the comment starts right after the real EOCD
  const moved = relocate(decoy, at);
  const out = new Uint8Array(real.length + moved.length + pad);
  out.set(real, 0);
  out.set(moved, at);
  new DataView(out.buffer).setUint16(real.length - 2, moved.length + pad, true);
  return out;
}

/** `real` with a plain EOCD comment (no decoy). */
export function withComment(real: Uint8Array, comment: Uint8Array): Uint8Array {
  const out = new Uint8Array(real.length + comment.length);
  out.set(real, 0);
  out.set(comment, real.length);
  new DataView(out.buffer).setUint16(real.length - 2, comment.length, true);
  return out;
}

/**
 * `bytes` with `junk` inserted at byte `at` (which must lie in the entry region, before the
 * central directory), every offset after it moved so both judges still find every entry.
 * The result has a byte range no local header, entry data, descriptor or directory covers.
 */
export function withGap(bytes: Uint8Array, at: number, junk: Uint8Array): Uint8Array {
  const l = layout(bytes);
  if (at > l.cdOffset) throw new Error("gap must sit before the central directory");
  const out = new Uint8Array(bytes.length + junk.length);
  out.set(bytes.subarray(0, at), 0);
  out.set(junk, at);
  out.set(bytes.subarray(at), at + junk.length);
  const view = new DataView(out.buffer);
  const shift = (field: number) => {
    const v = view.getUint32(field, true);
    if (v >= at) view.setUint32(field, v + junk.length, true);
  };
  for (const field of l.localOffsetFields) shift(field + junk.length);
  view.setUint32(l.eocd + junk.length + 16, l.cdOffset + junk.length, true);
  return out;
}

/** Offsets where each entry's span (local header through data descriptor) ends, ascending. */
export function entryEnds(bytes: Uint8Array): number[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const l = layout(bytes);
  const starts = l.localOffsetFields.map((f) => view.getUint32(f, true)).sort((a, b) => a - b);
  return [...starts.slice(1), l.cdOffset];
}
