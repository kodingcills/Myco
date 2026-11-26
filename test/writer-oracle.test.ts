import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { TaskIntent } from "../src/core/verify.ts";
import {
  applyGroundTruth,
  BODY_STYLE,
  groundTruth,
  NOTE_STYLE,
  normalizeWriterParams,
  WRITER_POSTCONDITION_KINDS,
  WRITER_TASK_ID,
  type WriterDocEditParams,
  type WriterDocSpec,
  type WriterPostconditionKind,
  writerFixture,
  writerIntentFor,
  writerTaskFor,
} from "../src/tasks/writer-doc-edit.ts";
import {
  DOCX_MAIN_PART,
  docxEntries,
  flippedByte,
  ODT_MAIN_PART,
  odtEntries,
  partiallySaved,
  truncated,
  type WriterFormat,
  withoutMainPart,
  writeWriterDocument,
  writeZip,
  type ZipEntryInput,
} from "../src/tasks/writer-docgen.ts";
import {
  verifyWriterDocument,
  verifyWriterFile,
  WRITER_REASON_STATUS,
  type WriterReasonCode,
  type WriterVerdict,
} from "../src/verify/writer-oracle.ts";
import { parseWriterDocument, readWriterDocument } from "../src/verify/writer-reader.ts";
import { parseXml, XmlSyntaxError } from "../src/verify/writer-xml.ts";
import {
  deflatedZeros,
  HOSTILE_SEED,
  hostileEntries,
  odtRepeatBomb,
  zipBomb,
} from "./writer-hostile.ts";

const ROOT = join(import.meta.dirname, "..");
const DIR = mkdtempSync(join(tmpdir(), "myco-writer-oracle-"));
afterAll(() => rmSync(DIR, { recursive: true, force: true }));

const FORMATS: readonly WriterFormat[] = ["docx", "odt"];
const SEEDS = ["w-001", "w-002", "w-003", "w-004", "w-005"];

let counter = 0;
function save(bytes: Uint8Array, ext: string): string {
  const path = join(DIR, `doc-${counter++}.${ext}`);
  writeFileSync(path, bytes);
  return path;
}

function task(
  seed: string,
  kind: WriterPostconditionKind,
): { params: WriterDocEditParams; intent: TaskIntent } {
  const params = writerTaskFor(seed, kind);
  return { params, intent: writerIntentFor(params) };
}

/** The end state a correct agent leaves for this one task. */
function editedSpec(params: WriterDocEditParams): WriterDocSpec {
  return applyGroundTruth(writerFixture(params.fixtureSeed), groundTruth(params));
}

/** A wrong-value end state: the agent touched the target but left the wrong value. */
function wrongValueSpec(params: WriterDocEditParams): WriterDocSpec {
  const wrong: WriterDocEditParams =
    params.kind === "paragraph-text"
      ? { ...params, newText: `${params.newText} x` }
      : params.kind === "table-cell"
        ? { ...params, newText: `${params.newText}0` }
        : params.kind === "heading-level"
          ? { ...params, level: 4 }
          : { ...params, style: BODY_STYLE === params.style ? NOTE_STYLE : BODY_STYLE };
  if (params.kind === "paragraph-style") {
    // The fixture paragraph is already Myco Body; "wrong" is a third style the agent picked.
    const fixture = writerFixture(params.fixtureSeed);
    let i = -1;
    return {
      blocks: fixture.blocks.map((b) => {
        if (b.kind !== "paragraph") return b;
        i++;
        return i === params.paragraph ? { ...b, style: "Heading 3", headingLevel: null } : b;
      }),
    };
  }
  return editedSpec(wrong);
}

function verifyBytes(bytes: Uint8Array, format: WriterFormat, intent: TaskIntent): WriterVerdict {
  return verifyWriterFile(save(bytes, format), intent);
}

function mutateEntries(
  entries: ZipEntryInput[],
  name: string,
  fn: (xml: string) => string,
): Uint8Array {
  return writeZip(
    entries.map((e) =>
      e.name === name
        ? { ...e, data: new TextEncoder().encode(fn(new TextDecoder().decode(e.data))) }
        : e,
    ),
  );
}

// ---------------------------------------------------------------------------

describe("writer-xml: strict parsing", () => {
  it("parses elements, attributes, entities, CDATA and comments", () => {
    const root = parseXml(
      `<?xml version="1.0"?><!-- c --><a x="1 &amp; 2" y='&#x41;'>t&lt;<b/><![CDATA[<raw>]]><!-- d --></a>`,
    );
    expect(root.name).toBe("a");
    expect(root.attrs).toEqual({ x: "1 & 2", y: "A" });
    expect(root.children).toEqual(["t<", { name: "b", attrs: {}, children: [] }, "<raw>"]);
  });

  it.each([
    ["truncated mid-element", "<a><b>text</b"],
    ["unclosed root", "<a><b/>"],
    ["mismatched close", "<a><b></a></b>"],
    ["bare ampersand", "<a>x & y</a>"],
    ["unknown entity", "<a>&nbsp;</a>"],
    ["duplicate attribute", '<a x="1" x="2"/>'],
    ["content after root", "<a/><b/>"],
    ["no root", "<?xml version='1.0'?>"],
    ["unterminated attribute", '<a x="1/>'],
    ["empty", ""],
  ])("rejects %s", (_name, xml) => {
    expect(() => parseXml(xml)).toThrow(XmlSyntaxError);
  });
});

