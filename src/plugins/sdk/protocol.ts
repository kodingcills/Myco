/**
 * Bring-your-own-app plugin protocol, `myco.plugin/1` (capability track T).
 *
 * A plugin adds one app to Myco from outside the repo: a STATE READER (typed state out of a
 * saved document) and/or an ORACLE (a three-valued verdict over the saved document's bytes).
 * This module is the whole wire contract. It is shared by the host (`src/plugins/host/`) and
 * the sandboxed child (`src/plugins/sdk/child.ts`), so it imports NOTHING: it must load
 * inside the plugin sandbox, where only the SDK directory is readable and only a short list
 * of builtins resolves.
 *
 * Every parser here is closed and fails closed: an unknown key, a wrong type or an
 * out-of-range value is an error, never ignored.
 */

export const PLUGIN_SPEC = "myco.plugin/1" as const;

/** The corruption classes of the R5 self-test (`src/oracle-selftest/types.ts`), repeated so
 * this module stays import-free. `test/plugins/protocol.test.ts` pins the two lists equal. */
export const PLUGIN_CORRUPTION_CLASSES = [
  "edit-missing",
  "wrong-value",
  "wrong-target",
  "collateral",
  "truncated",
  "corrupt-byte",
  "partial-save",
  "missing-main-part",
  "missing-file",
] as const;
export type PluginCorruptionClass = (typeof PLUGIN_CORRUPTION_CLASSES)[number];

export const PLUGIN_KINDS = ["oracle", "reader"] as const;
export type PluginKind = (typeof PLUGIN_KINDS)[number];

/** Host ceilings. A manifest may ask for less, never more. */
export const CAP_CEILINGS = {
  timeoutMs: 10_000,
  memoryMb: 256,
  maxInputBytes: 16 * 1024 * 1024,
  maxOutputBytes: 1024 * 1024,
} as const;
export const CAP_FLOORS = {
  timeoutMs: 100,
  memoryMb: 16,
  maxInputBytes: 1,
  maxOutputBytes: 256,
} as const;

/** Bounds the host applies to every request regardless of manifest. */
export const MAX_INTENT_BYTES = 64 * 1024;
export const MAX_SELFTEST_OUTPUT_BYTES = 8 * 1024 * 1024;
export const MAX_SELFTEST_CASES = 64;
export const MAX_CORRUPTIONS_PER_CASE = 64;
export const MAX_STATE_ITEMS = 10_000;
export const MAX_STATE_STRING = 4096;

const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SEMVER = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/;
const EXT = /^\.[a-z0-9]{1,10}$/;
const MEDIA_TYPE = /^[a-z]+\/[a-z0-9.+-]{1,80}$/;
const ENTRY = /^[A-Za-z0-9_-]{1,64}(\/[A-Za-z0-9_-]{1,64}){0,3}\.(ts|mjs|js)$/;
/** Codes only: a plugin can never put free text (paths, values, prose) into a verdict. */
export const CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const FILE_NAME = /^[A-Za-z0-9._-]{1,128}$/;
const CASE_ID = /^[A-Za-z0-9._:-]{1,64}$/;
const CELL_REF = /^[A-Za-z0-9!$:._-]{1,64}$/;

export interface PluginFormat {
  readonly ext: string;
  readonly mediaType: string;
}

export interface PluginCaps {
  readonly timeoutMs: number;
  readonly memoryMb: number;
  readonly maxInputBytes: number;
  readonly maxOutputBytes: number;
}

/**
 * The closed manifest (`myco-plugin.json`). There is deliberately no network, filesystem or
 * process capability to ask for: plugins get none, and a manifest that names one is refused
 * as an unknown key.
 */
export interface PluginManifest {
  readonly spec: typeof PLUGIN_SPEC;
  readonly name: string;
  readonly version: string;
  readonly app: string;
  readonly kinds: readonly PluginKind[];
  readonly formats: readonly PluginFormat[];
  /** Corruption classes the oracle claims to catch; empty for a reader-only plugin. */
  readonly claims: readonly PluginCorruptionClass[];
  readonly caps: PluginCaps;
  /** Module path inside the plugin directory, default-exporting a `definePlugin` value. */
  readonly entry: string;
}

