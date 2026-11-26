/**
 * The shared allowlist-only serialization helper (TIF-98, part 2). Closed fields pass,
 * every free-text or path-capable value is replaced structurally (never pattern-redacted),
 * blobs are digest-only, unlisted fields and bad keys refuse, and the backstop refuses a
 * leak a schema let through. Digests are byte-compatible with #556's `exportDigest`.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Identity } from "../../src/leak-guard/detect.ts";
import {
  blob,
  type ClosedSchema,
  closed,
  closeValue,
  digest,
  id,
  type OutwardFormat,
  OutwardRefused,
  oneOf,
  outwardDigest,
  placeholder,
  serializeOutward,
  text,
  textRef,
  token,
  writeOutward,
  writeOutwardBlob,
} from "../../src/leak-guard/serialize.ts";

const NOBODY: Identity = { users: [], hosts: [], paths: [] };
const TAG = "myco.test.outward/1";
/** Planted fakes, assembled at runtime (no literal leak in this file). */
const HOME = ["C:", "Users", "Zq Person", "Desktop", "a.csv"].join("\\");
const POSIX_HOME = ["", "home", "zqperson", "x"].join("/");

const schema: ClosedSchema = {
  tag: TAG,
  fields: {
    "$.schema": oneOf("myco.test/1"),
    "$.id": id,
    "$.app": token,
    "$.instruction": text,
    "$.summary": textRef,
    "$.cwd": placeholder("<path>"),
    "$.sha": digest,
    "$.items[].kind": oneOf("type", "key"),
    "$.items[].text": text,
    "$.counts.*": closed(/^.*$/),
    "$.doc": blob,
  },
};
const format: OutwardFormat<unknown> = { name: "test", schema };

const made: string[] = [];
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

function refusal(fn: () => unknown): OutwardRefused {
  try {
    fn();
  } catch (e) {
    if (e instanceof OutwardRefused) return e;
    throw e;
  }
  throw new Error("expected a refusal");
}

describe("closeValue: allowlist-only, structural replacement", () => {
  const input = {
    schema: "myco.test/1",
    id: "run-1",
    app: "localc",
    instruction: `open ${HOME}`,
    summary: `saved to ${POSIX_HOME}`,
    cwd: POSIX_HOME,
    sha: "a".repeat(64),
    items: [
      { kind: "type", text: HOME },
      { kind: "key", text: "ctrl+s" },
    ],
    counts: { verified: 2, refuted: 1 },
    doc: new TextEncoder().encode(`id\n${HOME}\n`),
    n: 3,
  };

  it("keeps closed values, hashes text, hashes or keeps ids/tokens, digests blobs", () => {
    const out = closeValue({ ...input, n: undefined }, schema) as Record<string, unknown>;
    expect(out.schema).toBe("myco.test/1");
    expect(out.id).toBe("run-1");
    expect(out.app).toBe("localc");
    expect(out.instruction).toBe(`h-${outwardDigest(TAG, input.instruction)}`);
    expect(out.summary).toEqual({
      sha256: outwardDigest(TAG, input.summary),
      length: input.summary.length,
    });
    expect(out.cwd).toBe("<path>");
    expect(out.items).toEqual([
      { kind: "type", text: `h-${outwardDigest(TAG, HOME)}` },
      // Free text is hashed whatever it looks like (never "looks safe, keep it").
      { kind: "key", text: `h-${outwardDigest(TAG, "ctrl+s")}` },
    ]);
    expect(out.doc).toEqual({
      sha256: createHash("sha256").update(input.doc).digest("hex"),
      bytes: input.doc.length,
    });
    expect(closeValue({ id: "a b/c" }, { tag: TAG, fields: { "$.id": id } })).toEqual({
      id: `h-${outwardDigest(TAG, "a b/c")}`,
    });
    expect(closeValue({ app: "My App" }, { tag: TAG, fields: { "$.app": token } })).toEqual({
      app: `h-${outwardDigest(TAG, "My App").slice(0, 60)}`,
    });
  });

  it("the digest is #556's exportDigest (sha256 of tag NUL raw), so its tables port unchanged", () => {
    expect(outwardDigest("myco.episode.export-text/1", "x")).toBe(
      createHash("sha256").update("myco.episode.export-text/1\u0000x", "utf8").digest("hex"),
    );
  });

  it("text is idempotent (re-export of an exported value is byte-identical)", () => {
    const once = closeValue({ instruction: "hello" }, schema) as { instruction: string };
    expect(closeValue(once, schema)).toEqual(once);
  });

  it("refuses an unlisted field, a grammar miss, a bad map key, a misplaced blob: path only", () => {
    expect(refusal(() => closeValue({ note: HOME }, schema))).toMatchObject({
      code: "UNLISTED_FIELD",
      path: "$.note",
    });
    expect(refusal(() => closeValue({ sha: HOME }, schema))).toMatchObject({
      code: "GRAMMAR",
      path: "$.sha",
    });
    expect(refusal(() => closeValue({ counts: { [HOME]: 1 } }, schema))).toMatchObject({
      code: "BAD_KEY",
    });
    expect(refusal(() => closeValue({ doc: "inline" }, schema))).toMatchObject({
      code: "NOT_A_BLOB",
    });
    expect(refusal(() => closeValue({ id: new Uint8Array([1]) }, schema))).toMatchObject({
      code: "GRAMMAR",
    });
    for (const e of [
      refusal(() => closeValue({ note: HOME }, schema)),
      refusal(() => closeValue({ sha: HOME }, schema)),
      refusal(() => closeValue({ counts: { [HOME]: 1 } }, schema)),
    ])
      expect(e.message.includes("Zq Person")).toBe(false);
  });
});

