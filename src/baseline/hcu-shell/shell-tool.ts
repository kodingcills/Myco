/**
 * TIF-268 (M2-05) - the shell tool the `hcu+shell` arm gets, and its boundary.
 *
 * ## What "a coding agent that self-checks with a shell" means here
 *
 * The question R2 asks (`docs/product/m2-plan-draft.md` §2.1, `mvd-preregistration.md` §4.1)
 * is whether a competent agent that can look at the saved file itself, out of band of the
 * GUI, catches its own false "done" as well as Myco's gate does. The checks such an agent
 * runs after a GUI edit are the read-side of a shell:
 *
 * | Tool op       | Shell equivalent                                          | Why the agent wants it            |
 * |---------------|-----------------------------------------------------------|-----------------------------------|
 * | `ls`          | `ls -l DIR` / `Get-ChildItem DIR`                         | did a save land, and when         |
 * | `cat`         | `cat FILE` / `Get-Content FILE` (bounded)                 | read a text artifact              |
 * | `sha256`      | `sha256sum FILE` / `Get-FileHash FILE`                    | did the bytes change since launch |
 * | `convert-csv` | `soffice --headless --convert-to csv --outdir SCRATCH DOC` | read the persisted cell values    |
 *
 * `convert-csv` is the decisive one: it is how a coding agent reads an `.xlsx` without a
 * GUI, and it reads the same persisted state the independent judge reads - which is the
 * whole point of the comparison.
 *
 * ## Where it runs
 *
 * **In the guest**, against the task's document directory and a scratch directory the arm
 * owns. Nothing runs on the host. The grader's ground truth - the expected value, the
 * oracle, the judge's own conversion output, the run directory and ledger - lives on the
 * host or in directories the policy names as denied, so the arm has no route to it by
 * construction, and this module checks it twice besides (before the call, and on the
 * resolved paths the guest reports after it).
 *
 * ## What it cannot do, deliberately (recorded asymmetries)
 *
 * - **No writes, no arbitrary programs.** A real coding agent's shell can run anything. A
 *   shell write to the document is a file-I/O shortcut the pre-registration already counts
 *   as refuted (§4.1 item 2), so offering it would only add trials that cannot succeed; an
 *   arbitrary interpreter (`python`, `powershell -c`) would make the path boundary
 *   unenforceable. The arm is therefore a *read-only* self-checker. That is the strongest
 *   self-check a shell offers without shortcutting the GUI, and it is stated as a remaining
 *   asymmetry, not hidden.
 * - **Structured requests, not a command string.** No shell interpreter parses anything, so
 *   pipes, redirects, globbing, variable expansion and command substitution do not exist.
 *   Paths are still rejected if they contain those characters, so a guest implementation
 *   that does route through a shell cannot be made to interpret them.
 */

/** One shell request, as the planner emits it. */
export type ShellRequest =
  | { readonly shell: "ls"; readonly path: string }
  | { readonly shell: "cat"; readonly path: string }
  | { readonly shell: "sha256"; readonly path: string }
  | { readonly shell: "convert-csv"; readonly path: string };

export type ShellOp = ShellRequest["shell"];
export const SHELL_OPS: readonly ShellOp[] = ["ls", "cat", "sha256", "convert-csv"];

/** What the guest reports a call touched, after resolving links. */
export interface ShellAccess {
  readonly operation: "read" | "write";
  readonly path: string;
}

/** Output kept per call, in characters. Larger output is truncated and marked. */
export const MAX_SHELL_OUTPUT = 4_096;
const MAX_PATH = 512;

/**
 * Path segments that name grader-side material. Denied wherever they appear, even inside
 * a read root, as defence in depth: a misconfigured policy that mounts the run directory
 * under the scratch dir must still not hand the arm its own ledger.
 *
 * Compared case-insensitively against whole segments (and file names without extension
 * for the ledger files), never as substrings, so `expected` blocks `.../expected/...` but
 * not `unexpected.txt`.
 */
export const GROUND_TRUTH_SEGMENTS: readonly string[] = [
  "oracles",
  "hidden",
  "hidden-split",
  "ground-truth",
  "expected",
  "grader",
  "judge",
  "runs",
  "myco-runs",
  ".myco",
  "secrets",
];
export const GROUND_TRUTH_FILES: readonly string[] = [
  "ledger.jsonl",
  "accounting.json",
  "trials.jsonl",
  "params.json",
  "fingerprints.json",
  "sweep-v3.json",
  "ledger-extract.json",
  "result.json",
  "trace.jsonl",
];

