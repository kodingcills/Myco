/**
 * TIF-50 EF-001 — the app under test, faithfully reimplemented.
 *
 * `dogfood/apps/myco-todo/myco_todo.py` is the seed app, but a Tkinter window cannot
 * run in CI and its behaviour is only described in a docstring. This module is a
 * deterministic model of that app's *observable contract* — what the listbox shows,
 * what the status bar says, and what reaches disk — so the Foundry can prove the
 * trap fires instead of asserting it in prose.
 *
 * It models the app's real quirks, including the ones nobody documented:
 *   - the listbox capitalises the first letter of each entry ("buy milk" -> "Buy milk");
 *   - save writes trimmed, single-spaced text;
 *   - items whose trimmed text upper-cases to a "BUG" prefix never reach the store;
 *   - the status bar counts what is on screen, not what persisted.
 * These are exactly the seams where the screen and the file disagree.
 *
 * DO NOT use this to grade a run: grading lives in src/foundry/oracles/ and must not
 * share code with the app, or verifier bugs and app bugs would cancel out.
 */

import type { StoreVariant, TodoFixtureSpec } from "./todo.ts";
import { buildTodoInitialState, isDroppedByApp, statusSavedLine } from "./todo.ts";

/** The two files the app writes. The second one exists only while cleaning up. */
const ITEMS_FILE = "store.json";
const META_FILE = "store.meta.json";

function renderEntry(text: string): string {
  const trimmed = text.trim();
  return trimmed.length === 0 ? trimmed : trimmed[0]!.toUpperCase() + trimmed.slice(1);
}

/**
 * What the listbox shows for a row. The app adds through the Entry widget, and Tk's
 * Entry display does not collapse interior whitespace — the row is shown as typed.
 * Only the FIRST character is capitalised for display, by the listbox's render.
 */
function displayEntry(raw: string): string {
  const trimmed = raw.trim();
  return trimmed.length === 0 ? trimmed : trimmed[0]!.toUpperCase() + trimmed.slice(1);
}

