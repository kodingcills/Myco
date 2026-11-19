import { readFileSync } from "node:fs";
import type { PersistedState } from "./verify.ts";

export function readCsvSpreadsheet(filePath: string): PersistedState {
  const content = readFileSync(filePath, "utf8");
  const cells: Record<string, string> = {};
  const lines = content.split(/\r?\n/).filter((line) => line !== "");
  for (let r = 0; r < lines.length; r++) {
    const line = lines[r];
    if (!line) continue;
    const columns = line.split(",");
    for (let c = 0; c < columns.length; c++) {
      const value = columns[c];
      if (value === undefined || value === "") continue;
      cells[cellRef(r, c)] = value;
    }
  }
  return { kind: "csv", filePath, cells };
}

export function cellRef(row: number, col: number): string {
  let colName = "";
  let c = col;
  do {
    colName = String.fromCharCode(65 + (c % 26)) + colName;
    c = Math.floor(c / 26) - 1;
  } while (c >= 0);
  return `${colName}${row + 1}`;
}