export class ProtocolError extends Error {
  override name = "ProtocolError";
  // No parameter properties anywhere under sdk/: the sandbox runs this file with Node's
  // type stripping, which supports erasable syntax only.
  readonly code: string;
  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.code = code;
  }
}

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Exactly these keys (required ∪ optional), no others; returns the object. */
function closed(
  v: unknown,
  where: string,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (!isObject(v)) throw new ProtocolError("SHAPE", `${where} is not an object`);
  if (Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null)
    throw new ProtocolError("SHAPE", `${where} is not a plain object`);
  const allowed = new Set([...required, ...optional]);
  for (const k of Object.keys(v))
    if (!allowed.has(k)) throw new ProtocolError("UNKNOWN_KEY", `${where}.${k} is not allowed`);
  for (const k of required)
    if (!(k in v)) throw new ProtocolError("MISSING_KEY", `${where}.${k} is required`);
  return v;
}

function str(v: unknown, where: string, re: RegExp): string {
  if (typeof v !== "string" || !re.test(v))
    throw new ProtocolError("BAD_VALUE", `${where} is not a valid value`);
  return v;
}

function int(v: unknown, where: string, lo: number, hi: number): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < lo || v > hi)
    throw new ProtocolError("BAD_VALUE", `${where} must be an integer in [${lo}, ${hi}]`);
  return v;
}

function list(v: unknown, where: string, max: number): unknown[] {
  if (!Array.isArray(v) || v.length > max)
    throw new ProtocolError("BAD_VALUE", `${where} must be an array of at most ${max}`);
  return v;
}

function oneOf<T extends string>(v: unknown, where: string, values: readonly T[]): T {
  if (typeof v !== "string" || !(values as readonly string[]).includes(v))
    throw new ProtocolError("BAD_VALUE", `${where} is not one of ${values.join(", ")}`);
  return v as T;
}

function unique<T>(xs: readonly T[], where: string): void {
  if (new Set(xs).size !== xs.length)
    throw new ProtocolError("BAD_VALUE", `${where} has duplicates`);
}

