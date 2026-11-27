/**
 * The newcomer path (TIF-265 track D): the commands a newcomer types come from the docs,
 * not from this harness. Each documented block that is part of the path carries a marker
 * on the line just before its fence:
 *
 *     <!-- newcomer-path: <name> -->
 *     ```sh
 *     /path/to/Myco/bin/myco init --dry-run   # a comment
 *     ```
 *
 * `markedBlock` returns the block's commands (comments stripped, blank lines dropped).
 * `substitute` fills the documented placeholders and fails on any other `/path/to/...`, so
 * a placeholder a newcomer would have to guess is drift, not something the harness fixes.
 * Pure: no file, process or environment access. Used by newcomer-docs.test.ts (static
 * drift, every run) and newcomer-path.test.ts (the live run on a fresh clone).
 */

export const MARKER_PREFIX = "<!-- newcomer-path:";

/** The documented placeholders and what the harness puts in their place. */
export interface Placeholders {
  /** `/path/to/Myco`: the fresh clone. */
  readonly myco: string;
  /** `/path/to/your/project`: the newcomer's (empty) project directory. */
  readonly project: string;
}

/** Strip a trailing ` # comment` (the docs never quote a `#`) and surrounding space. */
export function stripComment(line: string): string {
  const at = line.search(/(^|\s)#/);
  return (at === -1 ? line : line.slice(0, at)).trim();
}

/** The commands of the fenced `sh` block right after `<!-- newcomer-path: name -->`. */
export function markedBlock(markdown: string, name: string): string[] {
  const lines = markdown.split(/\r?\n/);
  const marker = `${MARKER_PREFIX} ${name} -->`;
  const hits = lines.flatMap((l, i) => (l.trim() === marker ? [i] : []));
  if (hits.length !== 1) {
    throw new Error(`expected exactly one "${marker}", found ${hits.length}`);
  }
  const at = hits[0] as number;
  if (lines[at + 1]?.trim() !== "```sh") {
    throw new Error(`"${marker}" must be followed directly by a \`\`\`sh fence`);
  }
  const commands: string[] = [];
  for (let i = at + 2; i < lines.length; i++) {
    const line = lines[i] as string;
    if (line.trim() === "```") {
      if (commands.length === 0) throw new Error(`"${marker}" block has no command`);
      return commands;
    }
    const command = stripComment(line);
    if (command !== "") commands.push(command);
  }
  throw new Error(`"${marker}" block is not closed`);
}

/** Every marker name in a document, in order. */
export function markerNames(markdown: string): string[] {
  const re = /^\s*<!-- newcomer-path: ([a-z0-9-]+) -->\s*$/gm;
  return [...markdown.matchAll(re)].map((m) => m[1] as string);
}

/** Fill `/path/to/Myco` and `/path/to/your/project`; any other `/path/to/` is drift. */
export function substitute(command: string, p: Placeholders): string {
  const out = command
    .replaceAll("/path/to/your/project", p.project)
    .replaceAll("/path/to/Myco", p.myco);
  const left = out.match(/\/path\/to\/\S*/);
  if (left) throw new Error(`undocumented placeholder ${left[0]} in: ${command}`);
  return out;
}

/** The argv after `myco init` in a command, or null when the command is not an init. */
export function initArgv(command: string): string[] | null {
  const words = command.split(/\s+/).filter((w) => w !== "");
  const at = words.findIndex(
    (w, i) => (w.endsWith("/bin/myco") || w === "myco") && words[i + 1] === "init",
  );
  return at === -1 ? null : words.slice(at + 2);
}

/** Whitespace-normalised, for comparing a command across documents. */
export function normalise(command: string): string {
  return command
    .split(/\s+/)
    .filter((w) => w !== "")
    .join(" ");
}

/** Commands of `subset` that are not in `superset` (normalised). */
export function missingFrom(subset: readonly string[], superset: readonly string[]): string[] {
  const have = new Set(superset.map(normalise));
  return subset.filter((c) => !have.has(normalise(c)));
}

/** The `[n/total] title` step headers in init's output, in order. */
export function stepHeaders(output: string): { n: number; total: number; title: string }[] {
  return [...output.matchAll(/^\[(\d+)\/(\d+)\] (.+)$/gm)].map((m) => ({
    n: Number(m[1]),
    total: Number(m[2]),
    title: m[3] as string,
  }));
}

/** The `| N. title | ... |` step rows of setup.md's "What it does" table. */
export function documentedSteps(setupMd: string): { n: number; title: string }[] {
  return [...setupMd.matchAll(/^\| (\d+)\. ([^|]+?) \|/gm)].map((m) => ({
    n: Number(m[1]),
    title: (m[2] as string).trim(),
  }));
}

/**
 * The `run:` lines of one job in a workflow file, found by its `name:`. A plain text scan
 * (the workflow is ours and two-space indented): the job's block runs from its `name:` line
 * to the next job key at the same indentation.
 */
export function jobBlock(workflow: string, jobName: string): string {
  const lines = workflow.split(/\r?\n/);
  const at = lines.findIndex((l) => l.trim() === `name: ${jobName}`);
  if (at === -1) throw new Error(`no job named "${jobName}"`);
  let start = at;
  while (start > 0 && !/^ {2}[A-Za-z0-9_-]+:\s*$/.test(lines[start] as string)) start--;
  let end = at + 1;
  while (end < lines.length && !/^ {2}[A-Za-z0-9_-]+:\s*$/.test(lines[end] as string)) end++;
  return lines.slice(start, end).join("\n");
}
