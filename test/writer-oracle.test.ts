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