describe("writer-doc-edit: host-side ground truth", () => {
  it("fixtures and tasks are deterministic per seed", () => {
    for (const kind of WRITER_POSTCONDITION_KINDS) {
      expect(writerTaskFor("s", kind)).toEqual(writerTaskFor("s", kind));
    }
    expect(writerFixture("s")).toEqual(writerFixture("s"));
    expect(writerFixture("s")).not.toEqual(writerFixture("t"));
  });

  it("every generated task has computable ground truth that changes the document", () => {
    for (const seed of SEEDS) {
      for (const kind of WRITER_POSTCONDITION_KINDS) {
        const gt = groundTruth(writerTaskFor(seed, kind));
        expect(gt.expected).not.toEqual(gt.previous);
      }
    }
  });

  it.each([
    ["empty seed", { fixtureSeed: "", kind: "paragraph-text", paragraph: 1, newText: "X." }],
    [
      "paragraph out of range",
      { fixtureSeed: "s", kind: "paragraph-text", paragraph: 99, newText: "X." },
    ],
    [
      "no-op text",
      {
        fixtureSeed: "s",
        kind: "paragraph-text",
        paragraph: 0,
        newText:
          writerFixture("s").blocks[0]?.kind === "paragraph"
            ? (writerFixture("s").blocks[0] as { text: string }).text
            : "",
      },
    ],
    [
      "unknown heading text",
      { fixtureSeed: "s", kind: "heading-level", headingText: "Nope", level: 2 },
    ],
    [
      "level 0",
      {
        fixtureSeed: "s",
        kind: "heading-level",
        headingText: (writerFixture("s").blocks[3] as { text: string }).text,
        level: 0,
      },
    ],
    [
      "no-op level",
      {
        fixtureSeed: "s",
        kind: "heading-level",
        headingText: (writerFixture("s").blocks[3] as { text: string }).text,
        level: 2,
      },
    ],
    [
      "bad cell name",
      { fixtureSeed: "s", kind: "table-cell", table: 0, cell: "Z99", newText: "X" },
    ],
    ["missing table", { fixtureSeed: "s", kind: "table-cell", table: 3, cell: "A1", newText: "X" }],
    ["unknown style", { fixtureSeed: "s", kind: "paragraph-style", paragraph: 1, style: "Nope" }],
    ["no-op style", { fixtureSeed: "s", kind: "paragraph-style", paragraph: 1, style: BODY_STYLE }],
    ["unknown kind", { fixtureSeed: "s", kind: "delete-everything" }],
  ])("rejects %s with an uncertain verdict, never a guess", (_name, params) => {
    const intent: TaskIntent = { taskId: WRITER_TASK_ID, params, describe: "x" };
    const edited = writeWriterDocument(writerFixture("s"), "odt");
    const v = verifyBytes(edited, "odt", intent);
    expect(v.status).toBe("uncertain");
    expect(v.code).toBe("ground-truth-invalid");
    expect(v.reasons[0]).toMatch(/^could not look: /);
  });

  it("rejects an intent for another task family", () => {
    const v = verifyBytes(writeWriterDocument(writerFixture("s"), "docx"), "docx", {
      taskId: "calc-record-edit",
      params: { fixtureSeed: "s" },
      describe: "x",
    });
    expect(v.code).toBe("ground-truth-invalid");
  });
});

describe.each(FORMATS)("writer oracle (%s): verdict per postcondition", (format) => {
  describe.each(WRITER_POSTCONDITION_KINDS)("%s", (kind) => {
    it("verified when the saved file holds the expected value", () => {
      for (const seed of SEEDS) {
        const { params, intent } = task(seed, kind);
        const v = verifyBytes(writeWriterDocument(editedSpec(params), format), format, intent);
        expect(v, `${seed}`).toMatchObject({ status: "verified", code: "postcondition-holds" });
      }
    });

    it("refuted when the file was saved without the edit (pristine)", () => {
      for (const seed of SEEDS) {
        const { params, intent } = task(seed, kind);
        const v = verifyBytes(
          writeWriterDocument(writerFixture(params.fixtureSeed), format),
          format,
          intent,
        );
        expect(v, `${seed}`).toMatchObject({ status: "refuted", code: "value-mismatch" });
      }
    });

    it("refuted when the file holds a wrong value at the target", () => {
      for (const seed of SEEDS) {
        const { params, intent } = task(seed, kind);
        const v = verifyBytes(writeWriterDocument(wrongValueSpec(params), format), format, intent);
        expect(v, `${seed}`).toMatchObject({ status: "refuted", code: "value-mismatch" });
      }
    });

    it("refuted when the target was deleted from a readable file", () => {
      const { params, intent } = task("w-001", kind);
      const spec = editedSpec(params);
      const gutted: WriterDocSpec =
        kind === "table-cell"
          ? { blocks: spec.blocks.filter((b) => b.kind !== "table") }
          : kind === "heading-level"
            ? {
                blocks: spec.blocks.filter(
                  (b) =>
                    b.kind !== "paragraph" ||
                    b.headingLevel === null ||
                    b.text !== (params as { headingText: string }).headingText,
                ),
              }
            : {
                blocks: [
                  ...spec.blocks.filter((b) => b.kind === "table"),
                  ...spec.blocks.filter((b) => b.kind === "paragraph").slice(0, 1),
                ],
              };
      const v = verifyBytes(writeWriterDocument(gutted, format), format, intent);
      expect(v).toMatchObject({ status: "refuted", code: "target-absent" });
    });

    it("uncertain (never verified) for a corrupt, truncated or partially saved edited file", () => {
      const { params, intent } = task("w-002", kind);
      const spec = editedSpec(params);
      const good = writeWriterDocument(spec, format);
      const variants: [string, Uint8Array, WriterReasonCode][] = [
        ["empty", new Uint8Array(0), "read-corrupt"],
        ["truncated 50%", truncated(good, 0.5), "read-corrupt"],
        ["truncated 99%", truncated(good, 0.99), "read-corrupt"],
        ["partially saved main part", partiallySaved(spec, format, 0.6), "read-corrupt"],
        ["main part missing", withoutMainPart(spec, format), "read-corrupt"],
        ["not a zip", new TextEncoder().encode("hello, I am not a document"), "read-unreadable"],
      ];
      for (const [name, bytes, code] of variants) {
        const v = verifyBytes(bytes, format, intent);
        expect(v, name).toMatchObject({ status: "uncertain", code });
        expect(v.reasons[0], name).toMatch(/^could not look: /);
      }
      expect(verifyWriterFile(join(DIR, "never-saved.odt"), intent)).toMatchObject({
        status: "uncertain",
        code: "read-missing",
      });
    });
  });
});

