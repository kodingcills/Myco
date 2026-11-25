/**
 * Operator task sources for the gate (TIF-265): the built-in `myco-run` tasks and an
 * operator JSON file. Both are read by the operator's process; neither is reachable
 * through a gate request.
 */
import { readFileSync } from "node:fs";
import { RUN_TASK_IDS, runTask } from "../discovery/run-tasks.ts";
import type { TaskEntry } from "./gate.ts";

/**
 * `myco-run`'s tasks (df-s01, df-s02) as gate tasks. The state file is the task's store
 * path relative to the session read root, so a run's evidence location mirrors that root.
 */
export function builtinTasks(): TaskEntry[] {
  return RUN_TASK_IDS.map((id) => {
    const task = runTask(id);
    return {
      id: task.id,
      title: task.title,
      family: "todo-items",
      stateFile: task.storePath,
      spec: { items: [...task.items] },
    };
  });
}

/**
 * Read an operator tasks file: `{ "tasks": [ { id, family, stateFile, spec, title? } ] }`.
 * Shape errors throw; spec validation happens in `buildRegistry`.
 */
export function loadTasksFile(path: string): TaskEntry[] {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  const tasks = (parsed as { tasks?: unknown } | null)?.tasks;
  if (!Array.isArray(tasks)) throw new Error(`${path}: expected { "tasks": [...] }`);
  return tasks.map((raw, index) => {
    if (typeof raw !== "object" || raw === null)
      throw new Error(`${path}: tasks[${index}] is not an object`);
    const entry = raw as Record<string, unknown>;
    return {
      id: String(entry.id),
      family: String(entry.family),
      stateFile: String(entry.stateFile),
      spec: entry.spec,
      ...(typeof entry.title === "string" ? { title: entry.title } : {}),
    };
  });
}
