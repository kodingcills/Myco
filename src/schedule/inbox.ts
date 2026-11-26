/**
 * Track S: the file-arrival trigger. An operator-configured inbox directory is scanned on
 * each tick; every regular file in it is one event, keyed by its name AND content digest
 * (so the same name re-delivered with new content is a new event, and the same file seen
 * twice is not).
 *
 * The scan never follows a symlink (a link could point out of the inbox), ignores dotfiles
 * (editors' and copy tools' partial files) and sub-directories, and refuses to hash a file
 * over `MAX_INBOX_FILE_BYTES`. Files are not moved, deleted or passed to the agent: the run
 * learns the arriving file's name and digest only, and the gate's inputs are unchanged.
 */

import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const MAX_INBOX_FILE_BYTES = 64 * 1024 * 1024;
const NAME = /^[^.\0/\\\p{Cc}][^\0/\\\p{Cc}]{0,199}$/u;

export interface InboxFile {
  readonly name: string;
  readonly sha256: string;
}

/** Regular, visible files in `dir`, sorted by name, each with its SHA-256. */
export function scanInbox(dir: string, cache: Map<string, string> = new Map()): InboxFile[] {
  const out: InboxFile[] = [];
  const entries = readdirSync(dir, { withFileTypes: true })
    .filter((d) => !d.isDirectory() && NAME.test(d.name))
    .map((d) => d.name)
    .sort();
  for (const name of entries) {
    const path = join(dir, name);
    const st = lstatSync(path);
    // lstat, not stat: a symlink is never followed out of the inbox.
    if (!st.isFile() || st.size > MAX_INBOX_FILE_BYTES) continue;
    const ck = `${path}\0${st.size}\0${st.mtimeMs}\0${st.ino}`;
    let digest = cache.get(ck);
    if (!digest) {
      digest = createHash("sha256").update(readFileSync(path)).digest("hex");
      cache.set(ck, digest);
    }
    out.push({ name, sha256: digest });
  }
  return out;
}