describe("writer oracle: damaged files are never verified (sweep)", () => {
  function mainEntryDataRange(format: WriterFormat, spec: WriterDocSpec): [number, number] {
    // Recompute the layout writeZip produces: local header (30) + name + body, in order.
    const entries = format === "docx" ? docxEntries(spec) : odtEntries(spec);
    const main = format === "docx" ? DOCX_MAIN_PART : ODT_MAIN_PART;
    const bytes = writeWriterDocument(spec, format);
    const buf = Buffer.from(bytes);
    let at = 0;
    for (const e of entries) {
      const nameLen = buf.readUInt16LE(at + 26);
      const comp = buf.readUInt32LE(at + 18);
      const start = at + 30 + nameLen;
      if (e.name === main) return [start, start + comp];
      at = start + comp;
    }
    throw new Error("main part not found");
  }

  it.each(FORMATS)(
    "%s: truncation at every 1/40th, partial saves and flipped body bytes",
    (format) => {
      let checked = 0;
      for (const kind of WRITER_POSTCONDITION_KINDS) {
        const { params, intent } = task("w-003", kind);
        const spec = editedSpec(params);
        const good = writeWriterDocument(spec, format);
        expect(verifyBytes(good, format, intent).status).toBe("verified");
        const damaged: Uint8Array[] = [];
        for (let i = 0; i < 40; i++) damaged.push(truncated(good, i / 40));
        for (let i = 1; i < 20; i++) damaged.push(partiallySaved(spec, format, i / 20));
        const [start, end] = mainEntryDataRange(format, spec);
        for (let off = start; off < end; off += Math.max(1, Math.floor((end - start) / 25))) {
          damaged.push(flippedByte(good, off));
        }
        for (const bytes of damaged) {
          const v = verifyWriterDocumentBytes(bytes, format, intent);
          expect(v.status).toBe("uncertain");
          checked++;
        }
      }
      expect(checked).toBeGreaterThan(300);
    },
  );

  function verifyWriterDocumentBytes(
    bytes: Uint8Array,
    format: WriterFormat,
    intent: TaskIntent,
  ): WriterVerdict {
    try {
      return verifyWriterDocument(parseWriterDocument(bytes, `mem.${format}`), intent);
    } catch {
      return { status: "uncertain", code: "read-corrupt", reasons: ["could not look"] };
    }
  }
});

describe("writer oracle: ambiguous targets are uncertain, not guessed", () => {
  it("heading-level: two paragraphs carry the target text", () => {
    const { params, intent } = task("w-001", "heading-level");
    const spec = editedSpec(params);
    const target = spec.blocks.find(
      (b) => b.kind === "paragraph" && b.text === (params as { headingText: string }).headingText,
    );
    for (const format of FORMATS) {
      const v = verifyBytes(
        writeWriterDocument({ blocks: [...spec.blocks, target!] }, format),
        format,
        intent,
      );
      expect(v).toMatchObject({ status: "uncertain", code: "ambiguous-target" });
    }
  });

  it("table-cell: a merged cell (docx gridSpan / vMerge, odt covered cell) makes names ambiguous", () => {
    const { params, intent } = task("w-001", "table-cell");
    const spec = editedSpec(params);
    const docx = mutateEntries(docxEntries(spec), DOCX_MAIN_PART, (xml) =>
      xml.replace("<w:tcPr>", '<w:tcPr><w:gridSpan w:val="2"/>'),
    );
    expect(verifyBytes(docx, "docx", intent)).toMatchObject({
      status: "uncertain",
      code: "merged-cell",
    });
    const vmerge = mutateEntries(docxEntries(spec), DOCX_MAIN_PART, (xml) =>
      xml.replace("<w:tcPr>", "<w:tcPr><w:vMerge/>"),
    );
    expect(verifyBytes(vmerge, "docx", intent)).toMatchObject({
      status: "uncertain",
      code: "merged-cell",
    });
    const odt = mutateEntries(odtEntries(spec), ODT_MAIN_PART, (xml) =>
      xml.replace(
        /<table:table-cell office:value-type="string">(.*?)<\/table:table-cell>/,
        "<table:covered-table-cell/>",
      ),
    );
    expect(verifyBytes(odt, "odt", intent)).toMatchObject({
      status: "uncertain",
      code: "merged-cell",
    });
  });

  it("paragraph-style: the paragraph names a style the file does not define", () => {
    const { params, intent } = task("w-001", "paragraph-style");
    const spec = editedSpec(params);
    const docx = mutateEntries(docxEntries(spec), "word/styles.xml", (xml) =>
      xml.replace(/<w:style [^>]*w:styleId="MycoNote">.*?<\/w:style>/, ""),
    );
    expect(verifyBytes(docx, "docx", intent)).toMatchObject({
      status: "uncertain",
      code: "style-unresolved",
    });
    const odt = mutateEntries(odtEntries(spec), "styles.xml", (xml) =>
      xml.replace(/<style:style style:name="Myco_20_Note"[^>]*\/>/, ""),
    );
    expect(verifyBytes(odt, "odt", intent)).toMatchObject({
      status: "uncertain",
      code: "style-unresolved",
    });
  });

  it("heading-level (docx): the level depends on a style the file does not define", () => {
    const { params, intent } = task("w-001", "heading-level");
    const gt = groundTruth(params);
    const spec = editedSpec(params);
    const docx = mutateEntries(docxEntries(spec), "word/styles.xml", (xml) =>
      xml.replace(new RegExp(`<w:style [^>]*w:styleId="Heading${gt.expected}">.*?</w:style>`), ""),
    );
    expect(verifyBytes(docx, "docx", intent)).toMatchObject({
      status: "uncertain",
      code: "style-unresolved",
    });
  });
});

