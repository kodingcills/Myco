/**
 * Evaluation Foundry — shared types (TIF-50 EF-001 / TIF-51 EF-002).
 *
 * The contract these types encode is docs/foundry/contract.md. Three rules matter
 * more than the shapes:
 *
 * 1. A fixture is data plus a loader. The expected end state is DERIVED by the
 *    oracle from `(intent, initialState)` and is never stored in the fixture.
 * 2. The state oracle may not see anything the agent produced. `expected()` takes
 *    a `TaskIntent` and an `InitialState`, never an `ActualState`.
 * 3. A pass needs the state oracle to see the intent satisfied AND the screen
 *    oracle to find no contradicting claim. `uncertain` is a real verdict and is
 *    never collapsed into either side.
 */

/** Apps the Foundry knows how to read persisted state for. */
export type AppId = "myco-todo" | "ledger-csv" | "writer-table";

/**
 * What the task asks for, in the app's own vocabulary. Kept deliberately small:
 * an intent that needs free-form code to interpret is an intent the oracle
 * cannot check without becoming a second agent.
 */
export type TaskIntent =
  | { kind: "todo.add-items"; items: readonly string[] }
  | { kind: "todo.rename-item"; from: string; to: string }
  | { kind: "todo.delete-items"; items: readonly string[] }
  | { kind: "ledger.set-cell"; rowKey: string; column: string; value: string }
  | { kind: "writer.set-cell"; table: string; cell: string; value: string };

/** The one row a `ledger.set-cell` intent targets, so a fixture can seed a table. */
export interface LedgerSeedRow {
  readonly rowKey: string;
  readonly cells: Readonly<Record<string, string>>;
}

/**
 * A fixture is a specification of an initial state and the defect it plants.
 * It contains NO expected answer: `expected()` derives that (contract §4).
 */
export interface FixtureManifest {
  readonly fixtureId: string;
  readonly app: AppId;
  /** Bump on ANY semantic change; scores are only comparable within one version. */
  readonly version: number;
  /** One paragraph describing what a human would see on screen. */
  readonly description: string;
  /**
   * Literal on-screen strings the fixture guarantees while the defect is armed.
   * The screen oracle matches these; a change to the app's status text breaks the
   * fixture loudly instead of silently passing the defect.
   */
  readonly screenClaimsToTrap: readonly string[];
  /** Paths (relative to the app's store root) the app writes; the trace guard watches these. */
  readonly persistenceFiles: readonly string[];
  /** Shortcuts the fixture exists to defeat. Checked by the trace guard. */
  readonly mustNotBeSolvableBy: readonly ("file-io" | "shell-exec")[];
  /** The initial state, built deterministically from the fixture id. */
  readonly initialState: InitialState;
  /**
   * The defect the fixture plants. `silent-drop` and `stale-row` are the two that
   * make a GUI-trusting verifier fail; `wrong-value` and `partial-write` are the
   * others in the EF-001 acceptance set.
   */
  readonly defect: FixtureDefectKind;
  /** Human-readable statement of how the screen and the persisted state disagree. */
  readonly disagreement: string;
}

export type FixtureDefectKind =
  /** The item appears in the list but is dropped at save; the status bar still counts it. */
  | "silent-drop"
  /** The persisted row keeps its old value while the screen shows the new one. */
  | "stale-row"
  /** The persisted value is normalized/rewritten (case, formatting) while the screen keeps the typed text. */
  | "wrong-value"
  /** A multi-file write lands in one file and not the other. */
  | "partial-write";

/** What the app's own persistence layer produced for the initial state. */
export type InitialState =
  | {
      readonly kind: "myco-todo";
      readonly storePath: string;
      readonly bytes: Uint8Array;
      /** Companion files the app had already written (e.g. store.meta.json). */
      readonly companionFiles: Readonly<Record<string, Uint8Array>>;
    }
  | {
      readonly kind: "ledger-csv";
      readonly storePath: string;
      readonly bytes: Uint8Array;
      readonly columns: readonly string[];
      readonly rows: readonly LedgerSeedRow[];
    }
  | {
      readonly kind: "writer-table";
      readonly storePath: string;
      readonly bytes: Uint8Array;
      /** The table's cell names in document order, e.g. ["A1","B1","A2","B2"]. */
      readonly cells: readonly string[];
    };

