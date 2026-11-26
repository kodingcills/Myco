/**
 * Track R (task recording to automation): the shapes a demonstration passes through.
 *
 *   human demonstration ──recorder──▶ Recording (semantic actions + before/after document)
 *   Recording ──compiler──▶ Workflow (parameterized steps) + DerivedOracle (allowlisted
 *                            assertions over the persisted document)
 *   Workflow + bindings + fresh fixture ──replay──▶ saved document ──▶ gate (derived family,
 *                            only after the R5 self-test passed) and independent grader
 *
 * Every shape here is data. Nothing in a recording, a workflow or a derived oracle is code,
 * and nothing in them is ever evaluated as code: the oracle evaluator interprets a closed
 * set of assertion types (`DERIVED_ASSERTION_TYPES`) and refuses anything else.
 */
import type { SensitiveKind } from "./scrub.ts";

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

export const RECORDING_SCHEMA = "myco.recording/1";

/** The document as the recorder saw it on disk: its digest and its rows (header first). */
export interface DocumentSnapshot {
  readonly sha256: string;
  readonly rows: readonly (readonly string[])[];
}

/**
 * A recorded action. App-level (semantic) actions come from the application's own event
 * model (on the Linux path, Calc's UNO modify and document-event listeners); `gui` actions
 * are the fallback when only an input event is known. A GUI action keeps the event kind
 * and the cell that had focus, nothing else: no key text, no window title, no clipboard,
 * no pointer coordinates.
 */
export type RecordedAction =
  | {
      readonly seq: number;
      readonly kind: "cell-edit";
      readonly source: "app";
      readonly cell: string;
      readonly value: string;
    }
  | { readonly seq: number; readonly kind: "save"; readonly source: "app" | "gui" }
  | {
      readonly seq: number;
      readonly kind: "gui";
      readonly event: "key" | "click";
      readonly cell: string | null;
    };

export interface Recording {
  readonly schema: typeof RECORDING_SCHEMA;
  readonly recordingId: string;
  readonly app: "calc";
  /** A logical name only. The recorder never stores the document's path. */
  readonly documentName: "document.csv";
  /** True when the "human" was a script (tests, demo). Simulated recordings are never evidence. */
  readonly simulated: boolean;
  /** Operator-started and visible: who started it, and that the indicator was shown. */
  readonly consent: {
    readonly startedBy: "operator";
    readonly indicatorShown: true;
    /** Whether an interactive terminal confirmed the start (false for a scripted human). */
    readonly interactive: boolean;
  };
  readonly recorder: { readonly name: string; readonly version: string };
  readonly startedAt: string;
  readonly stoppedAt: string;
  readonly before: DocumentSnapshot;
  readonly after: DocumentSnapshot;
  readonly actions: readonly RecordedAction[];
  /** Strings the recorder refused to store (JSON path and kind; never the content). */
  readonly redactions: ReadonlyArray<{ readonly field: string; readonly kind: SensitiveKind }>;
  /** How many raw event fields were dropped because they are not on the allowlist. */
  readonly droppedFields: number;
}

/**
 * A raw event from a demonstration source. Untrusted shape: the recorder keeps only the
 * allowlisted fields of the known event types and drops the rest.
 */
export type SourceEvent = { readonly type: string } & Readonly<Record<string, unknown>>;

// ---------------------------------------------------------------------------
// Workflow
// ---------------------------------------------------------------------------

export const WORKFLOW_SCHEMA = "myco.workflow/1";

export type ColumnKind = "text" | "integer" | "date" | "currency";

/** A value in a workflow: a literal, or a named parameter bound at replay time. */
export type ValueRef = { readonly param: string };

export interface WorkflowParameter {
  readonly name: string;
  /** `record` parameters name a row key; `value` parameters name a cell value. */
  readonly role: "record" | "value";
  readonly kind: ColumnKind | "key";
  /** The value the human demonstrated. Replay with no binding uses it. */
  readonly demonstrated: string;
}

export type WorkflowStep =
  | {
      readonly op: "set-cell";
      readonly rowKey: ValueRef;
      readonly column: string;
      readonly value: ValueRef;
      /** Where this step came from in the recording. */
      readonly evidence: "app" | "gui-fallback";
    }
  | { readonly op: "save" };

export interface Workflow {
  readonly schema: typeof WORKFLOW_SCHEMA;
  readonly workflowId: string;
  readonly app: "calc";
  readonly recordingSha256: string;
  readonly simulated: boolean;
  /** The document's header row, which a replay fixture must match exactly. */
  readonly header: readonly string[];
  readonly parameters: readonly WorkflowParameter[];
  readonly steps: readonly WorkflowStep[];
}

// ---------------------------------------------------------------------------
// Derived oracle
// ---------------------------------------------------------------------------

export const DERIVED_ORACLE_SCHEMA = "myco.derived-oracle/1";

/** The closed set of assertion types a derived oracle may use. Anything else is refused. */
export const DERIVED_ASSERTION_TYPES = [
  "header-equals-fixture",
  "cell-equals",
  "others-equal-fixture",
] as const;
export type DerivedAssertionType = (typeof DERIVED_ASSERTION_TYPES)[number];

export type DerivedAssertion<V> =
  | { readonly type: "header-equals-fixture" }
  | { readonly type: "cell-equals"; readonly rowKey: V; readonly column: string; readonly value: V }
  | { readonly type: "others-equal-fixture" };

/**
 * A derived oracle before binding: values are parameter references. Labelled `derived`
 * everywhere it appears: lower trust than a built-in oracle, never R1 evidence.
 */
export interface DerivedOracle {
  readonly schema: typeof DERIVED_ORACLE_SCHEMA;
  readonly trust: "derived";
  readonly workflowId: string;
  readonly assertions: readonly DerivedAssertion<ValueRef>[];
}

/** A derived oracle with every parameter bound to a literal: what the gate family checks. */
export interface BoundDerivedOracle {
  readonly schema: typeof DERIVED_ORACLE_SCHEMA;
  readonly trust: "derived";
  readonly workflowId: string;
  readonly assertions: readonly DerivedAssertion<string>[];
}

/** One edit a bound workflow is meant to make. */
export interface KeyedEdit {
  readonly rowKey: string;
  readonly column: string;
  readonly value: string;
}
