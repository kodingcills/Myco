/**
 * Plain-text report reader for the independent grader (capability track P, cross-app).
 *
 * Reads the bytes Writer's text filter saved. Written separately from the gate's report
 * reader (`src/gate/cross-app.ts`) and sharing no code with it
 * (`test/benchmark/independence.test.ts`). Refusals throw ReportReadError, which the grader
 * turns into `ungradable` (could not look), never a pass:
 *  - not UTF-8 (fatal decode);
 *  - a NUL or other C0 control byte (TAB allowed), or DEL;
 *  - a CR not followed by LF;
 *  - more than MAX_REPORT_LINES lines, or a line over MAX_REPORT_LINE chars.
 * Normalisation: one leading U+FEFF dropped, LF / CRLF line ends, trailing blanks of each
 * line dropped, trailing empty lines dropped.
 */

export class ReportReadError extends Error {
  override name = "ReportReadError";
}

export const MAX_REPORT_LINES = 10_000;
export const MAX_REPORT_LINE = 10_000;

export function readReportLines(bytes: Uint8Array): string[] {
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i] as number;
    if (b === 0x0d && bytes[i + 1] !== 0x0a) throw new ReportReadError("bare carriage return");
    if ((b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d) || b === 0x7f)
      throw new ReportReadError(`control byte 0x${b.toString(16).padStart(2, "0")} at ${i}`);
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new ReportReadError("not valid UTF-8");
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (text.indexOf("\ufeff") !== -1) throw new ReportReadError("byte-order mark inside the text");
  const out: string[] = [];
  let start = 0;
  while (start <= text.length) {
    let end = text.indexOf("\n", start);
    if (end === -1) end = text.length;
    let line = text.slice(start, end);
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (line.length > MAX_REPORT_LINE) throw new ReportReadError("line too long");
    let cut = line.length;
    while (cut > 0 && (line[cut - 1] === " " || line[cut - 1] === "\t")) cut--;
    out.push(line.slice(0, cut));
    if (out.length > MAX_REPORT_LINES + 1) throw new ReportReadError("too many lines");
    start = end + 1;
  }
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  return out;
}

/**
 * The value of a field line `<label>: <value>` (blanks after the colon skipped), or null when
 * the line is not that field.
 */
export function fieldOf(line: string | undefined, label: string): string | null {
  if (line === undefined) return null;
  const head = `${label}:`;
  if (line.slice(0, head.length) !== head) return null;
  let i = head.length;
  while (line[i] === " " || line[i] === "\t") i++;
  return line.slice(i);
}