describe("writer reader: format details", () => {
  it("docx: a direct w:outlineLvl wins over the style; tracked deletions and field codes are not text", () => {
    const spec: WriterDocSpec = {
      blocks: [{ kind: "paragraph", text: "Alpha", style: BODY_STYLE, headingLevel: null }],
    };
    const bytes = mutateEntries(docxEntries(spec), DOCX_MAIN_PART, (xml) =>
      xml
        .replace(
          '<w:pStyle w:val="MycoBody"/>',
          '<w:pStyle w:val="MycoBody"/><w:outlineLvl w:val="3"/>',
        )
        .replace(
          "</w:p>",
          "<w:del><w:r><w:delText>GONE</w:delText></w:r></w:del><w:ins><w:r><w:t> beta</w:t></w:r></w:ins><w:r><w:instrText>PAGE</w:instrText></w:r></w:p>",
        ),
    );
    const doc = parseWriterDocument(bytes, "x.docx");
    expect(doc.blocks[0]).toMatchObject({
      text: "Alpha beta",
      headingLevel: 4,
      styleName: BODY_STYLE,
    });
  });

  it("odt: white space collapses, text:s/tab/line-break expand, lists and sections flatten", () => {
    const spec: WriterDocSpec = {
      blocks: [{ kind: "paragraph", text: "A  b\tc", style: BODY_STYLE, headingLevel: null }],
    };
    const bytes = mutateEntries(odtEntries(spec), ODT_MAIN_PART, (xml) =>
      xml
        .replace(
          "</office:text>",
          '<text:section text:name="S"><text:list><text:list-item><text:p text:style-name="P9">x\n   y<text:line-break/>z</text:p></text:list-item></text:list></text:section></office:text>',
        )
        .replace(
          "<office:automatic-styles/>",
          '<office:automatic-styles><style:style style:name="P9" style:family="paragraph" style:parent-style-name="Myco_20_Note"/></office:automatic-styles>',
        ),
    );
    const doc = parseWriterDocument(bytes, "x.odt");
    expect(doc.blocks.map((b) => (b.kind === "paragraph" ? [b.text, b.styleName] : null))).toEqual([
      ["A  b\tc", BODY_STYLE],
      ["x y\nz", NOTE_STYLE],
    ]);
  });

  it("rejects a ZIP whose central directory disagrees with the entry's data as corrupt", () => {
    const good = Buffer.from(writeWriterDocument(writerFixture("s"), "docx"));
    // Bump the recorded uncompressed size of every central-directory entry by one byte;
    // data and CRC stay intact, so only the size cross-check can notice.
    const bad = Buffer.from(good);
    for (let i = 0; i + 4 <= bad.length; i++) {
      if (bad.readUInt32LE(i) === 0x02014b50)
        bad.writeUInt32LE(bad.readUInt32LE(i + 24) + 1, i + 24);
    }
    expect(() => parseWriterDocument(new Uint8Array(good), "x.docx")).not.toThrow();
    expect(() => parseWriterDocument(new Uint8Array(bad), "x.docx")).toThrow(/inflates to/);
  });

  it("rejects a spreadsheet package as unreadable, not as a Writer verdict", () => {
    const entries = odtEntries(writerFixture("s")).map((e) =>
      e.name === "mimetype"
        ? { ...e, data: new TextEncoder().encode("application/vnd.oasis.opendocument.spreadsheet") }
        : e,
    );
    expect(() => parseWriterDocument(writeZip(entries), "x.ods")).toThrow(
      /not a Writer text document/,
    );
  });

  it("rejects a document whose root binds the wrong namespace (strict OOXML) as unreadable", () => {
    const bytes = mutateEntries(docxEntries(writerFixture("s")), DOCX_MAIN_PART, (xml) =>
      xml.replace(
        'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"',
        'xmlns:w="http://purl.oclc.org/ooxml/wordprocessingml/main"',
      ),
    );
    const v = verifyBytes(bytes, "docx", task("s", "paragraph-text").intent);
    expect(v).toMatchObject({ status: "uncertain", code: "read-unreadable" });
  });
});

