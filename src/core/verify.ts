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

export interface Verifier {
  verify(persisted: PersistedState, intent: TaskIntent): Verdict;
}
