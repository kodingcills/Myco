/**
 * Runs the shared detector (`detect.ts`) over files: every tracked file of the repo (with
 * the allowlist), or every file under a produced-output directory (no allowlist). Reports
 * file, line and class only, never a matched value. A file name is scanned too: one that
 * leaks is reported as `<name withheld #n>` under its directory.
 *
 * Fail closed: a tracked file that exists but cannot be read, a directory that cannot be
 * walked, and an allowlist that is malformed, unjustified or stale are all findings.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import {
  type DetectOptions,
  type Identity,
  LEAK_CLASSES,
  type LeakClass,
  scanText,
} from "./detect.ts";

export type ReportClass = LeakClass | "unscannable" | "allowlist";

export interface Finding {
  /** Repo-relative (tracked) or `<label>/<relative>` (produced). Never contains a match. */
  readonly file: string;
  readonly line: number;
  readonly class: ReportClass;
}

export interface AllowlistAccount {
  readonly account: string;
  readonly reason: string;
}
export interface AllowlistFile {
  readonly file: string;
  readonly classes: readonly LeakClass[];
  readonly reason: string;
}
export interface Allowlist {
  readonly accounts: readonly AllowlistAccount[];
  readonly files: readonly AllowlistFile[];
}

export const ALLOWLIST_PATH = "src/leak-guard/allowlist.json";

/** Parses and checks the allowlist shape; every entry must carry a reason. */
export function parseAllowlist(text: string): { allowlist: Allowlist; problems: string[] } {
  const problems: string[] = [];
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { allowlist: { accounts: [], files: [] }, problems: ["allowlist is not JSON"] };
  }
  const obj = (raw ?? {}) as Record<string, unknown>;
  const accounts: AllowlistAccount[] = [];
  const files: AllowlistFile[] = [];
  const keys = Object.keys(obj).filter((k) => k !== "$comment");
  for (const k of keys)
    if (k !== "accounts" && k !== "files") problems.push(`allowlist: unknown key ${k}`);
  for (const [i, e] of (Array.isArray(obj.accounts) ? obj.accounts : []).entries()) {
    const a = e as Record<string, unknown>;
    if (typeof a.account !== "string" || a.account === "")
      problems.push(`allowlist.accounts[${i}]: no account`);
    else if (typeof a.reason !== "string" || a.reason.trim().length < 10)
      problems.push(`allowlist.accounts[${i}]: no justification`);
    else accounts.push({ account: a.account, reason: a.reason });
  }
  for (const [i, e] of (Array.isArray(obj.files) ? obj.files : []).entries()) {
    const f = e as Record<string, unknown>;
    const classes = Array.isArray(f.classes) ? f.classes : [];
    if (typeof f.file !== "string" || f.file === "")
      problems.push(`allowlist.files[${i}]: no file`);
    else if (
      classes.length === 0 ||
      !classes.every((c) => (LEAK_CLASSES as readonly unknown[]).includes(c))
    )
      problems.push(
        `allowlist.files[${i}]: classes must be a non-empty subset of the leak classes`,
      );
    else if (typeof f.reason !== "string" || f.reason.trim().length < 10)
      problems.push(`allowlist.files[${i}]: no justification`);
    else files.push({ file: f.file, classes: classes as LeakClass[], reason: f.reason });
  }
  return { allowlist: { accounts, files }, problems };
}