export type PathStyle = "windows" | "posix";

export interface ShellPolicyInput {
  readonly style: PathStyle;
  /** The task document. Must lie inside `documentDir`. */
  readonly documentPath: string;
  /** The directory holding the document; readable. */
  readonly documentDir: string;
  /** The arm's own scratch directory; readable, and where `convert-csv` writes. */
  readonly scratchDir: string;
  /**
   * Grader-side directories the arm must never reach: the judge's conversion output, the
   * run directory, any copy of the oracle or hidden split. Must not overlap a read root.
   */
  readonly groundTruthDirs: readonly string[];
}

/** A validated policy. Only `createShellPolicy` makes one. */
export interface ShellPolicy {
  readonly style: PathStyle;
  readonly documentPath: string;
  readonly readRoots: readonly string[];
  readonly scratchDir: string;
  readonly groundTruthDirs: readonly string[];
}

export type ShellDenial =
  | "malformed"
  | "unknown-op"
  | "bad-path"
  | "relative-path"
  | "dot-segment"
  | "outside-roots"
  | "ground-truth"
  | "not-the-document";

export type ShellCheck =
  | { readonly ok: true; readonly request: ShellRequest }
  | { readonly ok: false; readonly code: ShellDenial; readonly reason: string };

const deny = (code: ShellDenial, reason: string): ShellCheck => ({ ok: false, code, reason });

/**
 * Canonical form of a path, or a denial code.
 *
 * Strict rather than clever: anything a resolver could read two ways is refused instead of
 * resolved. `..` and `.` segments, UNC and device paths, NTFS alternate data streams,
 * trailing dots or spaces (which Windows strips, so `judge.` opens `judge`), short names
 * (`~`), wildcards and every character a shell would interpret are all refusals.
 */
export function canonicalPath(
  raw: unknown,
  style: PathStyle,
): { ok: true; path: string } | { ok: false; code: ShellDenial } {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_PATH)
    return { ok: false, code: "bad-path" };
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are refused, not matched.
  if (/[\u0000-\u001f\u007f*?<>|"'`$%;&!~^{}[\]\n\r]/.test(raw))
    return { ok: false, code: "bad-path" };
  let path = raw;
  if (style === "windows") {
    path = path.replaceAll("\\", "/");
    if (path.startsWith("//")) return { ok: false, code: "bad-path" };
    if (!/^[a-zA-Z]:\//.test(path)) return { ok: false, code: "relative-path" };
    // A colon after the drive letter is an alternate data stream (`file.xlsx:hidden`).
    if (path.slice(2).includes(":")) return { ok: false, code: "bad-path" };
    path = path.toLowerCase();
  } else if (!path.startsWith("/")) return { ok: false, code: "relative-path" };
  const body = style === "windows" ? path.slice(3) : path.slice(1);
  const segments = body.split("/").filter((s, i, all) => !(s === "" && i === all.length - 1));
  for (const segment of segments) {
    if (segment === "") return { ok: false, code: "bad-path" };
    if (segment === "." || segment === "..") return { ok: false, code: "dot-segment" };
    if (style === "windows" && /[. ]$/.test(segment)) return { ok: false, code: "bad-path" };
  }
  const prefix = style === "windows" ? path.slice(0, 3) : "/";
  return { ok: true, path: prefix + segments.join("/") };
}

function within(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith("/") ? root : `${root}/`);
}

function overlaps(a: string, b: string): boolean {
  return within(a, b) || within(b, a);
}

function touchesGroundTruth(path: string, policy: ShellPolicy): boolean {
  if (policy.groundTruthDirs.some((dir) => overlaps(path, dir))) return true;
  const segments = path.toLowerCase().split("/");
  return segments.some(
    (segment) => GROUND_TRUTH_SEGMENTS.includes(segment) || GROUND_TRUTH_FILES.includes(segment),
  );
}

/**
 * Build a policy, refusing one that could not be enforced.
 *
 * The overlap rule is the important one: if a ground-truth directory sat inside a read
 * root (or contained one), "inside the roots" would no longer imply "away from the
 * grader", and every check below would be answering the wrong question.
 */
export function createShellPolicy(input: ShellPolicyInput): ShellPolicy {
  const canon = (raw: string, what: string) => {
    const result = canonicalPath(raw, input.style);
    if (!result.ok) throw new Error(`shell policy: ${what} is not a canonical path`);
    return result.path;
  };
  const documentDir = canon(input.documentDir, "documentDir");
  const scratchDir = canon(input.scratchDir, "scratchDir");
  const documentPath = canon(input.documentPath, "documentPath");
  const groundTruthDirs = input.groundTruthDirs.map((dir) => canon(dir, "groundTruthDir"));
  if (!within(documentPath, documentDir) || documentPath === documentDir)
    throw new Error("shell policy: documentPath must lie inside documentDir");
  if (groundTruthDirs.length === 0)
    throw new Error("shell policy: name at least one ground-truth directory to deny");
  const readRoots = [documentDir, scratchDir];
  const policy: ShellPolicy = {
    style: input.style,
    documentPath,
    readRoots,
    scratchDir,
    groundTruthDirs,
  };
  // One check covers both failure shapes: a ground-truth directory overlapping a read root
  // in either direction (`touchesGroundTruth` tests overlap, not just containment), and a
  // read root whose own path names grader material.
  for (const root of readRoots)
    if (touchesGroundTruth(root, policy))
      throw new Error("shell policy: a read root overlaps or names grader-side material");
  return policy;
}

type PathCheck =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly code: ShellDenial; readonly reason: string };

