import { readFileSync } from "node:fs";
import type { PersistedState } from "./verify.ts";

export class PersistedStateReadError extends Error {
  readonly filePath: string;
  readonly cause: "missing" | "unreadable" | "corrupt";

  constructor(filePath: string, cause: "missing" | "unreadable" | "corrupt", message: string) {
    super(message);
    this.name = "PersistedStateReadError";
    this.filePath = filePath;
    this.cause = cause;
  }
}

export function readCsvSpreadsheet(filePath: string): PersistedState {
  let content: string;
  try {
    content = readFileSync(filePath, "utf8");
  } catch {
    throw new PersistedStateReadError(
      filePath,
      "missing",
      `cannot read ${filePath}: file missing or unreadable`,
    );
  }
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