describe("writer oracle: real LibreOffice output (committed fixtures)", () => {
  const FIX = join(ROOT, "test", "fixtures", "writer-lo");
  const manifest = JSON.parse(readFileSync(join(FIX, "manifest.json"), "utf8")) as {
    seed: string;
    soffice: string;
    files: Record<string, { sha256: string; from: string }>;
  };

  it("the committed fixtures are the ones the manifest records", () => {
    expect(Object.keys(manifest.files).sort()).toEqual([
      "edited.lo.docx",
      "edited.lo.odt",
      "pristine.lo.docx",
      "pristine.lo.odt",
    ]);
    expect(manifest.soffice).toMatch(/^LibreOffice /);
    for (const [name, { sha256 }] of Object.entries(manifest.files)) {
      expect(
        createHash("sha256")
          .update(readFileSync(join(FIX, name)))
          .digest("hex"),
        name,
      ).toBe(sha256);
    }
  });

  it.each(["docx", "odt"])("LibreOffice-written edited .%s verifies every postcondition", (ext) => {
    const path = join(FIX, `edited.lo.${ext}`);
    for (const kind of WRITER_POSTCONDITION_KINDS) {
      expect(verifyWriterFile(path, task(manifest.seed, kind).intent), kind).toMatchObject({
        status: "verified",
        code: "postcondition-holds",
      });
    }
  });

  it.each(["docx", "odt"])(
    "LibreOffice-written pristine .%s refutes every postcondition",
    (ext) => {
      const path = join(FIX, `pristine.lo.${ext}`);
      for (const kind of WRITER_POSTCONDITION_KINDS) {
        expect(verifyWriterFile(path, task(manifest.seed, kind).intent), kind).toMatchObject({
          status: "refuted",
          code: "value-mismatch",
        });
      }
    },
  );

  it.each(["docx", "odt"])("truncated LibreOffice-written edited .%s is never verified", (ext) => {
    const good = new Uint8Array(readFileSync(join(FIX, `edited.lo.${ext}`)));
    for (let i = 0; i < 20; i++) {
      for (const kind of WRITER_POSTCONDITION_KINDS) {
        const v = verifyBytes(
          truncated(good, i / 20),
          ext as WriterFormat,
          task(manifest.seed, kind).intent,
        );
        expect(v.status).toBe("uncertain");
      }
    }
  });

  it("the reader sees LibreOffice's structure, not just the generator's", () => {
    const doc = readWriterDocument(join(FIX, "edited.lo.odt"));
    expect(doc.format).toBe("odt");
    expect(doc.blocks.filter((b) => b.kind === "table")).toHaveLength(1);
  });
});