function normalise(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

export interface AppState {
  /** Titles on screen, in order, exactly as rendered. */
  readonly listbox: readonly string[];
  /** The raw text each screen row came from, in the same order (what Save serialises from). */
  readonly rows: readonly string[];
  /** The last status-bar text. */
  readonly status: string;
  /** Files currently on disk. */
  readonly files: Readonly<Record<string, string>>;
  /** Entries deleted with the Delete button; removed from both screen and store on save. */
  readonly deleted: readonly string[];
}

/**
 * Builds the starting app state: parses the fixture's initial store exactly as the
 * app's `load_items` would, and renders it into the listbox.
 */
export function bootApp(spec: TodoFixtureSpec, variant: StoreVariant = "rewritten"): AppState {
  const items = spec.seedItems.filter((item) => item.role !== "deleted");
  // `rewritten` = what a previous save would have left; `exact` = the texts as typed.
  const stored = items
    .filter((item) => !isDroppedByApp(item.text))
    .map((item) => (variant === "exact" ? item.text : normalise(item.text)));
  const initialBytes = buildTodoInitialState(spec, variant).bytes;
  // Loading re-renders through the listbox, which capitalises; the store keeps the raw text.
  return {
    listbox: stored.map(renderEntry),
    rows: stored,
    status: "",
    files: { [ITEMS_FILE]: new TextDecoder().decode(initialBytes) },
    deleted: [],
  };
}

/**
 * The app's serialiser. The initial store must come out byte-identical to the fixture's
 * initial state, or the fixture and the model have drifted apart.
 */
function serialiseItems(items: readonly string[], addedAt: (index: number) => string): string {
  return `${JSON.stringify({ items: items.map((text, index) => ({ text, added_at: addedAt(index) })) }, null, 2)}\n`;
}

/** The Add button: append to the listbox and report success. */
export function addItem(state: AppState, text: string): AppState {
  const trimmed = text.trim();
  if (trimmed === "") return { ...state, status: "nothing to add" };
  return {
    ...state,
    listbox: [...state.listbox, displayEntry(trimmed)],
    rows: [...state.rows, trimmed],
    status: `added: ${trimmed}`,
  };
}

/** The Delete button: the entry leaves the screen immediately; the store waits for Save. */
export function deleteItem(state: AppState, renderedOrRaw: string): AppState {
  const target = renderEntry(normalise(renderedOrRaw));
  const index = state.listbox.indexOf(target);
  if (index === -1) return { ...state, status: `not found: ${renderedOrRaw}` };
  const kept = state.listbox.map((entry, index) => ({ entry, raw: state.rows[index] ?? entry }));
  return {
    ...state,
    listbox: kept.filter((row) => row.entry !== target).map((row) => row.entry),
    rows: kept.filter((row) => row.entry !== target).map((row) => row.raw),
    deleted: [...state.deleted, target],
    status: `deleted: ${target}`,
  };
}

/**
 * The Save button plus the fixture's planted defect.
 *
 * The defect is the difference between what the app intends to write and what it
 * actually writes. The status bar is computed from `state.listbox` either way — that
 * is the whole trap: it reports the screen, never the disk.
 */
export function saveApp(
  spec: TodoFixtureSpec,
  state: AppState,
  variant: StoreVariant = "rewritten",
): AppState {
  const shown = [...state.listbox];
  const intended = [...state.rows];
  const addedAt = initialTimestamps(spec, variant);

  switch (spec.defect) {
    case "silent-drop": {
      const persisted = intended.filter((entry) => !isDroppedByApp(entry));
      const items = persisted.map(normalise);
      return {
        ...state,
        status: statusSavedLine(shown.length),
        files: { [ITEMS_FILE]: serialiseItems(items, addedAt) },
      };
    }
    case "wrong-value": {
      // The save path treats "<label>: <value>" as a labelled entry and keeps only the value.
      const items = intended.map((entry) => normalise(entry.replace(/^[^:]{1,32}:\s*/, "")));
      return {
        ...state,
        status: statusSavedLine(shown.length),
        files: { [ITEMS_FILE]: serialiseItems(items, addedAt) },
      };
    }
    case "stale-row": {
      // The rename repaints the listbox, but the store serialises the pre-rename rows.
      // Any row that is new since boot is written normally; every pre-existing row keeps
      // the text it had when the app loaded.
      const items = shown.map((entry) => normalise(loadedTextFor(spec, entry) ?? entry));
      return {
        ...state,
        status: statusSavedLine(shown.length),
        files: { [ITEMS_FILE]: serialiseItems(items, addedAt) },
      };
    }
    case "partial-write": {
      const items = intended.map(normalise);
      const priorMeta = readMeta(state.files[META_FILE]);
      const meta = { ...priorMeta, count: priorMeta.count ?? shown.length + state.deleted.length };
      return {
        ...state,
        status: statusSavedLine(shown.length),
        files: {
          [ITEMS_FILE]: serialiseItems(items, addedAt),
          [META_FILE]: `${JSON.stringify(meta)}\n`,
        },
      };
    }
  }
}

/**
 * The store text (pre-rename) a rendered row corresponds to, if the row existed at load.
 * Indexed by the rendered form, since that is all the listbox keeps.
 */
function loadedTextFor(spec: TodoFixtureSpec, rendered: string): string | undefined {
  const loaded = spec.seedItems
    .filter((item) => item.role !== "deleted" && !isDroppedByApp(item.text))
    .map((item) => ({ rendered: renderEntry(normalise(item.text)), stored: normalise(item.text) }));
  return loaded.find((entry) => entry.rendered === rendered)?.stored;
}

/** The timestamps the fixture's initial store used; new entries keep the same clock. */
function initialTimestamps(spec: TodoFixtureSpec, variant: StoreVariant): () => string {
  const parsed = JSON.parse(
    new TextDecoder().decode(buildTodoInitialState(spec, variant).bytes),
  ) as {
    items: { added_at: string }[];
  };
  const last = parsed.items.at(-1)?.added_at ?? "2026-11-21T09:00:00.000Z";
  return () => last;
}

function readMeta(content: string | undefined): { count?: number } {
  if (content === undefined) return {};
  try {
    const parsed: unknown = JSON.parse(content);
    if (
      parsed &&
      typeof parsed === "object" &&
      "count" in parsed &&
      typeof parsed.count === "number"
    ) {
      return { count: parsed.count };
    }
    return {};
  } catch {
    return {};
  }
}

/** What an agent can see: every listbox row plus the status line, as screen lines. */
export function visibleScreen(state: AppState): string[] {
  const lines = [...state.listbox];
  if (state.status !== "") lines.push(state.status);
  return lines;
}

/** What the grader reads back: the files on disk, as bytes. */
export function persistedFiles(state: AppState): Record<string, Uint8Array> {
  const files: Record<string, Uint8Array> = {};
  for (const [path, content] of Object.entries(state.files)) {
    files[path] = new TextEncoder().encode(content);
  }
  return files;
}