export function parseManifest(v: unknown): PluginManifest {
  const m = closed(v, "manifest", [
    "spec",
    "name",
    "version",
    "app",
    "kinds",
    "formats",
    "claims",
    "caps",
    "entry",
  ]);
  if (m.spec !== PLUGIN_SPEC)
    throw new ProtocolError("SPEC_VERSION", `manifest.spec must be ${PLUGIN_SPEC}`);
  const kinds = list(m.kinds, "manifest.kinds", PLUGIN_KINDS.length).map((k, i) =>
    oneOf(k, `manifest.kinds[${i}]`, PLUGIN_KINDS),
  );
  if (kinds.length === 0) throw new ProtocolError("BAD_VALUE", "manifest.kinds is empty");
  unique(kinds, "manifest.kinds");
  const formats = list(m.formats, "manifest.formats", 8).map((f, i) => {
    const o = closed(f, `manifest.formats[${i}]`, ["ext", "mediaType"]);
    return {
      ext: str(o.ext, `manifest.formats[${i}].ext`, EXT),
      mediaType: str(o.mediaType, `manifest.formats[${i}].mediaType`, MEDIA_TYPE),
    };
  });
  if (formats.length === 0) throw new ProtocolError("BAD_VALUE", "manifest.formats is empty");
  unique(
    formats.map((f) => f.ext),
    "manifest.formats[].ext",
  );
  const claims = list(m.claims, "manifest.claims", PLUGIN_CORRUPTION_CLASSES.length).map((c, i) =>
    oneOf(c, `manifest.claims[${i}]`, PLUGIN_CORRUPTION_CLASSES),
  );
  unique(claims, "manifest.claims");
  if (kinds.includes("oracle") && claims.length === 0)
    throw new ProtocolError("NO_CLAIMS", "an oracle plugin claims at least one corruption class");
  if (!kinds.includes("oracle") && claims.length > 0)
    throw new ProtocolError("CLAIMS_WITHOUT_ORACLE", "only an oracle plugin can claim classes");
  const c = closed(m.caps, "manifest.caps", [
    "timeoutMs",
    "memoryMb",
    "maxInputBytes",
    "maxOutputBytes",
  ]);
  const caps: PluginCaps = {
    timeoutMs: int(
      c.timeoutMs,
      "manifest.caps.timeoutMs",
      CAP_FLOORS.timeoutMs,
      CAP_CEILINGS.timeoutMs,
    ),
    memoryMb: int(c.memoryMb, "manifest.caps.memoryMb", CAP_FLOORS.memoryMb, CAP_CEILINGS.memoryMb),
    maxInputBytes: int(
      c.maxInputBytes,
      "manifest.caps.maxInputBytes",
      CAP_FLOORS.maxInputBytes,
      CAP_CEILINGS.maxInputBytes,
    ),
    maxOutputBytes: int(
      c.maxOutputBytes,
      "manifest.caps.maxOutputBytes",
      CAP_FLOORS.maxOutputBytes,
      CAP_CEILINGS.maxOutputBytes,
    ),
  };
  return {
    spec: PLUGIN_SPEC,
    name: str(m.name, "manifest.name", NAME),
    version: str(m.version, "manifest.version", SEMVER),
    app: str(m.app, "manifest.app", NAME),
    kinds,
    formats,
    // Canonical order, so two manifests that claim the same set hash the same.
    claims: PLUGIN_CORRUPTION_CLASSES.filter((cls) => claims.includes(cls)),
    caps,
    entry: str(m.entry, "manifest.entry", ENTRY),
  };
}

// ---------------------------------------------------------------------------
// Wire: one request on stdin, one response line on stdout, one process per request.
// ---------------------------------------------------------------------------

export interface WireDocument {
  /** Basename only: a plugin never learns a host path. */
  readonly fileName: string;
  /** Base64 of the captured bytes, or null when nothing was saved. */
  readonly bytesB64: string | null;
}

export type PluginRequest =
  | {
      readonly spec: typeof PLUGIN_SPEC;
      readonly op: "verify";
      readonly doc: WireDocument;
      readonly intent: Json;
    }
  | { readonly spec: typeof PLUGIN_SPEC; readonly op: "read"; readonly doc: WireDocument }
  | { readonly spec: typeof PLUGIN_SPEC; readonly op: "selftest-cases" };

export type OracleStatus = "verified" | "refuted" | "uncertain";

/**
 * Typed state, mirroring capability-spec §I's proposed `state_cells` / `state_fields` /
 * `state_text` shapes (the live-app tools land with track I; a plugin reader returns the same
 * shapes from saved bytes).
 */
export type CellValue = string | number | boolean | null;
export interface StateCell {
  readonly ref: string;
  readonly value: CellValue;
  readonly valueKind: "string" | "number" | "boolean" | "empty";
  readonly formula: boolean;
}
export interface StateField {
  readonly label: string;
  readonly value: string;
}
export type PluginState =
  | { readonly kind: "cells"; readonly cells: readonly StateCell[] }
  | { readonly kind: "fields"; readonly fields: readonly StateField[] }
  | { readonly kind: "text"; readonly text: string };

export type PluginResponse =
  | {
      readonly spec: typeof PLUGIN_SPEC;
      readonly op: "verify";
      readonly status: OracleStatus;
      readonly code: string;
    }
  | {
      readonly spec: typeof PLUGIN_SPEC;
      readonly op: "read";
      readonly status: "ok" | "uncertain";
      readonly code: string;
      readonly state: PluginState | null;
    }
  | {
      readonly spec: typeof PLUGIN_SPEC;
      readonly op: "selftest-cases";
      readonly cases: readonly WireSelfTestCase[];
    };

