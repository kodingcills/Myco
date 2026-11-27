/**
 * The ONE allowlist-only serialization helper for outward-bound output (TIF-98, part 2).
 * Every module that writes a dataset, an episode export or a bundle that leaves the machine
 * serializes through here; `test/leak-guard/routing.test.ts` fails a module that does not.
 *
 * It generalises the closed-schema pattern #553 (Q3 proof bundles), #556 (episode export)
 * and #559 (dataset export) each built for one format, with the same vocabulary, so their
 * tables port over unchanged:
 *
 *  - Every string the output can hold sits at a JSON path listed in the schema (`[]` for any
 *    array index, `*` for any object key), with a treatment. A string at an unlisted path
 *    REFUSES the write (a new field is a reviewed change), naming the path, never the value.
 *  - `closed(grammar)` / `oneOf(...)`: written as is when it matches; anything else refuses.
 *  - `id`: written as is when it matches `CLOSED_ID`, else `h-<digest>` (equality survives).
 *  - `token`: as is when it matches `CLOSED_TOKEN`, else `h-<first 60 hex of the digest>`.
 *  - `text` (any free-text or path-capable value): ALWAYS `h-<digest>`, whatever it looks
 *    like. Never pattern-redacted: patterns keep missing path forms (#553's probe corpus).
 *  - `textRef`: `{ sha256, length }` of the raw value (#553's TextRef), for text whose length
 *    is evidence.
 *  - `placeholder(value)`: always the fixed placeholder (a field whose content must not even
 *    be confirmable by guessing).
 *  - `blob`: a byte array becomes `{ sha256, bytes }`; blob CONTENT is never inlined.
 *  - Numbers, booleans and null carry no text and pass through. Object keys under a `*`
 *    segment must be `CLOSED_ID`s (or the write refuses).
 *
 * Digests are sha256 of `<schema tag> NUL <raw>`, unsalted, exactly as #556's
 * `exportDigest`: a digest does not reveal its input, but someone who guesses the exact
 * input can confirm the guess (the price of checkable equality, as #553 states).
 *
 * BACKSTOP: the closed output is then scanned with the shared detector
 * (`src/leak-guard/detect.ts`); any finding refuses the write (fail closed). It is a
 * backstop: the schema, not the scan, keeps a path out.
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { classesIn, hostIdentity, type Identity, type LeakClass } from "./detect.ts";

/** A closed id (#553, #556): starts alphanumeric, then letters, digits, `.`, `_`, `-`; ≤128. */
export const CLOSED_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** A short closed token (#556): no space, no separator; at most 64. */
export const CLOSED_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
export const HEX64 = /^[0-9a-f]{64}$/;
const HASHED = /^h-[0-9a-f]{64}$/;

export type Treatment =
  | { readonly kind: "text" }
  | { readonly kind: "textRef" }
  | { readonly kind: "id" }
  | { readonly kind: "token" }
  | { readonly kind: "closed"; readonly grammar: RegExp }
  | { readonly kind: "placeholder"; readonly value: string }
  | { readonly kind: "blob" };

export const text: Treatment = { kind: "text" };
export const textRef: Treatment = { kind: "textRef" };
export const id: Treatment = { kind: "id" };
export const token: Treatment = { kind: "token" };
export const blob: Treatment = { kind: "blob" };
export const closed = (grammar: RegExp): Treatment => ({ kind: "closed", grammar });
export const oneOf = (...values: readonly string[]): Treatment =>
  closed(
    new RegExp(`^(?:${values.map((v) => v.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")).join("|")})$`),
  );
export const digest: Treatment = closed(HEX64);
export const placeholder = (value: string): Treatment => {
  if (!/^<[a-z0-9.-]{1,32}>$/.test(value)) throw new Error("a placeholder is `<lower-token>`");
  return { kind: "placeholder", value };
};

export interface ClosedSchema {
  /** Domain tag for digests, versioned (`myco.episode.export-text/1`): a change is reviewed. */
  readonly tag: string;
  /** Every string (or blob) path the output can hold, and its treatment. */
  readonly fields: Readonly<Record<string, Treatment>>;
}

/**
 * What #553, #556 and #559 integrate through once they land (TO FILE on TIF-98): each
 * format names its schema here, and its writer calls `writeOutward` / `serializeOutward`
 * instead of `writeFileSync(JSON.stringify(...))`.
 */
export interface OutwardFormat<T> {
  readonly name: string;
  readonly schema: ClosedSchema;
  /** Format-specific fix-ups after closing (e.g. recompute a content id over closed data). */
  readonly finish?: (closedValue: unknown) => T;
}

export type RefusalCode = "UNLISTED_FIELD" | "GRAMMAR" | "BAD_KEY" | "NOT_A_BLOB" | "BACKSTOP";

/** Refused input: names the path (template) and the reason, never the value. */
export class OutwardRefused extends Error {
  constructor(
    readonly code: RefusalCode,
    readonly path: string,
    readonly leakClass?: LeakClass,
  ) {
    super(`outward write refused: ${code} at ${path}${leakClass ? ` (${leakClass})` : ""}`);
    this.name = "OutwardRefused";
  }
}

export function outwardDigest(tag: string, raw: string | Uint8Array): string {
  const h = createHash("sha256").update(`${tag}\u0000`, "utf8");
  return h.update(raw).digest("hex");
}

/** `$.items[3].k` -> `$.items[].k`. */
export const templateOf = (path: string) => path.replace(/\[\d+\]/g, "[]");

function lookup(schema: ClosedSchema, path: string): Treatment | undefined {
  const t = templateOf(path);
  const exact = schema.fields[t];
  if (exact !== undefined) return exact;
  // `*` matches one object-key segment.
  for (const [pattern, treatment] of Object.entries(schema.fields)) {
    if (!pattern.includes("*")) continue;
    const re = new RegExp(
      `^${pattern
        .split("*")
        .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join("[^.[\\]]+")}$`,
    );
    if (re.test(t)) return treatment;
  }
  return undefined;
}

function hasWildcardFor(schema: ClosedSchema, path: string): boolean {
  const prefix = `${templateOf(path)}.*`;
  return Object.keys(schema.fields).some(
    (k) => k === prefix || k.startsWith(`${prefix}.`) || k.startsWith(`${prefix}[`),
  );
}

function treatString(schema: ClosedSchema, path: string, value: string): unknown {
  const t = lookup(schema, path);
  if (t === undefined) throw new OutwardRefused("UNLISTED_FIELD", templateOf(path));
  switch (t.kind) {
    case "text":
      // Idempotent: an already-hashed value carries nothing (re-export is byte-identical).
      return HASHED.test(value) ? value : `h-${outwardDigest(schema.tag, value)}`;
    case "textRef":
      return { sha256: outwardDigest(schema.tag, value), length: value.length };
    case "id":
      return CLOSED_ID.test(value) ? value : `h-${outwardDigest(schema.tag, value)}`;
    case "token":
      return CLOSED_TOKEN.test(value)
        ? value
        : `h-${outwardDigest(schema.tag, value).slice(0, 60)}`;
    case "closed":
      if (!t.grammar.test(value)) throw new OutwardRefused("GRAMMAR", templateOf(path));
      return value;
    case "placeholder":
      return t.value;
    case "blob":
      throw new OutwardRefused("NOT_A_BLOB", templateOf(path));
  }
}

/** The closed form of `value` under `schema` (throws `OutwardRefused`). */
export function closeValue(value: unknown, schema: ClosedSchema): unknown {
  const walk = (node: unknown, path: string): unknown => {
    if (typeof node === "string") return treatString(schema, path, node);
    if (node instanceof Uint8Array) {
      const t = lookup(schema, path);
      if (t === undefined) throw new OutwardRefused("UNLISTED_FIELD", templateOf(path));
      if (t.kind !== "blob") throw new OutwardRefused("GRAMMAR", templateOf(path));
      return { sha256: createHash("sha256").update(node).digest("hex"), bytes: node.length };
    }
    if (Array.isArray(node)) return node.map((item, i) => walk(item, `${path}[${i}]`));
    if (node !== null && typeof node === "object") {
      const wild = hasWildcardFor(schema, path);
      return Object.fromEntries(
        Object.entries(node).map(([k, v]) => {
          // A key is outward text too: under `*` it must be a closed id; elsewhere the
          // path itself must be listed (an unlisted key refuses at its leaves).
          if (wild && !CLOSED_ID.test(k))
            throw new OutwardRefused("BAD_KEY", `${templateOf(path)}.*`);
          return [k, walk(v, `${path}.${k}`)];
        }),
      );
    }
    if (typeof node === "number" && !Number.isFinite(node))
      throw new OutwardRefused("GRAMMAR", templateOf(path));
    return node; // number, boolean, null, undefined (dropped by JSON)
  };
  return walk(value, "$");
}

/** Canonical JSON: object keys sorted, no whitespace. */
export function canonicalJson(value: unknown): string {
  const norm = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(norm);
    if (v !== null && typeof v === "object")
      return Object.fromEntries(
        Object.keys(v)
          .sort()
          .map((k) => [k, norm((v as Record<string, unknown>)[k])]),
      );
    return v;
  };
  return JSON.stringify(norm(value));
}

