/**
 * Raw-header check of a release archive (track G, #613; #612 N2). `tar -tv` applies pax and
 * GNU extension headers silently (a `SCHILY.xattr.*` record never shows in its listing), so
 * this reads the 512-byte headers themselves instead of a listing.
 *
 * Every header must be a plain ustar regular file: typeflag `0` (so no `x`/`g` pax, `L`/`K`
 * GNU long-name, directory, link or other entry), magic `ustar\0` version `00`, a valid
 * checksum, mode `0000644`, uid and gid `0000000`, empty owner and group names, a path under
 * `<root>/` with no `..` segment and no duplicate. The archive ends with zero blocks only.
 * The set of entries must equal the files `<root>/SHA256SUMS` lists plus `SHA256SUMS` itself
 * (`sha256sum -c` alone passes an unlisted extra file).
 *
 * Node built-ins only, and only erasable TypeScript, so plain `node` runs it.
 */
import { createHash } from "node:crypto";

export const SUMS_NAME = "SHA256SUMS";

interface RawEntry {
  readonly name: string;
  readonly bytes: Buffer;
}

const field = (h: Buffer, at: number, len: number): Buffer => h.subarray(at, at + len);
const text = (h: Buffer, at: number, len: number): string =>
  field(h, at, len).toString("latin1").replace(/\0.*$/s, "");

/** Findings for the archive bytes; empty when the archive is a clean release archive. */
export function checkReleaseArchive(buf: Buffer, root: string): string[] {
  const findings: string[] = [];
  const entries: RawEntry[] = [];
  const seen = new Set<string>();
  let off = 0;
  let index = 0;
  let ended = false;
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h.every((b) => b === 0)) {
      ended = true;
      break;
    }
    index += 1;
    const at = `entry ${index}`;
    let sum = 0;
    for (const [i, b] of h.entries()) sum += i >= 148 && i < 156 ? 0x20 : b;
    const stored = Number.parseInt(text(h, 148, 8).trim(), 8);
    if (stored !== sum) findings.push(`${at}: bad header checksum`);
    const type = String.fromCharCode(h[156] as number);
    if (type !== "0")
      findings.push(`${at}: typeflag ${JSON.stringify(type)} is not a regular file`);
    if (field(h, 257, 8).toString("latin1") !== "ustar\u000000")
      findings.push(`${at}: not a plain ustar header`);
    if (field(h, 100, 8).toString("latin1") !== "0000644\0")
      findings.push(`${at}: mode is not 0644`);
    if (field(h, 108, 8).toString("latin1") !== "0000000\0") findings.push(`${at}: uid is not 0`);
    if (field(h, 116, 8).toString("latin1") !== "0000000\0") findings.push(`${at}: gid is not 0`);
    if (!field(h, 265, 64).every((b) => b === 0))
      findings.push(`${at}: has an owner or group name`);
    const sizeText = text(h, 124, 12).trim();
    const size = /^[0-7]{1,11}$/.test(sizeText) ? Number.parseInt(sizeText, 8) : Number.NaN;
    if (!Number.isFinite(size) || off + 512 + size > buf.length) {
      findings.push(`${at}: bad size`);
      break;
    }
    const prefix = text(h, 345, 155);
    const name = prefix === "" ? text(h, 0, 100) : `${prefix}/${text(h, 0, 100)}`;
    if (!name.startsWith(`${root}/`) || name.split("/").some((s) => s === ".." || s === "."))
      findings.push(`${at}: path outside ${root}/`);
    else if (seen.has(name)) findings.push(`${at}: duplicate path`);
    else {
      seen.add(name);
      entries.push({
        name: name.slice(root.length + 1),
        bytes: buf.subarray(off + 512, off + 512 + size),
      });
    }
    off += 512 + Math.ceil(size / 512) * 512;
  }
  if (!ended) findings.push("archive has no end-of-archive zero block");
  else if (!buf.subarray(off).every((b) => b === 0))
    findings.push("archive has data after the end-of-archive block");

  const sums = entries.find((e) => e.name === SUMS_NAME);
  if (sums === undefined) {
    findings.push(`no ${SUMS_NAME} entry`);
    return findings;
  }
  const listed = new Map<string, string>();
  for (const line of sums.bytes.toString("utf8").split("\n")) {
    if (line === "") continue;
    const m = /^([0-9a-f]{64}) {2}(.+)$/.exec(line);
    if (m === null) {
      findings.push(`${SUMS_NAME}: unreadable line`);
      continue;
    }
    listed.set(m[2] as string, m[1] as string);
  }
  for (const e of entries) {
    if (e.name === SUMS_NAME) continue;
    const want = listed.get(e.name);
    if (want === undefined) findings.push(`${e.name}: in the archive but not in ${SUMS_NAME}`);
    else if (createHash("sha256").update(e.bytes).digest("hex") !== want)
      findings.push(`${e.name}: does not match ${SUMS_NAME}`);
  }
  const names = new Set(entries.map((e) => e.name));
  for (const p of listed.keys())
    if (!names.has(p)) findings.push(`${p}: in ${SUMS_NAME} but not in the archive`);
  return findings;
}
