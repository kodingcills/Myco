/**
 * Track O: the host policy config file, `myco.policy-config/1`.
 *
 * Policies are declared in a file on the HOST, never in the guest and never in the trial's
 * workspace: `loadPolicyConfig` refuses a path that is relative or that resolves inside any
 * root the agent can reach (the caller passes the trial's document directory and workspace).
 * The file is read ONCE; its SHA-256 over the exact bytes is the `policyConfigSha256` recorded in
 * every policy log entry and policy row. The engine never re-reads it, so editing the file
 * during a trial changes nothing.
 *
 * Fail closed, in this order, and nothing is opened before steps 1 to 3 pass:
 * 1. a missing or unresolvable path refuses to start the trial (`POLICY_CONFIG_MISSING`); a
 *    trial never runs unpoliced instead;
 * 2. a path that resolves inside an agent root is `POLICY_CONFIG_NOT_HOST`;
 * 3. anything but a regular file (a symlink at the given name, a FIFO, a device such as
 *    `/dev/zero`, a directory) is `POLICY_CONFIG_NOT_REGULAR`, and a file over
 *    `MAX_CONFIG_BYTES` is `POLICY_CONFIG_TOO_LARGE`, both from `lstat` alone;
 * 4. the read itself is non-blocking and bounded (`./bounded-read.ts`, the technique of `src/integrity/nonblocking-read.ts`): it
 *    opens with `O_NONBLOCK | O_NOFOLLOW`, checks the open fd is the same regular file, and
 *    reads at most `MAX_CONFIG_BYTES`. A swap after step 3 is refused, never followed. No
 *    planted object can make startup hang or read without bound;
 * - a file that does not parse, or parses to anything but the closed schema below, loads as
 *   INVALID: the engine built from it denies every action (`POLICY_CONFIG_INVALID`), and the
 *   recorded hash is still the hash of the bytes that were read.
 *
 * Closed schema (exact keys at every level, no defaults):
 *
 *   { "schema": "myco.policy-config/1",
 *     "policies": [ { "id": "<id>", "kind": "<rule kind>", "effect": "deny" | "require-approval",
 *                     ...the kind's parameters } ] }
 *
 *   app-allowlist      "apps": ["<app id>", ...]   (may be empty: no launch is allowed)
 *   destructive-limit  "max": <integer 0..1000>
 *   every other kind   no parameters
 */

import { createHash } from "node:crypto";
import { lstatSync, realpathSync, type Stats } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import { type BoundedReadRefusal, readBoundedNoBlock } from "./bounded-read.ts";
import {
  POLICY_EFFECTS,
  POLICY_RULE_KINDS,
  type PolicyEffect,
  type PolicyRuleKind,
  type PolicyStartRefusal,
} from "./codes.ts";

export const POLICY_CONFIG_SCHEMA = "myco.policy-config/1" as const;
export const MAX_CONFIG_BYTES = 64 * 1024;
export const MAX_POLICIES = 64;
export const MAX_DESTRUCTIVE = 1000;
/** A declared rule id, and an app id in an allow-list. Host-chosen; never shown to the agent. */
export const RULE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export type PolicyRule =
  | {
      readonly id: string;
      readonly kind: Exclude<PolicyRuleKind, "app-allowlist" | "destructive-limit">;
      readonly effect: PolicyEffect;
    }
  | {
      readonly id: string;
      readonly kind: "app-allowlist";
      readonly effect: PolicyEffect;
      readonly apps: readonly string[];
    }
  | {
      readonly id: string;
      readonly kind: "destructive-limit";
      readonly effect: PolicyEffect;
      readonly max: number;
    };

export interface PolicyConfig {
  readonly schema: typeof POLICY_CONFIG_SCHEMA;
  readonly policies: readonly PolicyRule[];
}

export type LoadedPolicyConfig =
  | {
      readonly ok: true;
      readonly sha256: string;
      /** null when the bytes did not parse to the closed schema: the engine then denies all. */
      readonly config: PolicyConfig | null;
    }
  | { readonly ok: false; readonly code: PolicyStartRefusal };