export interface OutwardOptions {
  /** Identity for the backstop scan. Default: this machine (`os`, never the environment). */
  readonly identity?: Identity;
}

function backstop(textOut: string, identity: Identity): void {
  const found = classesIn(textOut, { identity });
  if (found.length > 0) throw new OutwardRefused("BACKSTOP", "$", found[0]);
}

/** Closes, finishes and serializes one value (canonical JSON + newline), backstop-scanned. */
export function serializeOutward<T>(
  format: OutwardFormat<T>,
  value: unknown,
  options: OutwardOptions = {},
): string {
  const closedValue = closeValue(value, format.schema);
  const finished = format.finish === undefined ? closedValue : format.finish(closedValue);
  const out = `${canonicalJson(finished)}\n`;
  backstop(out, options.identity ?? hostIdentity(process.cwd()));
  return out;
}

/** JSON Lines: one closed value per line. */
export function serializeOutwardLines<T>(
  format: OutwardFormat<T>,
  values: readonly unknown[],
  options: OutwardOptions = {},
): string {
  return values.map((v) => serializeOutward(format, v, options)).join("");
}

/**
 * The single sanctioned write for outward JSON: closes, serializes, backstop-scans, then
 * writes with `wx` (never overwrites). Nothing is written when anything refuses.
 */
export function writeOutward<T>(
  file: string,
  format: OutwardFormat<T>,
  value: unknown,
  options: OutwardOptions = {},
): void {
  const out = serializeOutward(format, value, options);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, out, { flag: "wx" });
}

/**
 * The single sanctioned write for an outward blob: stored content-addressed
 * (`<dir>/<sha256>.<ext>`), its bytes backstop-scanned as text first (a CSV or JSON blob
 * can carry a path). Returns the digest reference, which is all the JSON may hold.
 */
export function writeOutwardBlob(
  dir: string,
  bytes: Uint8Array,
  ext: "png" | "csv" | "json" | "xlsx" | "bin",
  options: OutwardOptions = {},
): { sha256: string; bytes: number; file: string } {
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  backstop(Buffer.from(bytes).toString("latin1"), options.identity ?? hostIdentity(process.cwd()));
  const file = `${sha256}.${ext}`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), bytes, { flag: "wx" });
  return { sha256, bytes: bytes.length, file };
}
