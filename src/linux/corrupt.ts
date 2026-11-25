/**
 * Seeded corruptions of a saved workbook (TIF-269, M2-06), applied AFTER the
 * agent has finished and claimed success. They model the saved file not holding
 * what the agent says it holds, and they are the mutation proofs for the oracle:
 *
 * - `content`: the workbook stays a valid `.xlsx`, but the target cell's saved
 *   value is replaced. Expected verdict: `refuted`.
 * - `bytes`:   the file is truncated to half its length, so no reader can open it.
 *   Expected verdict: `uncertain` (could not look), never `verified`.
 */

import { readFileSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";

export const CORRUPTIONS = ["content", "bytes"] as const;
export type Corruption = (typeof CORRUPTIONS)[number];

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/**
 * Replace every XML text node equal to `from` with `to` inside the workbook's
 * `xl/` parts (shared strings and inline/number cell values). Returns how many
 * nodes changed and throws if none did, so a no-op mutation can never pass as a
 * corruption.
 */
export function corruptSavedValue(xlsxPath: string, from: string, to: string): number {
  const parts = unzipSync(new Uint8Array(readFileSync(xlsxPath)));
  const needle = `>${escapeXml(from)}<`;
  const replacement = `>${escapeXml(to)}<`;
  let changed = 0;
  for (const [name, data] of Object.entries(parts)) {
    if (!name.startsWith("xl/") || !name.endsWith(".xml")) continue;
    const xml = strFromU8(data);
    const count = xml.split(needle).length - 1;
    if (count > 0) {
      parts[name] = strToU8(xml.replaceAll(needle, replacement));
      changed += count;
    }
  }
  if (changed === 0) {
    throw new Error(`corruption not applied: no saved value "${from}" in ${xlsxPath}`);
  }
  writeFileSync(xlsxPath, zipSync(parts));
  return changed;
}

/** Truncate the file to half its size (at least one byte removed). */
export function truncateSaved(xlsxPath: string): number {
  const size = statSync(xlsxPath).size;
  const keep = Math.floor(size / 2);
  truncateSync(xlsxPath, keep);
  return size - keep;
}
