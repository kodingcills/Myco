/**
 * Benchmark site (workstream 3, track G): a small Markdown-to-HTML renderer for the public
 * package pages (`docs/benchmark/public/*.md`). No dependency: the pages use a known subset
 * (ATX headings, paragraphs, nested bullet and numbered lists, pipe tables, fenced code,
 * inline code, bold, italic, links), and everything else renders as escaped text.
 *
 * Every piece of source text is HTML-escaped before any markup is added, so a page cannot
 * inject markup or script. Links go through `resolveLink`: a link it does not map renders as
 * its text alone, so the site never carries a link to a repository path it does not publish.
 */

export type LinkResolver = (href: string) => string | null;

export const escapeHtml = (text: string): string =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

/** A heading's anchor id: lowercase words joined by `-`. */
export const slug = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[`*_]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

const emphasis = (escaped: string) =>
  escaped
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?![*\w])/g, "$1<em>$2</em>");

/**
 * Inline markup over one line. Code spans are taken out first (their content stays literal),
 * then links (their label may hold code), then the rest is escaped and emphasis applied. The
 * pieces taken out are held as tokens delimited by U+E000, a private-use character removed from the source first.
 */
export function inline(text: string, resolveLink: LinkResolver): string {
  const held: string[] = [];
  const hold = (html: string) => `\uE000${held.push(html) - 1}\uE000`;
  let s = text.replaceAll("\uE000", "");
  s = s.replace(/`([^`]*)`/g, (_m, code: string) => hold(`<code>${escapeHtml(code)}</code>`));
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label: string, href: string) => {
    const l = emphasis(escapeHtml(label));
    const to = resolveLink(href);
    return hold(to === null ? l : `<a href="${escapeHtml(to)}">${l}</a>`);
  });
  s = emphasis(escapeHtml(s));
  const TOKEN = /\uE000(\d+)\uE000/g;
  while (TOKEN.test(s)) s = s.replace(TOKEN, (_m, n: string) => held[Number(n)] ?? "");
  return s;
}

const LIST_ITEM = /^( *)([-*]|\d+\.) +(.*)$/;
const TABLE_SEP = /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;

interface ListNode {
  readonly indent: number;
  readonly ordered: boolean;
  readonly items: { text: string; children: ListNode[] }[];
}

function renderList(node: ListNode, resolveLink: LinkResolver): string {
  const tag = node.ordered ? "ol" : "ul";
  const items = node.items
    .map(
      (it) =>
        `<li>${inline(it.text, resolveLink)}${it.children.map((c) => renderList(c, resolveLink)).join("")}</li>`,
    )
    .join("");
  return `<${tag}>${items}</${tag}>`;
}

const cells = (row: string): string[] =>
  row
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());

/** Render a Markdown document. Headings carry `id`s from `slug`. */
export function renderMarkdown(source: string, resolveLink: LinkResolver): string {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (line.trim() === "") {
      i++;
      continue;
    }
    const fence = /^ *```/.test(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^ *```/.test(lines[i] ?? "")) body.push(lines[i++] ?? "");
      i++;
      out.push(`<pre><code>${escapeHtml(body.join("\n"))}</code></pre>`);
      continue;
    }
    const heading = /^(#{1,6}) +(.*)$/.exec(line);
    if (heading) {
      const level = heading[1]?.length ?? 1;
      const text = heading[2] ?? "";
      out.push(`<h${level} id="${slug(text)}">${inline(text, resolveLink)}</h${level}>`);
      i++;
      continue;
    }
    if (line.trimStart().startsWith("|") && TABLE_SEP.test(lines[i + 1] ?? "")) {
      const head = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && (lines[i] ?? "").trimStart().startsWith("|"))
        rows.push(cells(lines[i++] ?? ""));
      const th = head.map((c) => `<th>${inline(c, resolveLink)}</th>`).join("");
      const tb = rows
        .map((r) => `<tr>${r.map((c) => `<td>${inline(c, resolveLink)}</td>`).join("")}</tr>`)
        .join("");
      out.push(`<table><thead><tr>${th}</tr></thead><tbody>${tb}</tbody></table>`);
      continue;
    }
    if (LIST_ITEM.test(line)) {
      const roots: ListNode[] = [];
      const stack: ListNode[] = [];
      while (i < lines.length) {
        const l = lines[i] ?? "";
        if (l.trim() === "") {
          // A blank line continues the list only when another item follows it.
          if (LIST_ITEM.test(lines[i + 1] ?? "")) {
            i++;
            continue;
          }
          break;
        }
        const m = LIST_ITEM.exec(l);
        if (m) {
          const indent = m[1]?.length ?? 0;
          const ordered = /\d/.test(m[2] ?? "");
          while (stack.length > 0 && (stack.at(-1)?.indent ?? 0) > indent) stack.pop();
          const top = stack.at(-1);
          const item = { text: m[3] ?? "", children: [] as ListNode[] };
          if (top === undefined || top.indent < indent) {
            const node: ListNode = { indent, ordered, items: [item] };
            const parent = top?.items.at(-1);
            if (parent === undefined) roots.push(node);
            else parent.children.push(node);
            stack.push(node);
          } else top.items.push(item);
        } else if (/^ +\S/.test(l) && stack.length > 0) {
          const last = stack.at(-1)?.items.at(-1);
          if (last !== undefined) last.text += ` ${l.trim()}`;
        } else break;
        i++;
      }
      for (const r of roots) out.push(renderList(r, resolveLink));
      continue;
    }
    const para: string[] = [];
    while (
      i < lines.length &&
      (lines[i] ?? "").trim() !== "" &&
      !/^(#{1,6}) |^ *```/.test(lines[i] ?? "") &&
      !LIST_ITEM.test(lines[i] ?? "") &&
      !((lines[i] ?? "").trimStart().startsWith("|") && TABLE_SEP.test(lines[i + 1] ?? ""))
    )
      para.push((lines[i++] ?? "").trim());
    out.push(`<p>${inline(para.join(" "), resolveLink)}</p>`);
  }
  return out.join("\n");
}