export function trackedFiles(repoRoot: string): string[] {
  return execFileSync("git", ["ls-files", "-z"], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
    .split("\0")
    .filter(Boolean);
}

const UTF8 = new TextDecoder("utf-8", { fatal: true });

function readText(path: string): string {
  const bytes = readFileSync(path);
  try {
    return UTF8.decode(bytes);
  } catch {
    // Not UTF-8 (a binary): latin1 keeps every byte as one char, so an ASCII key or path
    // inside a binary file is still seen.
    return bytes.toString("latin1");
  }
}

/** A leaking file NAME is withheld; the scan reports it as a finding of its own. */
function nameFindings(
  display: string,
  options: DetectOptions,
  index: number,
): { shown: string; findings: Finding[] } {
  const hits = scanText(display, options);
  if (hits.length === 0) return { shown: display, findings: [] };
  const shown = `<name withheld #${index}>`;
  return { shown, findings: hits.map((h) => ({ file: shown, line: 0, class: h.class })) };
}

export interface TrackedScan {
  readonly findings: Finding[];
  readonly files: number;
}

/**
 * Every tracked file, with the allowlist applied. `only` narrows the scan to the given
 * repo-relative files (tests, the revert check); only a full scan checks for stale entries.
 */
export function scanTracked(
  repoRoot: string,
  identity: Identity,
  allowlistText: string,
  only?: readonly string[],
): TrackedScan {
  const files = only ?? trackedFiles(repoRoot);
  const { allowlist, problems } = parseAllowlist(allowlistText);
  const findings: Finding[] = problems.map(() => ({
    file: ALLOWLIST_PATH,
    line: 0,
    class: "allowlist" as const,
  }));
  const accounts = new Set(allowlist.accounts.map((a) => a.account));
  const usedAccounts = new Set<string>();
  const usedFileEntries = new Set<number>();
  const base: DetectOptions = {
    identity,
    allowedAccounts: accounts,
    onAllowed: (a) => usedAccounts.add(a),
  };
  for (const [n, file] of files.entries()) {
    const abs = join(repoRoot, file);
    if (!existsSync(abs)) continue; // deleted in the working tree, still in the index
    const name = nameFindings(file, base, n);
    findings.push(...name.findings);
    let text: string;
    try {
      if (statSync(abs).isDirectory()) continue; // a submodule or gitlink
      text = readText(abs);
    } catch {
      findings.push({ file: name.shown, line: 0, class: "unscannable" });
      continue;
    }
    const entryIdx = allowlist.files.findIndex((e) =>
      e.file.endsWith("/") ? file.startsWith(e.file) : e.file === file,
    );
    const skip = new Set<LeakClass>(entryIdx >= 0 ? allowlist.files[entryIdx]?.classes : []);
    const hits = scanText(text, { ...base, skipClasses: skip });
    for (const h of hits) findings.push({ file: name.shown, line: h.line, class: h.class });
    // Usage tracking (stale entries fail): would the file hit without the entry / accounts?
    if (
      entryIdx >= 0 &&
      scanText(text, { identity, allowedAccounts: accounts }).some((h) => skip.has(h.class))
    )
      usedFileEntries.add(entryIdx);
  }
  // A full scan proves every allowlist entry still earns its place (a stale entry would
  // silently excuse the next real leak in that file, or of that account).
  if (only === undefined) {
    const stale = (what: string) =>
      findings.push({ file: `${ALLOWLIST_PATH} (${what} stale)`, line: 0, class: "allowlist" });
    // `username`/`hostname` entries depend on the machine running the scan (CI's account
    // is generic), so only entries for host-independent classes can be proven stale.
    const hostDependent = (e: AllowlistFile) =>
      e.classes.every((c) => c === "username" || c === "hostname");
    for (const [i, e] of allowlist.files.entries())
      if (!usedFileEntries.has(i) && !hostDependent(e)) stale(`files[${i}]`);
    for (const [i, a] of allowlist.accounts.entries())
      if (!usedAccounts.has(a.account)) stale(`accounts[${i}]`);
  }
  return { findings, files: files.length };
}

/**
 * Every file under `dir` (a produced dataset, episode export, bundle or log directory), no
 * allowlist: placeholders a writer emits are `<...>` forms the detector never matches.
 */
export function scanDir(dir: string, label: string, identity: Identity): Finding[] {
  const findings: Finding[] = [];
  const options: DetectOptions = { identity };
  let n = 0;
  const walk = (abs: string) => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      findings.push({ file: `${label}/${relative(dir, abs)}`, line: 0, class: "unscannable" });
      return;
    }
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = join(abs, e.name);
      const rel = relative(dir, p).split(sep).join("/");
      const name = nameFindings(rel, options, n++);
      findings.push(...name.findings.map((f) => ({ ...f, file: `${label}/${f.file}` })));
      if (e.isDirectory()) {
        walk(p);
        continue;
      }
      let text: string;
      try {
        text = readText(p);
      } catch {
        findings.push({ file: `${label}/${name.shown}`, line: 0, class: "unscannable" });
        continue;
      }
      for (const h of scanText(text, options))
        findings.push({ file: `${label}/${name.shown}`, line: h.line, class: h.class });
    }
  };
  walk(dir);
  return findings;
}

/** Scans in-memory text (a captured log stream). */
export function scanLog(text: string, label: string, identity: Identity): Finding[] {
  return scanText(text, { identity }).map((h) => ({ file: label, line: h.line, class: h.class }));
}

/** One line per finding: location and class only. */
export function formatFindings(findings: readonly Finding[]): string {
  return findings.map((f) => `${f.file}:${f.line} ${f.class}`).join("\n");
}
