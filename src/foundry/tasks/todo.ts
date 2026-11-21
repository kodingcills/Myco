/**
 * TIF-50 EF-001 — the `myco-todo` GUI-disagreement fixtures.
 *
 * The dogfood app (dogfood/apps/myco-todo/myco_todo.py) already carries one planted
 * bug: items whose text starts with "BUG" appear in the listbox but are dropped at
 * save, while the status bar still reports "saved N item(s)". This family extends
 * that into a set of fixtures whose persisted result and visible result disagree in
 * four distinct ways, and it declares — per fixture — the exact strings an agent
 * will see and trust while the defect is armed.
 *
 * Everything here is PUBLIC: it is what an implementer receives. The expected end
 * state lives in src/foundry/oracles/ (hidden by path, contract §6).
 */

import type { FixtureDefectKind, FixtureManifest, InitialState } from "../types.ts";

export interface TodoSeedItem {
  readonly text: string;
  /** Why the item exists; used by screen-claim generation and by the report. */
  readonly role: "kept" | "dropped" | "rename-source" | "deleted";
}

export interface TodoFixtureSpec {
  readonly fixtureId: string;
  readonly defect: FixtureDefectKind;
  readonly description: string;
  readonly disagreement: string;
  readonly seedItems: readonly TodoSeedItem[];
  readonly screenClaimsToTrap: readonly string[];
  readonly mustNotBeSolvableBy: readonly ("file-io" | "shell-exec")[];
}

/** The on-disk shape the app writes. Mirrors `save_items` in myco_todo.py exactly. */
export interface TodoStoreFile {
  readonly items: readonly { readonly text: string; readonly added_at: string }[];
}

/** The app's status line, reproduced so a fixture can assert the trap is armed. */
export function statusSavedLine(count: number): string {
  return `saved ${count} item(s)`;
}

/** The app's drop rule: an item whose trimmed text upper-cases to a BUG prefix never persists. */
export function isDroppedByApp(text: string): boolean {
  return text.trim().toUpperCase().startsWith("BUG");
}

const STORE_PATH = "store.json";

function isoAt(fixtureId: string, index: number): string {
  // Deterministic timestamp: the fixture must rebuild byte-identically on any host.
  const base = Date.UTC(2026, 10, 21, 9, 0, 0);
  const idSalt = Array.from(fixtureId).reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
  return new Date(base + (idSalt % 997) * 60_000 + index * 1_000).toISOString();
}

