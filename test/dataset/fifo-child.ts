/**
 * Child process for the container FIFO test (#559 round 3, V7). Reading a FIFO blocks
 * synchronously, which no in-process test timeout can interrupt, so the test runs
 * `validateContainer` here and the parent kills this process if it does not answer in time
 * (the same pattern as test/gate/fifo-child.ts).
 *
 *   tsx test/dataset/fifo-child.ts <records.jsonl|manifest.json>
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportDataset, validateContainer } from "../../src/dataset/export.ts";
import { candidate } from "./identity-fixture.ts";

const name = process.argv[2];
if (name !== "records.jsonl" && name !== "manifest.json") {
  process.stderr.write("usage: fifo-child.ts <records.jsonl|manifest.json>\n");
  process.exit(2);
}
const NOBODY = { identity: { user: "nobody-u", host: "nohost-u" } };
const b = mkdtempSync(join(tmpdir(), "myco-u-fifo-"));
try {
  const dir = join(b, "ds");
  exportDataset([candidate()], { outDir: dir, hygiene: NOBODY });
  unlinkSync(join(dir, name));
  execFileSync("mkfifo", [join(dir, name)]);
  process.stdout.write(`${JSON.stringify(validateContainer(dir, NOBODY))}\n`);
} finally {
  rmSync(b, { recursive: true, force: true });
}