export interface WireSelfTestCase {
  readonly id: string;
  readonly intent: Json;
  readonly correct: WireDocument;
  readonly corruptions: readonly {
    readonly cls: PluginCorruptionClass;
    readonly doc: WireDocument;
  }[];
}

const B64 = /^[A-Za-z0-9+/]*={0,2}$/;

export function parseDocument(v: unknown, where: string, allowNull: boolean): WireDocument {
  const d = closed(v, where, ["fileName", "bytesB64"]);
  const fileName = str(d.fileName, `${where}.fileName`, FILE_NAME);
  if (fileName === "." || fileName === "..")
    throw new ProtocolError("BAD_VALUE", `${where}.fileName is not a file name`);
  if (d.bytesB64 === null) {
    if (!allowNull) throw new ProtocolError("BAD_VALUE", `${where}.bytesB64 cannot be null`);
    return { fileName, bytesB64: null };
  }
  if (typeof d.bytesB64 !== "string" || d.bytesB64.length % 4 !== 0 || !B64.test(d.bytesB64))
    throw new ProtocolError("BAD_VALUE", `${where}.bytesB64 is not base64`);
  return { fileName, bytesB64: d.bytesB64 };
}

/** JSON intent: plain data only, bounded by MAX_INTENT_BYTES when serialized. */
export function parseIntent(v: unknown, where: string): Json {
  let text: string | undefined;
  try {
    text = JSON.stringify(v);
  } catch {
    throw new ProtocolError("BAD_VALUE", `${where} is not JSON`);
  }
  if (text === undefined) throw new ProtocolError("BAD_VALUE", `${where} is not JSON`);
  if (byteLength(text) > MAX_INTENT_BYTES)
    throw new ProtocolError("INTENT_TOO_LARGE", `${where} exceeds ${MAX_INTENT_BYTES} bytes`);
  return JSON.parse(text) as Json;
}

export function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

export function parseRequest(v: unknown): PluginRequest {
  const base = closed(v, "request", ["spec", "op"], ["doc", "intent"]);
  if (base.spec !== PLUGIN_SPEC) throw new ProtocolError("SPEC_VERSION", "request.spec");
  const op = oneOf(base.op, "request.op", ["verify", "read", "selftest-cases"] as const);
  if (op === "verify") {
    closed(v, "request", ["spec", "op", "doc", "intent"]);
    return {
      spec: PLUGIN_SPEC,
      op,
      doc: parseDocument(base.doc, "request.doc", true),
      intent: parseIntent(base.intent, "request.intent"),
    };
  }
  if (op === "read") {
    closed(v, "request", ["spec", "op", "doc"]);
    return { spec: PLUGIN_SPEC, op, doc: parseDocument(base.doc, "request.doc", true) };
  }
  closed(v, "request", ["spec", "op"]);
  return { spec: PLUGIN_SPEC, op };
}

