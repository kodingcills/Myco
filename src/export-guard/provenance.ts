/**
 * PROVENANCE-BOUND hashed values, shared by every export surface (#579 O3; the episode export
 * `src/episode`, track U's container `src/dataset`, and track Q's proof bundles `src/proof`).
 *
 * Every surface writes a value it may not keep as is in the one hashed form `h-<60 hex>` (lead
 * ruling 2026-11-26 23:06Z). Until #579, closing kept ANY input that was exactly `h-<60 hex>`
 * (exact-match idempotence), so re-exporting an imported dataset was byte-identical. That also
 * made `h-<60 hex>` a free channel: an agent could hex-encode up to 30 bytes (a short path, a
 * name) in any hashed field and it went out verbatim, and a hex-letter identity (`cafe`, `ada`)
 * inside such a value passed every identity check (they skip hashed values).
 *
 * The rule now: an `h-<60 hex>` value is kept verbatim ONLY when the harness produced it, which
 * is when it is recorded in a harness-side `HashLedger` under the SCOPE it was produced in (a
 * surface-chosen string binding it to one place: for an episode, its episode id and the field's
 * JSON path). Any other `h-<60 hex>` value, wherever it came from, is re-hashed like any other
 * value. So:
 *
 *  - an agent-supplied `h-<60 hex>` never goes out as written: it is not in any ledger (the
 *    ledger is written only by harness code, from harness artifacts: an imported dataset that
 *    validated, a self-verified bundle), and a ledger value at another scope (another episode,
 *    another field) does not count;
 *  - export, import, export stays byte-identical: the importer records the dataset's hashed
 *    values in the ledger under their own scopes, and the second export keeps exactly those.
 *
 * A ledger is a harness artifact: no code path builds one from raw run inputs. What an importer
 * records is TRUSTED as harness output (it validated, but a validator cannot tell who chose the
 * hex), so a dataset written before #579 must be re-exported from its source store, not
 * re-imported.
 *
 * This module imports nothing from any surface (and nothing from `src/benchmark`): each surface
 * keeps its own hash function and domain tag and passes it in.
 */

/** THE hashed form (lead ruling 23:06Z): exactly `h-` and 60 lower-case hex, nothing else. */
export const HASHED_FORM = /^h-[0-9a-f]{60}$/;

/** Whether `value` is exactly the hashed form (says nothing about who produced it). */
export const isHashedForm = (value: string): boolean => HASHED_FORM.test(value);

/** A scope for a value: the JSON path of a field inside one episode (`episodeId` + path). */
export const episodeScope = (episodeId: string, path: string): string =>
  `${episodeId}\u0000${path}`;

/**
 * The hashed values the harness itself produced, each bound to the scope it was produced in.
 * Recording a value that is not exactly `h-<60 hex>` throws (only hashed values have provenance).
 */
export class HashLedger {
  readonly #byScope = new Map<string, Set<string>>();

  record(scope: string, value: string): void {
    if (!isHashedForm(value)) throw new Error("hash ledger: only an h-<60 hex> value is recorded");
    let set = this.#byScope.get(scope);
    if (set === undefined) {
      set = new Set();
      this.#byScope.set(scope, set);
    }
    set.add(value);
  }

  /** Whether the harness produced exactly `value` at exactly `scope`. */
  holds(scope: string, value: string): boolean {
    return this.#byScope.get(scope)?.has(value) === true;
  }

  /** Every entry, sorted (deterministic persistence). */
  entries(): Array<readonly [string, string]> {
    const out: Array<readonly [string, string]> = [];
    for (const [scope, set] of this.#byScope) for (const v of set) out.push([scope, v]);
    return out.sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0));
  }

  get size(): number {
    let n = 0;
    for (const set of this.#byScope.values()) n += set.size;
    return n;
  }
}

/** The empty ledger: nothing is harness-produced, so every `h-<60 hex>` input is re-hashed. */
export const NO_LEDGER: HashLedger = new HashLedger();

/**
 * Whether a value the export would otherwise hash may be written as is: it is exactly
 * `h-<60 hex>` AND the ledger records it at this scope. This is the ONLY place an export
 * surface keeps an `h-<60 hex>` input verbatim.
 */
export function harnessHashed(value: string, scope: string, ledger: HashLedger): boolean {
  return isHashedForm(value) && ledger.holds(scope, value);
}

/** Keep a harness-produced hashed value; hash anything else with the surface's own `hash`. */
export function keepOrHash(
  value: string,
  scope: string,
  ledger: HashLedger,
  hash: (raw: string) => string,
): string {
  return harnessHashed(value, scope, ledger) ? value : hash(value);
}
