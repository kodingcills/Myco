/**
 * Clean by construction, then checked (data capture track; docs/data/episode-format.md §4).
 *
 * Construction: the episode schema has no field for an environment, a launch plan, a vault
 * path, a receipt, oracle source, gate prose or a ledger row, and the writers copy named
 * fields only. Two passes then run over what remains:
 *
 *  1. `redactText` on free text the agent produced or saw (typed text, shell commands, UI
 *     status, the instruction): the home directory, the temp directory, `/<user>` and any
 *     absolute host path become placeholders. Paths are scrubbed because they are expected
 *     noise in an agent's text.
 *  2. `cleanIssues` on every string of the finished episode, and `blobIssues` on every blob:
 *     a planted marker, an absolute path, a key-shaped string or a host identifier REFUSES
 *     the episode. Secrets and markers are never scrubbed: one that reaches an episode means
 *     a leak path exists, and a scrubber guessing a key's extent can leave a piece of it.
 *
 * Screenshots are pixels, not text: they go through a `FrameRedactor` (the live watch view's
 * rules, #513) before they are stored, and `blobIssues` is the byte-level backstop.
 */
import { homedir, tmpdir, userInfo } from "node:os";

/** The canary tests plant in env, home, fixtures, the vault and oracle config. */
export const PLANTED_MARKER = "PLANTED_FAKE_MARKER";

export type CleanIssueCode = "PLANTED_MARKER" | "ABSOLUTE_PATH" | "KEY_SHAPED" | "HOST_IDENTIFIER";

export interface CleanIssue {
  readonly code: CleanIssueCode;
  /** JSON path of the offending string (never the string itself: it may be a secret). */
  readonly path: string;
}

export interface HostFacts {
  readonly home?: string;
  readonly tmp?: string;
  readonly user?: string;
}

function read(get: () => string): string | undefined {
  try {
    return get();
  } catch {
    return undefined;
  }
}

export function currentHost(): HostFacts {
  const home = read(homedir);
  const tmp = read(tmpdir);
  const user = read(() => userInfo().username);
  return {
    ...(home === undefined ? {} : { home }),
    ...(tmp === undefined ? {} : { tmp }),
    ...(user === undefined ? {} : { user }),
  };
}

/** Host-identifying substrings (only ones long enough to be specific). */
export function hostNeedles(host: HostFacts): string[] {
  const needles = new Set<string>();
  for (const value of [host.home, host.tmp])
    if (value !== undefined && value.length >= 4) needles.add(value);
  if (host.user !== undefined && host.user.length >= 3) {
    needles.add(`/${host.user}`);
    needles.add(`\\${host.user}`);
  }
  return [...needles];
}

/** Absolute host paths: POSIX (2+ segments, not part of a URL or word), Windows, UNC, `~/`, file URLs. */
const ABSOLUTE_PATH: readonly RegExp[] = [
  /(?<![A-Za-z0-9._~:/\\-])\/(?:[A-Za-z0-9._@+-]+\/)+[A-Za-z0-9._@+-]*/,
  /(?<![A-Za-z0-9])[A-Za-z]:[\\/][^\s"']*/,
  /\\\\[A-Za-z0-9._-]+\\[^\s"']*/,
  /(?<![A-Za-z0-9._-])~[\\/][^\s"']*/,
  /file:\/\//i,
];

/** Key- and token-shaped strings (prefix-anchored, so content hashes never match). */
const KEY_SHAPED: readonly RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{8,}/,
  /(?<![A-Za-z0-9])sk-(?:proj-)?[A-Za-z0-9_-]{20,}/,
  /(?<![A-Za-z0-9])(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/,
  /github_pat_[A-Za-z0-9_]{20,}/,
  /(?<![A-Za-z0-9])AKIA[0-9A-Z]{12,}/,
  /(?<![A-Za-z0-9])xox[abprs]-[A-Za-z0-9-]{10,}/,
  /(?<![A-Za-z0-9])AIza[0-9A-Za-z_-]{30,}/,
  /(?<![A-Za-z0-9])glpat-[A-Za-z0-9_-]{16,}/,
  /(?<![A-Za-z0-9])hf_[A-Za-z0-9]{30,}/,
  /eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}/,
  /-----BEGIN [A-Z ]*(?:PRIVATE KEY|CERTIFICATE)/,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/,
];

export function stringIssues(value: string, host: HostFacts = currentHost()): CleanIssueCode[] {
  const codes = new Set<CleanIssueCode>();
  if (value.includes(PLANTED_MARKER)) codes.add("PLANTED_MARKER");
  if (ABSOLUTE_PATH.some((re) => re.test(value))) codes.add("ABSOLUTE_PATH");
  if (KEY_SHAPED.some((re) => re.test(value))) codes.add("KEY_SHAPED");
  if (hostNeedles(host).some((n) => value.includes(n))) codes.add("HOST_IDENTIFIER");
  return [...codes];
}

/** Every string (keys included) in a JSON value, refused by code and path. */
export function cleanIssues(value: unknown, host: HostFacts = currentHost()): CleanIssue[] {
  const issues: CleanIssue[] = [];
  const walk = (node: unknown, path: string): void => {
    if (typeof node === "string") {
      for (const code of stringIssues(node, host)) issues.push({ code, path });
    } else if (Array.isArray(node)) {
      for (const [i, item] of node.entries()) walk(item, `${path}[${i}]`);
    } else if (node !== null && typeof node === "object") {
      for (const [key, child] of Object.entries(node)) {
        for (const code of stringIssues(key, host)) issues.push({ code, path: `${path}{key}` });
        walk(child, `${path}.${key}`);
      }
    }
  };
  walk(value, "$");
  return issues;
}

/**
 * Byte-level backstop for a blob. Text blobs (CSV, JSON) are scanned as UTF-8 like any string;
 * a PNG is scanned as latin1 for the marker, key prefixes and host needles (what survives in
 * stored-verbatim bytes), not for paths, which compressed pixels can contain by chance.
 */
export function blobIssues(
  bytes: Uint8Array,
  kind: "text" | "png",
  host: HostFacts = currentHost(),
): CleanIssueCode[] {
  if (kind === "text") return stringIssues(Buffer.from(bytes).toString("utf8"), host);
  const latin = Buffer.from(bytes).toString("latin1");
  return stringIssues(latin, host).filter((c) => c !== "ABSOLUTE_PATH");
}

/** Scrub host paths from free text. Markers and key-shaped strings are left for the refusal. */
export function redactText(value: string, host: HostFacts = currentHost()): string {
  let out = value;
  if (host.home !== undefined && host.home.length >= 4) out = out.split(host.home).join("<home>");
  if (host.tmp !== undefined && host.tmp.length >= 4) out = out.split(host.tmp).join("<tmp>");
  out = out
    .replace(/(?<![A-Za-z0-9._~:/\\-])\/(?:[A-Za-z0-9._@+-]+\/)+[A-Za-z0-9._@+-]*/g, "<path>")
    .replace(/(?<![A-Za-z0-9])[A-Za-z]:[\\/][^\s"']*/g, "<path>")
    .replace(/\\\\[A-Za-z0-9._-]+\\[^\s"']*/g, "<path>")
    .replace(/(?<![A-Za-z0-9._-])~[\\/][^\s"']*/g, "<path>");
  if (host.user !== undefined && host.user.length >= 3) {
    out = out.split(`/${host.user}`).join("/<user>").split(`\\${host.user}`).join("\\<user>");
  }
  return out;
}
