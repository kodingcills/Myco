/**
 * Live watch view: render a mock-transport observation as an SVG frame, so the demo has a
 * desktop to show without a VM. Only the app's visible content is drawn (entry text, list
 * rows, status line; or grid cell values). Host facts an observation carries (for example
 * the fake spreadsheet's `documentPath`) are never read. Every string is XML-escaped and
 * clipped.
 */
import type { AppState } from "../core/state.ts";
import type { DesktopObservation } from "../discovery/live-runner.ts";

const MAX_TEXT = 60;

function esc(text: string): string {
  const clipped = text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text;
  return clipped
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function frame(width: number, height: number, title: string, body: string[]): string {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="sans-serif" font-size="13">`,
    `<rect width="${width}" height="${height}" fill="#2b2f36"/>`,
    `<rect x="10" y="10" width="${width - 20}" height="${height - 20}" rx="6" fill="#f4f5f7"/>`,
    `<rect x="10" y="10" width="${width - 20}" height="26" rx="6" fill="#3d4450"/>`,
    `<text x="22" y="28" fill="#fff" font-weight="bold">${esc(title)}</text>`,
    ...body,
    // Every rendered frame is a mock frame: it draws its own MOCK watermark (spec #589 §2.6).
    `<text x="${width / 2}" y="${height / 2}" text-anchor="middle" dominant-baseline="middle" transform="rotate(-30 ${width / 2} ${height / 2})" font-size="72" font-weight="900" fill="#f85149" fill-opacity="0.35">MOCK</text>`,
    `<rect x="0" y="${height - 18}" width="${width}" height="18" fill="#f85149" fill-opacity="0.85"/>`,
    `<text x="${width / 2}" y="${height - 5}" text-anchor="middle" font-size="12" font-weight="bold" fill="#fff">MOCK · NOT EVIDENCE</text>`,
    "</svg>",
    "",
  ].join("\n");
}

/** The mock todo app (`MockDesktop`) as a frame. */
export function todoFrameSvg(observation: DesktopObservation, step: number): string {
  const body: string[] = [
    `<rect x="26" y="50" width="300" height="26" fill="#fff" stroke="#9aa3b2"/>`,
    `<text x="32" y="68" fill="#1d2330">${esc(observation.entryText)}</text>`,
    `<rect x="336" y="50" width="70" height="26" rx="3" fill="#4c6ef5"/>`,
    `<text x="356" y="68" fill="#fff">Add</text>`,
  ];
  observation.listRows.slice(0, 8).forEach((row, i) => {
    const y = 96 + i * 24;
    body.push(`<text x="32" y="${y}" fill="#1d2330">• ${esc(row)}</text>`);
  });
  body.push(
    `<rect x="26" y="300" width="80" height="26" rx="3" fill="#2f9e44"/>`,
    `<text x="46" y="318" fill="#fff">Save</text>`,
    `<text x="120" y="318" fill="#5b6475">${esc(observation.statusText)}</text>`,
    `<text x="330" y="346" fill="#9aa3b2" font-size="11">mock · step ${step}</text>`,
  );
  return frame(440, 360, "myco-todo (mock transport)", body);
}

/** The fake spreadsheet (`FakeSpreadsheetApp`) as a frame: the first rows of its grid. */
export function gridFrameSvg(state: AppState, step: number, maxRows = 8): string {
  const cells = state.nodes.filter((node) => node.role === "cell");
  const byId = new Map(cells.map((node) => [node.id, node.value]));
  const cols: string[] = [];
  for (const node of cells) {
    const col = /^([A-Z]+)1$/.exec(node.id)?.[1];
    if (col !== undefined) cols.push(col);
  }
  const colW = 108;
  const width = Math.max(440, 64 + cols.length * colW);
  const body: string[] = [];
  for (let r = 1; r <= maxRows; r++) {
    const y = 50 + (r - 1) * 26;
    body.push(`<text x="18" y="${y + 17}" fill="#9aa3b2" font-size="11">${r}</text>`);
    cols.forEach((col, c) => {
      const x = 34 + c * colW;
      const fill = r === 1 ? "#e3e7ee" : "#fff";
      body.push(
        `<rect x="${x}" y="${y}" width="${colW}" height="26" fill="${fill}" stroke="#c9ced8"/>`,
        `<text x="${x + 4}" y="${y + 17}" fill="#1d2330" font-size="11">${esc((byId.get(`${col}${r}`) ?? "").slice(0, 16))}</text>`,
      );
    });
  }
  const height = 50 + maxRows * 26 + 40;
  body.push(
    `<text x="${width - 110}" y="${height - 16}" fill="#9aa3b2" font-size="11">mock · step ${step}</text>`,
  );
  return frame(width, height, "Calc sheet (mock transport)", body);
}
