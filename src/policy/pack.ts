/**
 * Track O: the policy-hash rule for a pack of rows.
 *
 * Every policed trial's row records the SHA-256 of the host config it ran under
 * (`PolicyGuard.row`); an unpoliced row (`unpolicedRow`, arm `B`) records none. A pack is refused
 * when, within one arm:
 * - a policed row has no hash, or an unpoliced row has one;
 * - rows carry different hashes (two configs, or policed and unpoliced rows, mixed in one arm).
 * A refusal carries a closed code and, where it applies, the arm label the operator chose.
 */

import type { PolicyPackRefusal } from "./codes.ts";
import { POLICY_ROW_SCHEMA, type PolicyRow } from "./guard.ts";

export type PolicyPackResult =
  | { readonly ok: true; readonly arms: Readonly<Record<string, string | null>> }
  | { readonly ok: false; readonly code: PolicyPackRefusal; readonly arm: string | null };

const HEX64 = /^[0-9a-f]{64}$/;
const ARM = /^[A-Za-z0-9+._:-]{1,64}$/;

export function checkPolicyPack(rows: readonly PolicyRow[]): PolicyPackResult {
  if (!Array.isArray(rows) || rows.length === 0)
    return { ok: false, code: "POLICY_PACK_EMPTY", arm: null };
  const arms = new Map<string, string | null>();
  for (const row of rows) {
    if (
      typeof row !== "object" ||
      row === null ||
      row.schema !== POLICY_ROW_SCHEMA ||
      typeof row.arm !== "string" ||
      !ARM.test(row.arm) ||
      typeof row.policed !== "boolean"
    )
      return { ok: false, code: "POLICY_PACK_BAD_ROW", arm: null };
    const hash = row.policyConfigSha256;
    if (row.policed && (typeof hash !== "string" || !HEX64.test(hash)))
      return { ok: false, code: "POLICY_PACK_HASH_MISSING", arm: row.arm };
    if (!row.policed && hash !== null)
      return { ok: false, code: "POLICY_PACK_HASH_UNEXPECTED", arm: row.arm };
    if (arms.has(row.arm) && arms.get(row.arm) !== hash)
      return { ok: false, code: "POLICY_PACK_MIXED_HASH", arm: row.arm };
    arms.set(row.arm, hash);
  }
  return { ok: true, arms: Object.freeze(Object.fromEntries(arms)) };
}
