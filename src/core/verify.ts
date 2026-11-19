export interface PersistedState {
  kind: "csv";
  filePath: string;
  cells: Record<string, string>;
}

export interface TaskIntent {
  taskId: string;
  params: Record<string, unknown>;
  describe: string;
}

export type VerdictStatus = "verified" | "refuted" | "uncertain";

export interface Verdict {
  status: VerdictStatus;
  reasons: string[];
}

/**
 * Pure function over (PersistedState, TaskIntent). Verdicts are three-valued:
 * `verified` (effect proven in persisted state), `refuted` (effect provably
 * absent), `uncertain` (could not look — persisted state unreadable, missing,
 * or corrupt). `uncertain` is never collapsed into `refuted` or `verified`.
 * A read failure of the persisted state MUST surface as `uncertain`, never as
 * an empty `PersistedState` that would refute-by-default (ADR-0002).
 */
export interface Verifier {
  verify(persisted: PersistedState, intent: TaskIntent): Verdict;
}