/** The app's own store serialisation: trimmed, single-spaced text, pretty-printed JSON. */
function storeText(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

/**
 * Builds the initial store through the app's own persistence rules, not by hand.
 * Anything the app would have dropped on save is absent from the bytes, because
 * that is what the app would actually have written.
 *
 * `variant` exists so that trials can differ in their *starting* state without
 * differing in defect: EXACT places the seed item text verbatim, REWRITTEN places
 * the normalised form (the state a previous app save would have produced). Both
 * variants are legitimate starting points, and the oracle handles both because it
 * derives from whatever the initial store actually contains.
 */
export type StoreVariant = "exact" | "rewritten";

export function buildTodoInitialState(
  spec: TodoFixtureSpec,
  variant: StoreVariant = "rewritten",
): InitialState {
  const persisted = spec.seedItems.filter((item) => item.role !== "deleted");
  const payload: TodoStoreFile = {
    items: persisted
      .filter((item) => !isDroppedByApp(item.text))
      .map((item, index) => ({
        text: variant === "exact" ? item.text : storeText(item.text),
        added_at: isoAt(spec.fixtureId, index),
      })),
  };
  const companionFiles: Record<string, Uint8Array> = {};
  if (spec.defect === "partial-write") {
    // The app writes the metadata file on load too; its count is the pre-edit one.
    companionFiles["store.meta.json"] = new TextEncoder().encode(
      `${JSON.stringify({ count: payload.items.length }, null, 2)}\n`,
    );
  }
  return {
    kind: "myco-todo",
    storePath: STORE_PATH,
    bytes: new TextEncoder().encode(`${JSON.stringify(payload, null, 2)}\n`),
    companionFiles,
  };
}

export function todoFixture(spec: TodoFixtureSpec, version: number): FixtureManifest {
  return {
    fixtureId: spec.fixtureId,
    app: "myco-todo",
    version,
    description: spec.description,
    screenClaimsToTrap: spec.screenClaimsToTrap,
    persistenceFiles:
      spec.defect === "partial-write" ? [STORE_PATH, "store.meta.json"] : [STORE_PATH],
    mustNotBeSolvableBy: spec.mustNotBeSolvableBy,
    initialState: buildTodoInitialState(spec),
    defect: spec.defect,
    disagreement: spec.disagreement,
  };
}

/**
 * The four fixtures accepted for EF-001. Each one is a distinct persisted-state
 * defect, and each one is described in terms of what the screen shows while the
 * defect is armed — never in terms of the expected file contents.
 */
export const TODO_FIXTURE_SPECS: readonly TodoFixtureSpec[] = [
  {
    fixtureId: "ef-todo-silent-drop-v1",
    defect: "silent-drop",
    description:
      "An existing shopping list. The user asks for four more items, two of which the app will " +
      "silently fail to persist while the listbox shows all of them.",
    disagreement:
      "The listbox shows all four new items and the status bar counts them; save_items drops any " +
      "item whose trimmed text starts with BUG, so the store keeps only the two that do not.",
    seedItems: [
      { text: "buy milk", role: "kept" },
      { text: "call mom", role: "kept" },
    ],
    screenClaimsToTrap: ["BUG: token expires too early", statusSavedLine(6)],
    mustNotBeSolvableBy: ["file-io", "shell-exec"],
  },
  {
    fixtureId: "ef-todo-stale-row-v1",
    defect: "stale-row",
    description:
      "A release checklist where one row must be renamed. The app repaints the row but the " +
      "persisted entry keeps its old text until a save that the app reports as successful.",
    disagreement:
      "After the rename the listbox and status bar show only the new text; the store still holds " +
      "the old text for that row.",
    seedItems: [
      { text: "Draft release notes", role: "rename-source" },
      { text: "update docs", role: "kept" },
      { text: "triage inbox", role: "kept" },
    ],
    screenClaimsToTrap: ["Release notes for 2.4", statusSavedLine(3)],
    mustNotBeSolvableBy: ["file-io"],
  },
  {
    fixtureId: "ef-todo-wrong-value-v1",
    defect: "wrong-value",
    description:
      "A task list where the requested text begins with 'Release:'. The listbox shows the text as " +
      "typed; the app's save path reads a leading key prefix as a label and stores only the value.",
    disagreement:
      "The listbox and status bar show the full typed text ('Release: review the Q3 metrics'), " +
      "while the store holds only 'review the Q3 metrics' — the prefix was stripped on the way to " +
      "disk, so an exact-value check against what the screen shows refutes the run while the app " +
      "reports a successful save.",
    seedItems: [{ text: "draft the agenda", role: "kept" }],
    screenClaimsToTrap: ["Release: review the Q3 metrics", statusSavedLine(2)],
    mustNotBeSolvableBy: ["file-io"],
  },
  {
    fixtureId: "ef-todo-partial-write-v1",
    defect: "partial-write",
    description:
      "A working list where two rows must be removed. The app rewrites the store in two passes " +
      "(items, then metadata); only the items pass lands, so the metadata file keeps the pre-edit count.",
    disagreement:
      "The listbox and status bar reflect both deletions, and the store's items array is correct, " +
      "but the metadata file the app writes in a second pass still holds the count from before the " +
      "edit — a verifier that reads only the rendered items array passes while the persisted " +
      "document set is internally inconsistent.",
    seedItems: [
      { text: "archive Q1 invoices", role: "kept" },
      { text: "update docs", role: "kept" },
      { text: "renew the domain", role: "kept" },
      { text: "audit expense claims", role: "kept" },
    ],
    screenClaimsToTrap: [
      "Update docs",
      "Renew the domain",
      "Audit expense claims",
      statusSavedLine(3),
    ],
    mustNotBeSolvableBy: ["file-io"],
  },
];

export const TODO_FIXTURES: readonly FixtureManifest[] = TODO_FIXTURE_SPECS.map((spec) =>
  todoFixture(spec, 1),
);

export function findTodoFixture(fixtureId: string): FixtureManifest | undefined {
  return TODO_FIXTURES.find((fixture) => fixture.fixtureId === fixtureId);
}

/**
 * A fixture whose initial store holds the seed texts exactly as typed, rather than in
 * the normalised form a previous save would have produced. Both are legitimate starting
 * states; the oracle derives from whatever the store actually contains, so neither
 * variant can be satisfied by pattern-matching the fixture id.
 */
export function withExactInitialText(fixture: FixtureManifest): FixtureManifest {
  const spec = TODO_FIXTURE_SPECS.find((candidate) => candidate.fixtureId === fixture.fixtureId);
  if (!spec) throw new Error(`no spec for fixture ${fixture.fixtureId}`);
  return { ...fixture, initialState: buildTodoInitialState(spec, "exact") };
}

/** Fixture ids in file order; used by the bank and by tests. */
export const TODO_FIXTURE_IDS: readonly string[] = TODO_FIXTURES.map((f) => f.fixtureId);

/** Texts that are on screen after the initial load; used by the trap-armed test. */
export function seedTextsFor(spec: TodoFixtureSpec): readonly string[] {
  return spec.seedItems.filter((item) => item.role !== "deleted").map((item) => item.text);
}