function checkPath(raw: unknown, policy: ShellPolicy): PathCheck {
  const canonical = canonicalPath(raw, policy.style);
  if (!canonical.ok)
    return { ok: false, code: canonical.code, reason: `path refused (${canonical.code})` };
  if (touchesGroundTruth(canonical.path, policy))
    return { ok: false, code: "ground-truth", reason: "path names grader-side material" };
  if (!policy.readRoots.some((root) => within(canonical.path, root)))
    return {
      ok: false,
      code: "outside-roots",
      reason: "path is outside the document and scratch directories",
    };
  return canonical;
}

/**
 * Validate one planner-emitted shell request against the policy, before anything runs.
 *
 * Returns the request rewritten to its canonical path, so the guest executes exactly the
 * path that was checked rather than the planner's spelling of it.
 */
export function checkShellRequest(input: unknown, policy: ShellPolicy): ShellCheck {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    return deny("malformed", "request is not an object");
  const record = input as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== 2 || keys[0] !== "path" || keys[1] !== "shell")
    return deny("malformed", 'request must be exactly {"shell", "path"}');
  const op = record.shell;
  if (typeof op !== "string" || !(SHELL_OPS as readonly string[]).includes(op))
    return deny("unknown-op", "unknown shell op");
  const path = checkPath(record.path, policy);
  if (!path.ok) return deny(path.code, path.reason);
  if (op === "convert-csv" && path.path !== policy.documentPath)
    return deny("not-the-document", "convert-csv accepts only the task document");
  return { ok: true, request: { shell: op as ShellOp, path: path.path } };
}

export interface AccessViolation {
  readonly access: ShellAccess;
  readonly code: ShellDenial | "write-outside-scratch";
}

/**
 * Re-check what the guest says a call actually touched, after it resolved links.
 *
 * The pre-check sees only the planner's spelling. A symlink or junction inside the
 * document directory that points at the judge's output passes it, and only the resolved
 * path reveals the escape. The guest implementation must report resolved paths; this
 * function is where they are held to the same boundary. Writes are allowed only in the
 * scratch directory (where `convert-csv` puts its output).
 */
export function checkResolvedAccesses(
  accesses: readonly ShellAccess[],
  policy: ShellPolicy,
): AccessViolation[] {
  const violations: AccessViolation[] = [];
  for (const access of accesses) {
    if (access.operation !== "read" && access.operation !== "write") {
      violations.push({ access, code: "malformed" });
      continue;
    }
    const checked = checkPath(access.path, policy);
    if (!checked.ok) {
      violations.push({ access, code: checked.code });
      continue;
    }
    if (access.operation === "write" && !within(checked.path, policy.scratchDir))
      violations.push({ access, code: "write-outside-scratch" });
  }
  return violations;
}

/** The guest side of the tool. Implemented over the guest agent in M2-12; faked in tests. */
export interface GuestShell {
  run(request: ShellRequest): Promise<{
    readonly output: string;
    /** Every path the call read or wrote, resolved. A guest that cannot say must throw. */
    readonly accesses: readonly ShellAccess[];
  }>;
}

/** Bound output the way a terminal tool would, marking the cut. */
export function boundOutput(output: string): string {
  return output.length <= MAX_SHELL_OUTPUT
    ? output
    : `${output.slice(0, MAX_SHELL_OUTPUT)}\n[truncated ${output.length - MAX_SHELL_OUTPUT} chars]`;
}
