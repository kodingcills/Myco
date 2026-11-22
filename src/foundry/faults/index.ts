import type { AppState } from "../tasks/app-model.ts";

export type Fault =
  | "stale-ui"
  | "interrupted-write"
  | "partial-persistence"
  | "crash-mid-save"
  | "permission-denied";
export interface FaultSpec {
  readonly fault: Fault;
  readonly version: number;
  readonly seed: number;
  readonly reportError?: boolean;
}
export interface FaultEvent {
  readonly type: "fault-injection";
  readonly timestamp: string;
  readonly fault: Fault;
  readonly detail: string;
}
export interface FaultResult {
  readonly state: AppState;
  readonly faultVersion: number;
  readonly event: FaultEvent;
}

const timestamp = (seed: number) =>
  new Date(1609459200000 + (Math.abs(seed) % 1000000)).toISOString();
const itemFile = (rows: readonly string[], seed: number) =>
  `${JSON.stringify({ items: rows.map((text) => ({ text: text.trim().replace(/\s+/g, " "), added_at: timestamp(seed) })) }, null, 2)}\n`;
const metaFile = (rows: readonly string[]) => `${JSON.stringify({ count: rows.length })}\n`;

/** Inject at save, preserving the pre-save files as the durable baseline.
 * Permission denial is seed-invariant: no write occurs. A torn unreadable store
 * is ledgered uncertain, never a proven false success.
 */
export function injectFault(state: AppState, spec: FaultSpec): FaultResult {
  if (!Number.isInteger(spec.version) || spec.version < 1 || !Number.isSafeInteger(spec.seed))
    throw new Error("Invalid fault version or seed");
  const items = itemFile(state.rows, spec.seed);
  const meta = metaFile(state.rows);
  const saved = `saved ${state.listbox.length} item(s)`;
  let next: AppState;
  switch (spec.fault) {
    case "stale-ui": {
      const rows = [...state.rows];
      if (!rows.length) throw new Error("stale-ui requires a visible row");
      const index = Math.abs(spec.seed) % rows.length;
      rows[index] = `${rows[index]} [stale ${spec.seed}]`;
      next = {
        ...state,
        status: saved,
        files: { ...state.files, "store.json": itemFile(rows, spec.seed), "store.meta.json": meta },
      };
      break;
    }
    case "interrupted-write": {
      const arrayStart = items.indexOf("[") + 1;
      const arrayEnd = items.lastIndexOf("]");
      const cut = arrayStart + 1 + (Math.abs(spec.seed) % (arrayEnd - arrayStart - 1));
      next = {
        ...state,
        status: saved,
        files: { ...state.files, "store.json": items.slice(0, cut) },
      };
      break;
    }
    case "partial-persistence":
      next = {
        ...state,
        status: saved,
        files:
          spec.seed % 2 === 0
            ? { ...state.files, "store.meta.json": meta }
            : { ...state.files, "store.json": items },
      };
      break;
    case "crash-mid-save":
      next = {
        ...state,
        windowGone: true,
        files: {
          ...state.files,
          "store.meta.json": `${JSON.stringify({ count: state.rows.length + 1, interrupted: spec.seed })}\n`,
        },
      };
      break;
    case "permission-denied":
      next = { ...state, status: spec.reportError ? "save failed: permission denied" : saved };
      break;
  }
  return {
    state: next,
    faultVersion: spec.version,
    event: {
      type: "fault-injection",
      timestamp: timestamp(spec.seed),
      fault: spec.fault,
      detail: `save fault, seed ${spec.seed}, version ${spec.version}`,
    },
  };
}

/** Relaunch reads durable state; it does not retain unsaved rows. */
export function relaunch(state: AppState): AppState {
  const parsed = JSON.parse(state.files["store.json"] ?? "") as { items: { text: string }[] };
  const rows = parsed.items.map((item) => item.text);
  return {
    ...state,
    rows,
    // A relaunch loads from disk, so the load-time text is the disk text: the stale-row
    // defect only stales a row renamed within the current boot session.
    loadedRows: rows,
    listbox: rows.map((s) => (s.length ? s[0]!.toUpperCase() + s.slice(1) : s)),
    status: "",
    deleted: [],
    windowGone: false,
  };
}

/** Save after the agent has re-read and reapplied its intended edits. */
export function recoverSave(state: AppState, seed: number) {
  if (state.windowGone) throw new Error("Relaunch and re-read before saving");
  const next = {
    ...state,
    files: {
      ...state.files,
      "store.json": itemFile(state.rows, seed),
      "store.meta.json": metaFile(state.rows),
    },
    status: `saved ${state.listbox.length} item(s)`,
  };
  return {
    state: next,
    event: {
      type: "recovery" as const,
      timestamp: timestamp(seed),
      event: "relaunch, re-read and save",
      stateVersion: 1,
    },
  };
}