function exactKeys(o: Record<string, unknown>, keys: readonly string[]): boolean {
  const have = Object.keys(o).sort();
  const want = [...keys].sort();
  return have.length === want.length && have.every((k, i) => k === want[i]);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseRule(raw: unknown): PolicyRule | null {
  if (!isObject(raw)) return null;
  const { id, kind, effect } = raw;
  if (typeof id !== "string" || !RULE_ID.test(id)) return null;
  if (typeof kind !== "string" || !(POLICY_RULE_KINDS as readonly string[]).includes(kind))
    return null;
  if (typeof effect !== "string" || !(POLICY_EFFECTS as readonly string[]).includes(effect))
    return null;
  const e = effect as PolicyEffect;
  if (kind === "app-allowlist") {
    if (!exactKeys(raw, ["id", "kind", "effect", "apps"])) return null;
    const apps = raw.apps;
    if (!Array.isArray(apps) || apps.length > MAX_POLICIES) return null;
    if (!apps.every((a) => typeof a === "string" && RULE_ID.test(a))) return null;
    return Object.freeze({ id, kind, effect: e, apps: Object.freeze([...(apps as string[])]) });
  }
  if (kind === "destructive-limit") {
    if (!exactKeys(raw, ["id", "kind", "effect", "max"])) return null;
    const max = raw.max;
    if (typeof max !== "number" || !Number.isInteger(max) || max < 0 || max > MAX_DESTRUCTIVE)
      return null;
    return Object.freeze({ id, kind, effect: e, max });
  }
  if (!exactKeys(raw, ["id", "kind", "effect"])) return null;
  return Object.freeze({
    id,
    kind: kind as Exclude<PolicyRuleKind, "app-allowlist" | "destructive-limit">,
    effect: e,
  });
}

/** Parse config text to the closed schema, or null. Never throws. */
export function parsePolicyConfig(text: string): PolicyConfig | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObject(raw) || !exactKeys(raw, ["schema", "policies"])) return null;
  if (raw.schema !== POLICY_CONFIG_SCHEMA) return null;
  const list = raw.policies;
  if (!Array.isArray(list) || list.length === 0 || list.length > MAX_POLICIES) return null;
  const rules: PolicyRule[] = [];
  const ids = new Set<string>();
  for (const item of list) {
    const rule = parseRule(item);
    if (rule === null || ids.has(rule.id)) return null;
    ids.add(rule.id);
    rules.push(rule);
  }
  return Object.freeze({ schema: POLICY_CONFIG_SCHEMA, policies: Object.freeze(rules) });
}

function within(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

export interface LoadOptions {
  /**
   * Roots the agent or the guest can reach (the trial's document directory, its workspace, a
   * guest share). A config that resolves inside any of them is refused: the agent could edit it.
   */
  readonly agentRoots: readonly string[];
}

/** Read and pin the host config. See the module comment for every refusal. */
export function loadPolicyConfig(path: string, options: LoadOptions): LoadedPolicyConfig {
  if (typeof path !== "string" || !isAbsolute(path))
    return { ok: false, code: "POLICY_CONFIG_NOT_HOST" };
  // 1. Where it is. `realpath` resolves the name without opening the file, so a FIFO or a
  //    device cannot block here.
  let real: string;
  try {
    real = realpathSync.native(path);
  } catch {
    return { ok: false, code: "POLICY_CONFIG_MISSING" };
  }
  // 2. Not under an agent root, checked before anything is opened.
  for (const root of options.agentRoots) {
    let realRoot: string;
    try {
      realRoot = realpathSync.native(root);
    } catch {
      // A root that does not resolve cannot be checked: refuse rather than guess.
      return { ok: false, code: "POLICY_CONFIG_NOT_HOST" };
    }
    if (within(real, realRoot)) return { ok: false, code: "POLICY_CONFIG_NOT_HOST" };
  }
  // 3. What it is, without opening it: a regular file (not a symlink at the given name, a FIFO,
  //    a device or a directory) of at most MAX_CONFIG_BYTES.
  let pre: Stats;
  let named: Stats;
  try {
    named = lstatSync(path);
    pre = lstatSync(real);
  } catch {
    return { ok: false, code: "POLICY_CONFIG_MISSING" };
  }
  if (named.isSymbolicLink() || !pre.isFile())
    return { ok: false, code: "POLICY_CONFIG_NOT_REGULAR" };
  if (pre.size > MAX_CONFIG_BYTES) return { ok: false, code: "POLICY_CONFIG_TOO_LARGE" };
  // 4. One bounded, non-blocking read of that same file (O_NONBLOCK | O_NOFOLLOW, fstat on the
  //    open fd, same inode as step 3). A swap in between is refused, never followed.
  const read = readBoundedNoBlock(real, MAX_CONFIG_BYTES, pre);
  if (!read.ok) return { ok: false, code: READ_REFUSAL[read.code] };
  const sha256 = createHash("sha256").update(read.bytes).digest("hex");
  return { ok: true, sha256, config: parsePolicyConfig(read.bytes.toString("utf8")) };
}

const READ_REFUSAL: Readonly<Record<BoundedReadRefusal, PolicyStartRefusal>> = {
  missing: "POLICY_CONFIG_MISSING",
  "not-regular": "POLICY_CONFIG_NOT_REGULAR",
  swapped: "POLICY_CONFIG_NOT_REGULAR",
  "too-large": "POLICY_CONFIG_TOO_LARGE",
};
