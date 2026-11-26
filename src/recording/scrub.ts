/**
 * Track R (task recording to automation): what a recording may never hold.
 *
 * A recording is written to disk and later compiled into a workflow that other runs replay,
 * so anything it captures travels. Two kinds of string are never allowed into one:
 *
 *  - secret-shaped strings: API keys and tokens by their well-known prefixes, private-key
 *    blocks, `KEY=value` assignments, bearer headers, and long high-entropy tokens;
 *  - host paths: absolute POSIX paths under a home, temp or volume directory, Windows drive
 *    and UNC paths, `file://` URLs and `~/` paths. A host path names the operator's
 *    machine and account, and it never resolves on another machine anyway.
 *
 * Detection is by pattern plus an operator-supplied marker list (exact substrings, for
 * planted-marker tests and for an operator who wants a known value refused). The recorder
 * never reads the environment, a keychain or a secrets file to learn what a secret looks
 * like: it refuses shapes, it does not compare against values.
 *
 * Policy (fail closed): a hit is never stored. The recorder replaces the whole string with
 * a redaction token naming only the kind of hit, and counts the redaction; the compiler
 * refuses a recording with any redaction (a redacted value cannot be replayed). Before a
 * recording is serialized, `assertClean` re-scans the whole JSON and throws on any hit, so
 * a field the normalizer forgot still cannot reach the disk.
 */

export type SensitiveKind = "secret" | "host-path" | "marker";

export interface SensitiveHit {
  readonly kind: SensitiveKind;
  /** Which rule matched (a name, never the matched text). */
  readonly rule: string;
}

const SECRET_RULES: ReadonlyArray<readonly [string, RegExp]> = [
  ["anthropic-key", /sk-ant-[A-Za-z0-9_-]{4,}/],
  ["openai-style-key", /\bsk-[A-Za-z0-9_-]{16,}/],
  ["github-token", /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,}/],
  ["slack-token", /\bxox[abprs]-[A-Za-z0-9-]{6,}/],
  ["aws-access-key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ["google-api-key", /\bAIza[0-9A-Za-z_-]{20,}/],
  ["private-key-block", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["jwt", /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/],
  ["bearer-header", /\bBearer\s+[A-Za-z0-9._~+/-]{8,}/i],
  [
    "key-assignment",
    /\b[A-Za-z0-9_]*(?:API[_-]?KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL)[A-Za-z0-9_]*\s*[=:]\s*\S+/i,
  ],
];

const HOST_PATH_RULES: ReadonlyArray<readonly [string, RegExp]> = [
  // Built from pieces so this source file never holds a literal home path (TIF-241).
  [
    "posix-home-or-temp",
    new RegExp(
      `(?:^|[^A-Za-z0-9_.-])/(?:${["home", "Users", "root", "tmp", "private", "Volumes", "var/folders", "mnt", "media", "run/user", "opt"].join("|")})(?:/|$)`,
    ),
  ],
  ["windows-drive", /\b[A-Za-z]:[\\/]/],
  ["unc-path", /\\\\[A-Za-z0-9_.-]+\\/],
  ["file-url", /\bfile:\/\//i],
  ["home-tilde", /(?:^|\s)~\//],
];

/** A long token mixing letters and digits: the shape of a key whose prefix we do not know. */
function highEntropyToken(text: string): boolean {
  for (const token of text.match(/[A-Za-z0-9+/_=-]{32,}/g) ?? []) {
    const classes = [/[a-z]/, /[A-Z]/, /[0-9]/].filter((re) => re.test(token)).length;
    // A pure lowercase-hex token is a digest (sha256 everywhere in Myco's records), not a key.
    if (/^[0-9a-f]+$/.test(token)) continue;
    if (classes >= 3 || (classes === 2 && /[0-9]/.test(token) && token.length >= 40)) return true;
  }
  return false;
}

/** The first sensitive hit in `text`, or undefined. `markers` are exact substrings. */
export function findSensitive(
  text: string,
  markers: readonly string[] = [],
): SensitiveHit | undefined {
  for (const marker of markers) {
    if (marker.length > 0 && text.includes(marker)) return { kind: "marker", rule: "marker" };
  }
  for (const [rule, re] of SECRET_RULES) if (re.test(text)) return { kind: "secret", rule };
  if (highEntropyToken(text)) return { kind: "secret", rule: "high-entropy-token" };
  for (const [rule, re] of HOST_PATH_RULES) if (re.test(text)) return { kind: "host-path", rule };
  return undefined;
}

export const REDACTION_PREFIX = "[REDACTED:";

/** The token a redacted string is replaced with: it names the kind, never the content. */
export function redactionToken(hit: SensitiveHit): string {
  return `${REDACTION_PREFIX}${hit.kind}]`;
}

export class SensitiveContentError extends Error {
  override readonly name = "SensitiveContentError";
}

/**
 * Throw when any string anywhere in `value` (keys included) is sensitive. The message names
 * the JSON path and the rule, never the content. This is the last net before a recording,
 * workflow or report is written.
 */
export function assertClean(value: unknown, markers: readonly string[] = [], path = "$"): void {
  if (typeof value === "string") {
    const hit = findSensitive(value, markers);
    if (hit) throw new SensitiveContentError(`${path}: ${hit.kind} (${hit.rule})`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => {
      assertClean(item, markers, `${path}[${i}]`);
    });
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      const hit = findSensitive(key, markers);
      if (hit) throw new SensitiveContentError(`${path}: key is ${hit.kind} (${hit.rule})`);
      assertClean(item, markers, `${path}.${key}`);
    }
  }
}