function parseState(v: unknown): PluginState {
  const kind = oneOf(closed(v, "state", ["kind"], ["cells", "fields", "text"]).kind, "state.kind", [
    "cells",
    "fields",
    "text",
  ] as const);
  const shortStr = (x: unknown, where: string): string => {
    if (typeof x !== "string" || x.length > MAX_STATE_STRING)
      throw new ProtocolError(
        "BAD_VALUE",
        `${where} is not a string of at most ${MAX_STATE_STRING}`,
      );
    return x;
  };
  if (kind === "cells") {
    const s = closed(v, "state", ["kind", "cells"]);
    const cells = list(s.cells, "state.cells", MAX_STATE_ITEMS).map((c, i): StateCell => {
      const o = closed(c, `state.cells[${i}]`, ["ref", "value", "valueKind", "formula"]);
      const valueKind = oneOf(o.valueKind, `state.cells[${i}].valueKind`, [
        "string",
        "number",
        "boolean",
        "empty",
      ] as const);
      const value = o.value;
      const ok =
        (valueKind === "empty" && value === null) ||
        (valueKind === "string" && typeof value === "string" && value.length <= MAX_STATE_STRING) ||
        (valueKind === "number" && typeof value === "number" && Number.isFinite(value)) ||
        (valueKind === "boolean" && typeof value === "boolean");
      if (!ok)
        throw new ProtocolError("BAD_VALUE", `state.cells[${i}].value does not match valueKind`);
      if (typeof o.formula !== "boolean")
        throw new ProtocolError("BAD_VALUE", `state.cells[${i}].formula is not a boolean`);
      return {
        ref: str(o.ref, `state.cells[${i}].ref`, CELL_REF),
        value: value as CellValue,
        valueKind,
        formula: o.formula,
      };
    });
    return { kind, cells };
  }
  if (kind === "fields") {
    const s = closed(v, "state", ["kind", "fields"]);
    const fields = list(s.fields, "state.fields", MAX_STATE_ITEMS).map((f, i) => {
      const o = closed(f, `state.fields[${i}]`, ["label", "value"]);
      return {
        label: shortStr(o.label, `state.fields[${i}].label`),
        value: shortStr(o.value, `state.fields[${i}].value`),
      };
    });
    return { kind, fields };
  }
  const s = closed(v, "state", ["kind", "text"]);
  if (typeof s.text !== "string")
    throw new ProtocolError("BAD_VALUE", "state.text is not a string");
  return { kind, text: s.text };
}

/** Parse a response for the request op that was sent; any other op is malformed. */
export function parseResponse(v: unknown, expectedOp: PluginRequest["op"]): PluginResponse {
  const base = closed(v, "response", ["spec", "op"], ["status", "code", "state", "cases"]);
  if (base.spec !== PLUGIN_SPEC) throw new ProtocolError("SPEC_VERSION", "response.spec");
  if (base.op !== expectedOp) throw new ProtocolError("WRONG_OP", "response.op");
  if (expectedOp === "verify") {
    const r = closed(v, "response", ["spec", "op", "status", "code"]);
    return {
      spec: PLUGIN_SPEC,
      op: "verify",
      status: oneOf(r.status, "response.status", ["verified", "refuted", "uncertain"] as const),
      code: str(r.code, "response.code", CODE),
    };
  }
  if (expectedOp === "read") {
    const r = closed(v, "response", ["spec", "op", "status", "code", "state"]);
    const status = oneOf(r.status, "response.status", ["ok", "uncertain"] as const);
    const state = r.state === null ? null : parseState(r.state);
    if ((status === "ok") !== (state !== null))
      throw new ProtocolError("BAD_VALUE", "response.state is present exactly when status is ok");
    return {
      spec: PLUGIN_SPEC,
      op: "read",
      status,
      code: str(r.code, "response.code", CODE),
      state,
    };
  }
  const r = closed(v, "response", ["spec", "op", "cases"]);
  const ids: string[] = [];
  const cases = list(r.cases, "response.cases", MAX_SELFTEST_CASES).map(
    (c, i): WireSelfTestCase => {
      const o = closed(c, `cases[${i}]`, ["id", "intent", "correct", "corruptions"]);
      const id = str(o.id, `cases[${i}].id`, CASE_ID);
      ids.push(id);
      return {
        id,
        intent: parseIntent(o.intent, `cases[${i}].intent`),
        correct: parseDocument(o.correct, `cases[${i}].correct`, false),
        corruptions: list(o.corruptions, `cases[${i}].corruptions`, MAX_CORRUPTIONS_PER_CASE).map(
          (x, j) => {
            const cx = closed(x, `cases[${i}].corruptions[${j}]`, ["cls", "doc"]);
            return {
              cls: oneOf(cx.cls, `cases[${i}].corruptions[${j}].cls`, PLUGIN_CORRUPTION_CLASSES),
              doc: parseDocument(cx.doc, `cases[${i}].corruptions[${j}].doc`, true),
            };
          },
        ),
      };
    },
  );
  unique(ids, "response.cases[].id");
  return { spec: PLUGIN_SPEC, op: "selftest-cases", cases };
}