/** What the grader actually read back from the app after the trial. */
export type ActualState =
  | { readonly kind: "myco-todo"; readonly files: Readonly<Record<string, Uint8Array>> }
  | { readonly kind: "ledger-csv"; readonly files: Readonly<Record<string, Uint8Array>> }
  | { readonly kind: "writer-table"; readonly files: Readonly<Record<string, Uint8Array>> };

/** A single assertion result. `passed: null` means "could not look" (ADR-0002). */
export interface OracleCheck {
  readonly name: string;
  readonly passed: boolean | null;
  readonly reason: string;
  readonly weight: number;
}

export interface OracleVerdict {
  /** `verified` iff every check passed; `uncertain` if any check could not look and none failed. */
  readonly status: "verified" | "refuted" | "uncertain";
  readonly checks: readonly OracleCheck[];
  readonly reasons: readonly string[];
}

/**
 * A state oracle: a pure reader over persisted bytes. `expected()` must not take
 * an `ActualState`; TypeScript enforces the no-leak rule at the call site.
 */
export interface StateOracle {
  readonly app: AppId;
  readonly version: number;
  /** Parsed persisted state; throws `FoundryReadError` when it cannot look. */
  read(files: Readonly<Record<string, Uint8Array>>): unknown;
  /** Derives the expected end state from intent + initial state only (contract §4). */
  expected(intent: TaskIntent, initial: InitialState): unknown;
  /** Compares actual against expected; `null` passed = could not check. */
  compare(actual: unknown, expected: unknown): OracleCheck[];
}

/** Thrown when a read cannot establish the state; the caller maps it to `uncertain`. */
export class FoundryReadError extends Error {
  readonly reason: "missing" | "unreadable" | "corrupt";

  constructor(reason: "missing" | "unreadable" | "corrupt", message: string) {
    super(message);
    this.name = "FoundryReadError";
    this.reason = reason;
  }
}

/**
 * The screen oracle's view: the literal text an agent can see, plus whether the
 * persistence file was readable. It never sees parsed state.
 */
export interface ScreenView {
  /** Lines of visible text an agent could read off the screen. */
  readonly visibleText: readonly string[];
  /** Whether the app was still running / the screen could be read at all. */
  readonly reachable: boolean;
}

export interface ScreenClaim {
  /** The literal claim, matched as a substring of a visible line. */
  readonly text: string;
  /** Which persisted fact it contradicts, for the report. */
  readonly contradicts: string;
}

/** One GUI act the runtime recorded, sufficient to reconcile with file changes. */
export interface TraceAct {
  readonly kind: "click" | "typeText" | "setValue" | "keyPress" | "waitFor" | "launch";
  /** Free-form target, e.g. a ref or an element name. */
  readonly target?: string;
  readonly detail?: string;
}

/** A trace event the guard understands; unknown event kinds are ignored. */
export type GuardTraceEvent =
  | { readonly type: "run-start"; readonly timestamp: string }
  | {
      readonly type: "tool-call";
      readonly timestamp: string;
      readonly callId: string;
      readonly via: "gui" | "file-io" | "shell-exec";
    }
  | {
      readonly type: "action";
      readonly timestamp: string;
      readonly step: number;
      readonly callId?: string;
      readonly action: TraceAct;
    }
  | {
      readonly type: "save-observed";
      readonly timestamp: string;
      /** Which persistence files existed at that moment, with their bytes. */
      readonly files: Readonly<Record<string, Uint8Array>>;
    }
  | {
      readonly type: "file-write";
      readonly timestamp: string;
      readonly path: string;
      readonly via: "file-io" | "shell-exec";
    };

export interface TraceGuardResult {
  readonly status:
    | "clean"
    | "file-io-shortcut"
    | "unreconciled-change"
    | "not-launched"
    | "unknown";
  readonly reasons: readonly string[];
}

/** The full scored record for one trial. */
export interface FoundryTrialResult {
  readonly fixtureId: string;
  readonly fixtureVersion: number;
  readonly oracleVersion: number;
  readonly faultVersion: number;
  readonly verdict: "verified" | "refuted" | "uncertain";
  /** `true` iff the agent claimed success (self-report) AND the verdict is not `verified`. */
  readonly falseSuccess: boolean;
  readonly stateChecks: readonly OracleCheck[];
  readonly screenClaims: readonly ScreenClaim[];
  readonly traceGuard: TraceGuardResult;
  readonly reasons: readonly string[];
}

/** Bytes <-> text at the persistence boundary. Exported because every fixture and oracle needs it. */
export const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);
export const decodeBytes = (bytes: Uint8Array): string =>
  new TextDecoder("utf-8", { fatal: false }).decode(bytes);
