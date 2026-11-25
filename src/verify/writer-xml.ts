/**
 * A small, strict XML reader for the host-only Writer oracle (TIF-99 / M2-08).
 *
 * Why a hand-written parser: the repo has no XML dependency, and the oracle needs the
 * opposite of a browser-style tolerant parser. A partially saved `content.xml` or
 * `word/document.xml` must fail to parse, so the oracle answers "could not look"
 * instead of reading a prefix of the document and refuting (or verifying) against it.
 * Any well-formedness error throws `XmlSyntaxError`.
 *
 * Scope: elements, attributes, character data, the five predefined entities and
 * numeric character references, CDATA, comments, processing instructions and a
 * DOCTYPE without an internal subset. Namespaces are kept as written prefixes
 * (`w:p`, `text:h`); both formats the oracle reads use fixed, conventional prefixes,
 * and the reader checks the namespace URI of the root before trusting them.
 */

export interface XmlElement {
  readonly name: string;
  readonly attrs: Readonly<Record<string, string>>;
  readonly children: readonly XmlNode[];
}

export type XmlNode = XmlElement | string;

export class XmlSyntaxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "XmlSyntaxError";
  }
}

const NAME = /[A-Za-z_:][-A-Za-z0-9_:.]*/y;
const SPACE = /[ \t\r\n]*/y;

function decodeEntities(raw: string, at: number): string {
  if (!raw.includes("&")) return raw;
  return raw.replace(/&([^;&]*);|&/g, (match, body: string | undefined) => {
    if (body === undefined) throw new XmlSyntaxError(`bare '&' near offset ${at}`);
    switch (body) {
      case "lt":
        return "<";
      case "gt":
        return ">";
      case "amp":
        return "&";
      case "quot":
        return '"';
      case "apos":
        return "'";
    }
    const numeric = /^#(?:x([0-9A-Fa-f]+)|([0-9]+))$/.exec(body);
    if (numeric === null) throw new XmlSyntaxError(`unknown entity ${match} near offset ${at}`);
    const code = numeric[1] !== undefined ? Number.parseInt(numeric[1], 16) : Number(numeric[2]);
    if (!Number.isFinite(code) || code < 1 || code > 0x10ffff) {
      throw new XmlSyntaxError(`invalid character reference ${match} near offset ${at}`);
    }
    return String.fromCodePoint(code);
  });
}

/** Parses a complete XML document and returns its root element. */
export function parseXml(source: string): XmlElement {
  let pos = 0;
  const text = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;

  const fail = (what: string): never => {
    throw new XmlSyntaxError(`${what} at offset ${pos}`);
  };
  const skipSpace = (): void => {
    SPACE.lastIndex = pos;
    SPACE.exec(text);
    pos = SPACE.lastIndex;
  };
  const readName = (): string => {
    NAME.lastIndex = pos;
    const m = NAME.exec(text);
    if (m === null) return fail("expected a name");
    pos = NAME.lastIndex;
    return m[0];
  };
  const skipUntil = (end: string, what: string): void => {
    const at = text.indexOf(end, pos);
    if (at < 0) fail(`unterminated ${what}`);
    pos = at + end.length;
  };
  /** Comments, PIs and whitespace allowed outside the root element. */
  const skipMisc = (allowDoctype: boolean): void => {
    for (;;) {
      skipSpace();
      if (text.startsWith("<?", pos)) skipUntil("?>", "processing instruction");
      else if (text.startsWith("<!--", pos)) skipUntil("-->", "comment");
      else if (allowDoctype && text.startsWith("<!DOCTYPE", pos)) {
        if (text.indexOf("[", pos) >= 0 && text.indexOf("[", pos) < text.indexOf(">", pos)) {
          fail("DOCTYPE internal subsets are not supported");
        }
        skipUntil(">", "DOCTYPE");
      } else return;
    }
  };

  const readElement = (): XmlElement => {
    if (text[pos] !== "<") fail("expected '<'");
    pos++;
    const name = readName();
    const attrs: Record<string, string> = {};
    for (;;) {
      const before = pos;
      skipSpace();
      if (text.startsWith("/>", pos)) {
        pos += 2;
        return { name, attrs, children: [] };
      }
      if (text[pos] === ">") {
        pos++;
        break;
      }
      if (pos === before) fail("expected whitespace before attribute");
      const attr = readName();
      skipSpace();
      if (text[pos] !== "=") fail(`expected '=' after attribute ${attr}`);
      pos++;
      skipSpace();
      const quote = text[pos];
      if (quote !== '"' && quote !== "'") return fail(`expected quoted value for ${attr}`);
      const end = text.indexOf(quote, pos + 1);
      if (end < 0) fail(`unterminated value for ${attr}`);
      const raw = text.slice(pos + 1, end);
      if (raw.includes("<")) fail(`'<' in value of ${attr}`);
      if (attr in attrs) fail(`duplicate attribute ${attr}`);
      attrs[attr] = decodeEntities(raw, pos);
      pos = end + 1;
    }
    const children: XmlNode[] = [];
    for (;;) {
      if (pos >= text.length) fail(`unclosed element <${name}>`);
      if (text.startsWith("</", pos)) {
        pos += 2;
        const closing = readName();
        if (closing !== name) fail(`</${closing}> closes <${name}>`);
        skipSpace();
        if (text[pos] !== ">") fail(`expected '>' after </${closing}`);
        pos++;
        return { name, attrs, children };
      }
      if (text.startsWith("<!--", pos)) {
        skipUntil("-->", "comment");
      } else if (text.startsWith("<![CDATA[", pos)) {
        const start = pos + 9;
        skipUntil("]]>", "CDATA section");
        children.push(text.slice(start, pos - 3));
      } else if (text.startsWith("<?", pos)) {
        skipUntil("?>", "processing instruction");
      } else if (text[pos] === "<") {
        children.push(readElement());
      } else {
        const next = text.indexOf("<", pos);
        const end = next < 0 ? text.length : next;
        const raw = text.slice(pos, end);
        if (raw.includes("]]>")) fail("']]>' in character data");
        children.push(decodeEntities(raw, pos));
        pos = end;
      }
    }
  };

  skipMisc(true);
  if (pos >= text.length) fail("no root element");
  const root = readElement();
  skipMisc(false);
  if (pos !== text.length) fail("content after the root element");
  return root;
}

/** Child elements, optionally filtered by name. */
export function childElements(el: XmlElement, name?: string): XmlElement[] {
  const out: XmlElement[] = [];
  for (const child of el.children) {
    if (typeof child !== "string" && (name === undefined || child.name === name)) out.push(child);
  }
  return out;
}

export function firstChild(el: XmlElement, name: string): XmlElement | undefined {
  return childElements(el, name)[0];
}
