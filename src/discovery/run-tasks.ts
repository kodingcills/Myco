/**
 * Task packages `myco-run` can execute (MVD-001 acceptance 1/3).
 *
 * The items are `S0_TASKS`' — one list, not a second copy, so the quickstart's
 * `--task df-s02` exercises exactly the sequence the S0 evidence run exercises.
 * What is added here is what a CLI needs and a test fixture does not: the guest
 * paths the app writes (`--store` and `MYCO_TODO_STATE_FILE`), a relative store
 * path the session's read grant can reach, and the sentence the agent's claim is
 * compared against.
 */
import { S0_TASKS } from "./s0-sequence.ts";

export interface RunTask {
  /** Stable id: the CLI `--task` value and the artifact directory name. */
  readonly id: string;
  readonly title: string;
  readonly items: readonly string[];
  /** What the mock transport is expected to return, so a CLI summary can say "unexpected". */
  readonly expected: "verified" | "refuted";
  /**
   * The claim an agent makes after the UI says the save succeeded. It is recorded
   * beside the persisted store so a refuted run can be named a false success
   * without reading an agent transcript (acceptance 2's shape; the oracle, not
   * the transcript, decides).
   */
  readonly agentClaim: string;
  /** Guest-side invocation of the dogfood app. */
  readonly launch: {
    readonly command: string;
    readonly args: readonly string[];
  };
  /** Store path as written into the app's argv (the same shape the S0 live run uses). */
  readonly storeArg: string;
  /** Store path relative to the session's read root; this is what the transport reads. */
  readonly storePath: string;
  /** Absolute path on the development host, for the live path's store read. */
  readonly hostStorePath: string;
  /**
   * The app's own published widget state. The live transport reads it to obtain
   * the UI's status line; without it a live run cannot record the claim.
   */
  readonly statePath: string;
}

const GUEST_HOME = "/home/myco";
const HOST_HOME = "~";

function task(id: string): (typeof S0_TASKS)[number] {
  const found = S0_TASKS.find((entry) => entry.id === id);
  if (!found) throw new Error(`no S0 task "${id}" in S0_TASKS; run-tasks.ts is out of sync`);
  return found;
}

export function runTask(id: string): RunTask {
  const source = task(id);
  return {
    id: source.id,
    title: source.title,
    items: [...source.items],
    expected: source.expected,
    agentClaim: `All ${source.items.length} items added and saved.`,
    launch: {
      command: "bash",
      args: [
        "-lc",
        `MYCO_TODO_STATE_FILE=${GUEST_HOME}/.myco-todo-state.json python3 ${GUEST_HOME}/myco-todo/myco_todo.py --store ${GUEST_HOME}/.myco-todo.json`,
      ],
    },
    storeArg: `${GUEST_HOME}/.myco-todo.json`,
    storePath: ".myco-todo.json",
    hostStorePath: `${HOST_HOME}/.myco-todo.json`,
    statePath: `${GUEST_HOME}/.myco-todo-state.json`,
  };
}

export const RUN_TASK_IDS: readonly string[] = S0_TASKS.map((entry) => entry.id);
