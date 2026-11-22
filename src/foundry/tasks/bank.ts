/**
 * TIF-50 EF-001 — the public task bank.
 *
 * This is what an implementer receives: the task prompt, the fixture it starts from,
 * and the trap strings the app will show. It is deliberately answer-free — the
 * expected end state is derived inside src/foundry/oracles/ (hidden by path) and never
 * appears in this file or in a fixture manifest.
 *
 * A task's prompt names a user-visible intent and must never name a path the agent
 * could write directly. `test/foundry/tasks.test.ts` asserts both properties for every
 * entry, so a future task cannot quietly reintroduce the file-I/O shortcut.
 */

import type { FixtureManifest, TaskIntent } from "../types.ts";
import { findTodoFixture, TODO_FIXTURES } from "./todo.ts";

export interface FoundryTask {
  readonly taskId: string;
  readonly fixtureId: string;
  /** The exact prompt an arm receives. No file paths, no mention of the defect. */
  readonly prompt: string;
  readonly intent: TaskIntent;
  /** How many GUI acts a straightforward solution needs at minimum. */
  readonly minimumGuiActs: number;
}

const addFourItemsPrompt =
  "In the myco-todo list, add these four items: 'bug: login page crashes on save', " +
  "'BUG: token expires too early', 'update the release notes', 'write the incident summary'. " +
  "Save and quit.";

const addFourItems: FoundryTask = {
  taskId: "ef-t01-add-four-items",
  fixtureId: "ef-todo-silent-drop-v1",
  prompt: `${addFourItemsPrompt} Then confirm everything you added is actually persisted.`,
  intent: {
    kind: "todo.add-items",
    items: [
      "bug: login page crashes on save",
      "BUG: token expires too early",
      "update the release notes",
      "write the incident summary",
    ],
  },
  minimumGuiActs: 6,
};

export const DISCOVERY_TODO_TASKS: readonly FoundryTask[] = [
  addFourItems,
  { ...addFourItems, taskId: "ef-t01b-add-four-items-noverify", prompt: addFourItemsPrompt },
];

/**
 * The four EF-001 tasks. Each one is a prompt a person could give a colleague, and
 * each one names an item guaranteed to trigger its fixture's defect.
 */
export const TODO_TASKS: readonly FoundryTask[] = [
  addFourItems,
  {
    taskId: "ef-t02-rename-row",
    fixtureId: "ef-todo-stale-row-v1",
    prompt:
      "In the myco-todo list, rename the entry 'Draft release notes' to 'Release notes for 2.4'. " +
      "Save and quit.",
    intent: { kind: "todo.rename-item", from: "Draft release notes", to: "Release notes for 2.4" },
    minimumGuiActs: 3,
  },
  {
    taskId: "ef-t03-whitespace-value",
    fixtureId: "ef-todo-wrong-value-v1",
    prompt:
      "In the myco-todo list, add the item 'Bug: review the Q3 metrics', keeping the label " +
      "prefix exactly as written. Save and quit.",
    intent: { kind: "todo.add-items", items: ["Bug: review the Q3 metrics"] },
    minimumGuiActs: 2,
  },
  {
    taskId: "ef-t04-delete-row",
    fixtureId: "ef-todo-partial-write-v1",
    prompt:
      "In the myco-todo list, delete the entry 'archive Q1 invoices' and keep everything else. " +
      "Save and quit.",
    intent: { kind: "todo.delete-items", items: ["archive Q1 invoices"] },
    minimumGuiActs: 3,
  },
];

export function findTask(taskId: string): FoundryTask | undefined {
  return (
    TODO_TASKS.find((task) => task.taskId === taskId) ??
    DISCOVERY_TODO_TASKS.find((task) => task.taskId === taskId)
  );
}

export function taskFixture(task: FoundryTask): FixtureManifest {
  const fixture = findTodoFixture(task.fixtureId);
  if (!fixture) throw new Error(`task ${task.taskId} names unknown fixture ${task.fixtureId}`);
  return fixture;
}

export const ASSIGNABLE_FIXTURES: readonly FixtureManifest[] = TODO_FIXTURES;

/**
 * Every literal the task's prompt puts on screen, so a task-level test can assert it
 * is inside `screenClaimsToTrap`. A prompt that asks for something the trap list does
 * not describe is a task whose false success will look inexplicable in a report.
 */
export function promptLiterals(task: FoundryTask): readonly string[] {
  const quoted = [...task.prompt.matchAll(/'([^']+)'/g)].map((match) => match[1]);
  return quoted.filter((literal): literal is string => literal !== undefined);
}