describe("serializeOutward / writeOutward: canonical, backstopped, never overwrite", () => {
  it("serializes canonically and the output carries no planted value", () => {
    const out = serializeOutward(
      format,
      { id: "r", items: [{ kind: "type", text: HOME }] },
      {
        identity: NOBODY,
      },
    );
    expect(out).toBe(
      `{"id":"r","items":[{"kind":"type","text":"h-${outwardDigest(TAG, HOME)}"}]}\n`,
    );
    expect(out.includes("Zq Person")).toBe(false);
  });

  it("the backstop refuses a leak a too-loose schema let through (fail closed)", () => {
    const loose: OutwardFormat<unknown> = {
      name: "loose",
      schema: { tag: TAG, fields: { "$.p": closed(/^.*$/) } },
    };
    expect(
      refusal(() => serializeOutward(loose, { p: POSIX_HOME }, { identity: NOBODY })),
    ).toMatchObject({
      code: "BACKSTOP",
      leakClass: "home-path",
    });
    const user: Identity = { ...NOBODY, users: ["zqperson"] };
    expect(
      refusal(() => serializeOutward(loose, { p: "by zqperson" }, { identity: user })),
    ).toMatchObject({
      code: "BACKSTOP",
      leakClass: "username",
    });
  });

  it("writeOutward writes nothing when it refuses, and never overwrites", () => {
    const dir = mkdtempSync(join(tmpdir(), "myco-outward-"));
    made.push(dir);
    const file = join(dir, "out", "x.json");
    expect(() => writeOutward(file, format, { note: HOME }, { identity: NOBODY })).toThrow(
      OutwardRefused,
    );
    expect(existsSync(file)).toBe(false);
    writeOutward(file, format, { id: "r" }, { identity: NOBODY });
    expect(readFileSync(file, "utf8")).toBe('{"id":"r"}\n');
    expect(() => writeOutward(file, format, { id: "r" }, { identity: NOBODY })).toThrow();
  });

  it("writeOutwardBlob stores content-addressed and refuses a blob that carries a leak", () => {
    const dir = mkdtempSync(join(tmpdir(), "myco-outward-blob-"));
    made.push(dir);
    const bytes = new TextEncoder().encode("id,v\nA,1\n");
    const ref = writeOutwardBlob(dir, bytes, "csv", { identity: NOBODY });
    expect(ref.file).toBe(`${createHash("sha256").update(bytes).digest("hex")}.csv`);
    const leaky = new TextEncoder().encode(`id,p\nA,${HOME}\n`);
    expect(refusal(() => writeOutwardBlob(dir, leaky, "csv", { identity: NOBODY }))).toMatchObject({
      code: "BACKSTOP",
    });
    expect(readdirSync(dir)).toEqual([ref.file]);
  });
});
