/**
 * Child process for the FIFO regression tests (round 2 D-B). A FIFO that blocks `open`
 * would freeze whichever process reads it, so the test runs the reader here and the parent
 * kills this process if it does not answer in time.
 *
 *   tsx test/gate/fifo-child.ts <static|swap>
 */
import { execFileSync } from "node:child_process";
import { renameSync } from "node:fs";
import { join } from "node:path";
import { fileEvidenceReader } from "../../src/gate/gate.ts";
import { S01_ITEMS, tempRoot, todoStore, writeState } from "./helpers.ts";

const STORE = ".myco-todo.json";
const mode = process.argv[2];
const root = tempRoot();
const path = writeState(root, "r", STORE, todoStore(S01_ITEMS));

if (mode === "static") {
  renameSync(path, join(root, "moved.json"));
  execFileSync("mkfifo", [path]);
}
const reader = fileEvidenceReader(root, {
  beforeOpen:
    mode === "swap"
      ? () => {
          // A FIFO replaces the regular file after the walk accepted it.
          renameSync(path, join(root, "moved.json"));
          execFileSync("mkfifo", [path]);
        }
      : undefined,
});
const outcome = await reader.read("r", STORE);
process.stdout.write(`${JSON.stringify(outcome.ok ? { ok: true } : outcome)}\n`);