describe("writer oracle: verdict integrity (M2 plan R4)", () => {
  it("only postcondition-holds maps to verified", () => {
    const verified = Object.entries(WRITER_REASON_STATUS).filter(([, s]) => s === "verified");
    expect(verified).toEqual([["postcondition-holds", "verified"]]);
  });

  it("the ground-truth module never imports the read path, the oracle or the file system", () => {
    const src = readFileSync(join(ROOT, "src", "tasks", "writer-doc-edit.ts"), "utf8");
    const imports = [...src.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
    expect(imports.sort()).toEqual(["../core/verify.ts", "./fixture.ts"]);
  });

  it("the oracle takes only the saved file and the intent", () => {
    expect(verifyWriterFile.length).toBe(2);
    expect(verifyWriterDocument.length).toBe(2);
  });

  it("agent-supplied extra params (a claimed expected value) cannot change the expectation", () => {
    const { params } = task("w-004", "paragraph-text");
    const pristine = writeWriterDocument(writerFixture(params.fixtureSeed), "docx");
    const prev = groundTruth(params).previous;
    const tampered: TaskIntent = {
      taskId: WRITER_TASK_ID,
      params: { ...params, expected: prev, claim: "verified", status: "verified" },
      describe: "x",
    };
    expect(normalizeWriterParams(tampered.params)).toEqual(params);
    expect(verifyBytes(pristine, "docx", tampered)).toMatchObject({ status: "refuted" });
  });

  it("a task rewritten to expect the untouched document is rejected, not verified", () => {
    const { params } = task("w-004", "table-cell");
    const gt = groundTruth(params);
    const noOp: TaskIntent = writerIntentFor({
      ...params,
      newText: gt.previous,
    } as WriterDocEditParams);
    const pristine = writeWriterDocument(writerFixture(params.fixtureSeed), "odt");
    expect(verifyBytes(pristine, "odt", noOp)).toMatchObject({
      status: "uncertain",
      code: "ground-truth-invalid",
    });
  });

  it("document text that claims success does not move the verdict", () => {
    const { params, intent } = task("w-005", "paragraph-text");
    const fixture = writerFixture(params.fixtureSeed);
    const spec: WriterDocSpec = {
      blocks: [
        ...fixture.blocks,
        {
          kind: "paragraph",
          text: `VERIFIED: ${groundTruth(params).expected}`,
          style: BODY_STYLE,
          headingLevel: null,
        },
      ],
    };
    expect(verifyBytes(writeWriterDocument(spec, "odt"), "odt", intent).status).toBe("refuted");
  });
});

// ---------------------------------------------------------------------------
// Round-1 verifier findings (TIF-99 PR #472): bounded reads and the ZIP/XML guards.
// ---------------------------------------------------------------------------

const CHILD = join(import.meta.dirname, "writer-hostile-child.ts");

interface ProbeResult {
  status: string;
  code: string;
  reason: string;
  ms: number;
  maxRssMb: number;
}

/**
 * Verifies `bytes` in a fresh child process (heap capped at 512 MB) and returns the
 * verdict with the child's peak RSS. A plain `node --import tsx` child peaks near 55 MB;
 * before the round-2 fixes these fixtures peaked at 1.1 GB, 1.6 GB, 5.2 GB and an 8 GB
 * heap abort.
 */
function probe(bytes: Uint8Array, ext: WriterFormat, kind: WriterPostconditionKind): ProbeResult {
  const file = save(bytes, ext);
  const child = spawnSync(
    process.execPath,
    ["--max-old-space-size=512", "--import", "tsx", CHILD, file, HOSTILE_SEED, kind],
    { cwd: ROOT, encoding: "utf8", timeout: 30_000 },
  );
  expect(child.signal, `child killed: ${child.stderr.slice(-500)}`).toBeNull();
  expect(child.status, `child failed: ${child.stderr.slice(-500)}`).toBe(0);
  return JSON.parse(child.stdout.trim()) as ProbeResult;
}

/** Peak RSS a bounded read may reach in the child (node + tsx alone is about 55 MB). */
const RSS_BOUND_MB = 200;

function expectBoundedUncertain(r: ProbeResult, code: WriterReasonCode, reason: RegExp): void {
  expect(r).toMatchObject({ status: "uncertain", code });
  expect(r.reason).toMatch(reason);
  expect(r.maxRssMb).toBeLessThan(RSS_BOUND_MB);
  expect(r.ms).toBeLessThan(2_000);
}

function intentFor(kind: WriterPostconditionKind): TaskIntent {
  return writerIntentFor(writerTaskFor(HOSTILE_SEED, kind));
}

function withEntry(
  entries: ZipEntryInput[],
  name: string,
  data: (old: Uint8Array) => Uint8Array,
): ZipEntryInput[] {
  return entries.map((e) => (e.name === name ? { ...e, data: data(e.data) } : e));
}

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (b: Uint8Array): string => new TextDecoder().decode(b);

/** Text that deflates at roughly 3:1, `bytes` long: honest content, not a bomb. */
function honestPadding(bytes: number): string {
  let out = "";
  for (let i = 0; out.length < bytes; i++) out += `${(i * 2654435761) % 1000003} `;
  return out.slice(0, bytes);
}

describe("writer reader D1: ODF repeat expansion is bounded", () => {
  it.each([200, 20])(
    "repeat bomb with n=%i cells x 1024 columns x 1024 rows: fast, bounded memory, never verified",
    (n) => {
      const bytes = odtRepeatBomb(n);
      expect(bytes.length).toBeLessThan(2_000);
      expectBoundedUncertain(
        probe(bytes, "odt", "table-cell"),
        "read-unreadable",
        /a table expands to more than 50000 cells/,
      );
    },
    40_000,
  );

  function withTables(xml: string): Uint8Array {
    return writeZip(
      withEntry(hostileEntries("odt", "table-cell"), ODT_MAIN_PART, (d) =>
        enc(dec(d).replace("</office:text>", `${xml}</office:text>`)),
      ),
    );
  }
  const table = (rows: number, cols: number): string =>
    `<table:table><table:table-row table:number-rows-repeated="${rows}"><table:table-cell table:number-columns-repeated="${cols}"/></table:table-row></table:table>`;

  it("one table over the per-table cell limit is refused before any cell is built", () => {
    const v = verifyBytes(withTables(table(60, 1000)), "odt", intentFor("table-cell"));
    expect(v).toMatchObject({ status: "uncertain", code: "read-unreadable" });
    expect(v.reasons[0]).toMatch(/a table expands to more than 50000 cells/);
  });

  it("tables each under the table limit but over the document limit together are refused", () => {
    const v = verifyBytes(withTables(table(49, 1000).repeat(5)), "odt", intentFor("table-cell"));
    expect(v).toMatchObject({ status: "uncertain", code: "read-unreadable" });
    expect(v.reasons[0]).toMatch(/document's tables expand to more than 200000 cells/);
  });

  it("text:s spaces past the document limit are refused", () => {
    const xml = `<text:p>${'<text:s text:c="1024"/>'.repeat(1000)}</text:p>`;
    const v = verifyBytes(withTables(xml), "odt", intentFor("table-cell"));
    expect(v).toMatchObject({ status: "uncertain", code: "read-unreadable" });
    expect(v.reasons[0]).toMatch(/text:s expands to more than 1000000 spaces/);
  });

  it("a large but legal repeated table still reads, sharing its repeated rows", () => {
    const bytes = withTables(table(1024, 40));
    expect(verifyBytes(bytes, "odt", intentFor("table-cell")).status).toBe("verified");
    const bomb = parseWriterDocument(bytes, "x.odt").blocks.at(-1);
    expect(bomb?.kind).toBe("table");
    if (bomb?.kind !== "table") return;
    expect(bomb.rows).toHaveLength(1024);
    expect(bomb.rows[0]).toHaveLength(40);
    expect(bomb.rows[1023]).toBe(bomb.rows[0]);
  });
});

describe("writer reader D2: ZIP decompression is bounded", () => {
  it.each([
    ["docx", 8],
    ["odt", 8],
    ["docx", 1],
  ] as const)(
    "%s with %i extra 512 MiB entries of zeros: refused as a bomb, bounded memory and time",
    (format, count) => {
      const bytes = zipBomb(format, count);
      expect(bytes.length).toBeLessThan(5_000_000);
      expectBoundedUncertain(
        probe(bytes, format, "table-cell"),
        "read-unreadable",
        /declares 536870912 bytes .* a decompression bomb/,
      );
    },
    40_000,
  );

  it("a used part whose header understates its size never inflates past the declared size", () => {
    // The main part's real stream is 512 MiB of zeros; its headers declare 1000 bytes,
    // so the ratio check passes and only maxOutputLength stops the inflate.
    const zeros = deflatedZeros(512);
    const entries = withEntry(hostileEntries("docx", "table-cell"), DOCX_MAIN_PART, (d) => d).map(
      (e) => (e.name === DOCX_MAIN_PART ? { ...e, deflated: { ...zeros, crc: 0, size: 1000 } } : e),
    );
    expectBoundedUncertain(
      probe(writeZip(entries), "docx", "table-cell"),
      "read-corrupt",
      /does not inflate to its declared 1000 bytes/,
    );
  }, 40_000);

  it("a used part declaring more than the part limit is refused without inflating it", () => {
    // 20 MiB declared from 400 KB of noise: under the bomb ratio, over the 16 MiB part limit.
    const noise = new Uint8Array(400_000).map((_, i) => (i * 7919) % 251);
    const entries = hostileEntries("docx", "table-cell").map((e) =>
      e.name === DOCX_MAIN_PART
        ? { ...e, deflated: { body: noise, crc: 0, size: 20 * 1024 * 1024 } }
        : e,
    );
    const v = verifyBytes(writeZip(entries), "docx", intentFor("table-cell"));
    expect(v).toMatchObject({ status: "uncertain", code: "read-unreadable" });
    expect(v.reasons[0]).toMatch(/over the 16777216-byte part limit/);
  });

  it("parts that are each legal but together exceed the total inflate limit are refused", () => {
    const pad = `<!--${honestPadding(12 * 1024 * 1024)}-->`;
    const padded = (d: Uint8Array): Uint8Array => enc(dec(d).replace("?>", `?>${pad}`));
    let entries = hostileEntries("docx", "table-cell");
    for (const name of [DOCX_MAIN_PART, "word/_rels/document.xml.rels", "word/styles.xml"])
      entries = withEntry(entries, name, padded);
    const v = verifyBytes(writeZip(entries), "docx", intentFor("table-cell"));
    expect(v).toMatchObject({ status: "uncertain", code: "read-unreadable" });
    expect(v.reasons[0]).toMatch(/would inflate over 33554432 bytes in total/);
  });

  it.each(FORMATS)(
    "%s: an entry the reader never uses is not inflated (a bad CRC there is ignored)",
    (format) => {
      const entries: ZipEntryInput[] = [
        ...hostileEntries(format, "table-cell"),
        {
          name: "Thumbnails/unused.bin",
          data: enc("x"),
          deflated: { body: enc("junk"), crc: 1, size: 9 },
        },
      ];
      expect(verifyBytes(writeZip(entries), format, intentFor("table-cell")).status).toBe(
        "verified",
      );
    },
  );
});

/** Rewrites every structure with signature `sig` in a ZIP image. */
function patchZip(
  bytes: Uint8Array,
  sig: number,
  fn: (buf: Buffer, at: number) => void,
): Uint8Array {
  const buf = Buffer.from(bytes);
  for (let i = 0; i + 4 <= buf.length; i++) if (buf.readUInt32LE(i) === sig) fn(buf, i);
  return new Uint8Array(buf);
}

describe("writer reader: ZIP and XML guards (round-1 surviving mutants)", () => {
  const intent = intentFor("table-cell");
  const good = (format: WriterFormat): Uint8Array => writeZip(hostileEntries(format, "table-cell"));

  it("the unpatched archives verify, so each refusal below is the guard's", () => {
    for (const f of FORMATS) expect(verifyBytes(good(f), f, intent).status).toBe("verified");
  });

  it.each(FORMATS)("C: a duplicate main part is corrupt in either order (%s)", (format) => {
    const main = format === "docx" ? DOCX_MAIN_PART : ODT_MAIN_PART;
    const edited = hostileEntries(format, "table-cell");
    const params = writerTaskFor(HOSTILE_SEED, "table-cell");
    const pristine = (format === "docx" ? docxEntries : odtEntries)(
      writerFixture(params.fixtureSeed),
    ).find((e) => e.name === main) as ZipEntryInput;
    const editedMain = edited.find((e) => e.name === main) as ZipEntryInput;
    for (const order of [
      [pristine, editedMain],
      [editedMain, pristine],
    ]) {
      const entries = [...edited.filter((e) => e.name !== main), ...order];
      const v = verifyBytes(writeZip(entries), format, intent);
      expect(v).toMatchObject({ status: "uncertain", code: "read-corrupt" });
      expect(v.reasons[0]).toMatch(/duplicate ZIP entry/);
    }
  });

  it.each(FORMATS)(
    "B: a local header that names another entry than the directory is corrupt (%s)",
    (format) => {
      const bytes = Buffer.from(good(format));
      bytes[30] = "{".charCodeAt(0); // first local header's first name byte
      const v = verifyBytes(new Uint8Array(bytes), format, intent);
      expect(v).toMatchObject({ status: "uncertain", code: "read-corrupt" });
      expect(v.reasons[0]).toMatch(/local header names/);
    },
  );

  it.each(FORMATS)("D: an entry flagged encrypted is unreadable (%s)", (format) => {
    const bytes = patchZip(good(format), 0x02014b50, (b, at) =>
      b.writeUInt16LE(b.readUInt16LE(at + 8) | 1, at + 8),
    );
    const v = verifyBytes(bytes, format, intent);
    expect(v).toMatchObject({ status: "uncertain", code: "read-unreadable" });
    expect(v.reasons[0]).toMatch(/is encrypted/);
  });

  it.each(FORMATS)(
    "E: a ZIP64 end record (0xffff entries or 0xffffffff offset) is unreadable (%s)",
    (format) => {
      const count = patchZip(good(format), 0x06054b50, (b, at) => {
        b.writeUInt16LE(0xffff, at + 8);
        b.writeUInt16LE(0xffff, at + 10);
      });
      const offset = patchZip(good(format), 0x06054b50, (b, at) =>
        b.writeUInt32LE(0xffffffff, at + 16),
      );
      for (const bytes of [count, offset]) {
        const v = verifyBytes(bytes, format, intent);
        expect(v).toMatchObject({ status: "uncertain", code: "read-unreadable" });
        expect(v.reasons[0]).toMatch(/ZIP64/);
      }
    },
  );

  it.each(FORMATS)(
    "A: bytes between the central directory and the end record are corrupt (%s)",
    (format) => {
      const bytes = good(format);
      const eocd = bytes.length - 22;
      const spliced = Buffer.concat([
        bytes.subarray(0, eocd),
        Buffer.from("JUNK"),
        bytes.subarray(eocd),
      ]);
      const v = verifyBytes(new Uint8Array(spliced), format, intent);
      expect(v).toMatchObject({ status: "uncertain", code: "read-corrupt" });
      expect(v.reasons[0]).toMatch(/does not end at the end record/);
    },
  );

  it.each(FORMATS)("J: a main part that is not valid UTF-8 is corrupt (%s)", (format) => {
    const main = format === "docx" ? DOCX_MAIN_PART : ODT_MAIN_PART;
    const entries = withEntry(hostileEntries(format, "table-cell"), main, (d) =>
      Buffer.concat([d, Buffer.from([0x3c, 0x21, 0x2d, 0x2d, 0xff, 0x2d, 0x2d, 0x3e])]),
    );
    const v = verifyBytes(writeZip(entries), format, intent);
    expect(v).toMatchObject({ status: "uncertain", code: "read-corrupt" });
    expect(v.reasons[0]).toMatch(/not valid UTF-8/);
  });

  it("K: an External relationship is never taken as the styles part", () => {
    const styleIntent = intentFor("paragraph-style");
    const entries = withEntry(
      hostileEntries("docx", "paragraph-style"),
      "word/_rels/document.xml.rels",
      (d) =>
        enc(
          dec(d).replace(
            "<Relationship ",
            '<Relationship Id="rX" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="https://example.invalid/evil.xml" TargetMode="External"/><Relationship ',
          ),
        ),
    );
    expect(verifyBytes(writeZip(entries), "docx", styleIntent).status).toBe("verified");
  });

  it("F: a DOCTYPE with an internal subset is refused for that reason", () => {
    expect(() => parseXml('<!DOCTYPE r [<!ENTITY a "b">]><r/>')).toThrow(/internal subsets/);
  });

  it("N4: nesting past MAX_XML_DEPTH is a syntax error, and a deep main part is read-corrupt", () => {
    expect(() => parseXml(`${"<a>".repeat(300)}${"</a>".repeat(300)}`)).toThrow(
      /nested deeper than 256/,
    );
    expect(() => parseXml(`${"<a>".repeat(200)}${"</a>".repeat(200)}`)).not.toThrow();
    const deep = withEntry(hostileEntries("docx", "table-cell"), DOCX_MAIN_PART, (d) =>
      enc(
        dec(d).replace(
          "<w:body>",
          `<w:body><w:p>${"<w:r>".repeat(200_000)}${"</w:r>".repeat(200_000)}</w:p>`,
        ),
      ),
    );
    const v = verifyBytes(writeZip(deep), "docx", intent);
    expect(v).toMatchObject({ status: "uncertain", code: "read-corrupt" });
    expect(v.reasons[0]).toMatch(/nested deeper/);
  });
});

describe("writer reader: package and table details (round-1 nits)", () => {
  const intent = intentFor("table-cell");
  const CT = "[Content_Types].xml";

  it("N1: a garbled [Content_Types].xml is corrupt", () => {
    const entries = withEntry(hostileEntries("docx", "table-cell"), CT, () => enc("not xml <"));
    expect(verifyBytes(writeZip(entries), "docx", intent)).toMatchObject({
      status: "uncertain",
      code: "read-corrupt",
    });
  });

  it("N1: a main part declared as another content type is unreadable", () => {
    const entries = withEntry(hostileEntries("docx", "table-cell"), CT, (d) =>
      enc(dec(d).replace("wordprocessingml.document.main+xml", "spreadsheetml.sheet.main+xml")),
    );
    const v = verifyBytes(writeZip(entries), "docx", intent);
    expect(v).toMatchObject({ status: "uncertain", code: "read-unreadable" });
    expect(v.reasons[0]).toMatch(/not a WordprocessingML document/);
  });

  it("N1: the main part's type may come from the Default for its extension", () => {
    const entries = withEntry(hostileEntries("docx", "table-cell"), CT, (d) =>
      enc(
        dec(d)
          .replace(/<Override PartName="\/word\/document.xml"[^>]*\/>/, "")
          .replace(
            '<Default Extension="xml" ContentType="application/xml"/>',
            '<Default Extension="xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>',
          ),
      ),
    );
    expect(verifyBytes(writeZip(entries), "docx", intent).status).toBe("verified");
  });

  it.each([
    [
      "w:gridBefore",
      (xml: string) => xml.replace("<w:tr>", '<w:tr><w:trPr><w:gridBefore w:val="1"/></w:trPr>'),
    ],
    [
      "w:gridAfter",
      (xml: string) => xml.replace("<w:tr>", '<w:tr><w:trPr><w:gridAfter w:val="1"/></w:trPr>'),
    ],
    ["w:hMerge", (xml: string) => xml.replace("<w:tcPr>", '<w:tcPr><w:hMerge w:val="continue"/>')],
  ])("N3: %s shifts or merges cell names, so a table-cell check is uncertain", (_, edit) => {
    const bytes = mutateEntries(hostileEntries("docx", "table-cell"), DOCX_MAIN_PART, edit);
    expect(verifyBytes(bytes, "docx", intent)).toMatchObject({
      status: "uncertain",
      code: "merged-cell",
    });
  });

  it("M: a paragraph-text task whose newText duplicates another fixture paragraph has no ground truth", () => {
    const params = writerTaskFor("w-001", "paragraph-text");
    if (params.kind !== "paragraph-text") throw new Error("unexpected kind");
    const other = writerFixture(params.fixtureSeed).blocks.filter((b) => b.kind === "paragraph")[
      params.paragraph === 0 ? 1 : 0
    ];
    if (other?.kind !== "paragraph") throw new Error("fixture has one paragraph");
    expect(() => groundTruth({ ...params, newText: other.text })).toThrow(
      /duplicates another fixture paragraph/,
    );
  });
});
