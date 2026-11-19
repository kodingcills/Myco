import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { Action, ActResult, AdapterCapabilities, AppAdapter } from "../core/adapter.ts";
import { AppCrashedError, StaleRefError } from "../core/adapter.ts";
import { cellRef } from "../core/filepersist.ts";
import type { AppState, StateNode } from "../core/state.ts";

export interface FakeAppOptions {
  filePath: string;
  rows?: number;
  cols?: number;
}

export class FakeSpreadsheetApp implements AppAdapter {
  #cells: Record<string, string> = {};
  #stateVersion = 0;
  #alive = true;
  #saveDelayMs = 0;
  #saveQueued = false;
  #filePath: string;
  #focusedNodeId: string | null = null;
  #dirty = false;
  readonly #rows: number;
  readonly #cols: number;

  constructor(options: FakeAppOptions) {
    this.#filePath = options.filePath;
    this.#rows = options.rows ?? 8;
    this.#cols = options.cols ?? 4;
    if (existsSync(options.filePath)) {
      this.#loadFromDisk();
    }
    this.#bump();
  }

  capabilities(): AdapterCapabilities {
    return { ids: ["fake-grid-v1"] };
  }

  observe(): Promise<AppState> {
    if (!this.#alive) {
      return Promise.reject(new AppCrashedError("app crashed; cannot observe"));
    }
    return Promise.resolve(this.#snapshot());
  }

  act(action: Action): Promise<ActResult> {
    if (!this.#alive) {
      return Promise.reject(new AppCrashedError("app crashed; cannot act"));
    }
    try {
      switch (action.kind) {
        case "click": {
          this.#requireRef(action.ref);
          this.#focusedNodeId = action.ref;
          this.#bump();
          break;
        }
        case "typeText": {
          this.#requireRef(action.ref);
          this.#focusedNodeId = action.ref;
          this.#setCellValue(action.ref, action.text);
          break;
        }
        case "setValue": {
          this.#requireRef(action.ref);
          this.#setCellValue(action.ref, action.value);
          break;
        }
        case "keyPress": {
          if (action.keys === "ctrl+s") {
            this.#dirty = false;
            this.#bump();
            this.#flushSave();
          } else {
            this.#bump();
          }
          break;
        }
        case "waitFor":
          break;
        default:
          throw new Error("unknown action");
      }
    } catch (error) {
      return Promise.reject(error);
    }
    return Promise.resolve({ dispatched: true, stateVersionAfter: this.#stateVersion });
  }

  #setCellValue(ref: string, value: string): void {
    if (this.#parseCellRef(ref)) {
      this.#cells[ref] = value;
      this.#dirty = true;
      this.#bump();
    } else {
      this.#bump();
    }
  }

  #requireRef(ref: string): void {
    const match = this.#parseCellRef(ref);
    if (match) {
      const { row, col } = match;
      if (row >= this.#rows || col >= this.#cols) {
        throw new StaleRefError(ref, this.#stateVersion, this.#stateVersion);
      }
      return;
    }
    if (ref.startsWith("btn:") && (ref === "btn:save" || ref === "btn:cell-A1")) return;
    throw new StaleRefError(ref, this.#stateVersion, this.#stateVersion);
  }

  #parseCellRef(ref: string): { row: number; col: number } | null {
    const m = /^([A-Z]+)([0-9]+)$/.exec(ref);
    if (!m) return null;
    const letters = m[1] as string;
    const digits = m[2] as string;
    let col = 0;
    for (const ch of letters) {
      col = col * 26 + (ch.charCodeAt(0) - 64);
    }
    col -= 1;
    const row = Number.parseInt(digits, 10) - 1;
    return { row, col };
  }

  #snapshot(): AppState {
    const nodes: StateNode[] = [];
    for (let r = 0; r < this.#rows; r++) {
      for (let c = 0; c < this.#cols; c++) {
        const id = cellRef(r, c);
        nodes.push({
          id,
          role: "cell",
          name: id,
          value: this.#cells[id] ?? "",
          bounds: { x: c * 100, y: r * 30, width: 100, height: 30 },
          enabled: true,
          visible: true,
        });
      }
    }
    nodes.push({
      id: "btn:save",
      role: "button",
      name: "Save",
      value: "",
      bounds: { x: 0, y: this.#rows * 30 + 10, width: 80, height: 24 },
      enabled: true,
      visible: true,
    });
    return {
      stateVersion: this.#stateVersion,
      capturedAt: new Date().toISOString(),
      facts: {
        documentPath: this.#filePath,
        dirty: this.#dirty,
        focusedNodeId: this.#focusedNodeId,
      },
      nodes,
    };
  }

  #bump(): void {
    this.#stateVersion += 1;
  }

  #flushSave(): void {
    const write = () => {
      if (!this.#alive) {
        this.#saveQueued = false;
        return;
      }
      this.#persistToDisk();
      this.#saveQueued = false;
    };
    if (this.#saveDelayMs > 0) {
      this.#saveQueued = true;
      setTimeout(write, this.#saveDelayMs);
    } else {
      write();
    }
  }

  #persistToDisk(): void {
    const lines: string[] = [];
    for (let r = 0; r < this.#rows; r++) {
      const row: string[] = [];
      for (let c = 0; c < this.#cols; c++) row.push(this.#cells[cellRef(r, c)] ?? "");
      lines.push(row.join(","));
    }
    writeFileSync(this.#filePath, `${lines.join("\n")}\n`);
  }

  #loadFromDisk(): void {
    const content = readFileSync(this.#filePath, "utf8");
    const lines = content.split(/\r?\n/).filter((l) => l !== "");
    this.#cells = {};
    for (let r = 0; r < lines.length; r++) {
      const cols = (lines[r] ?? "").split(",");
      for (let c = 0; c < cols.length; c++) {
        const v = cols[c];
        if (v) this.#cells[cellRef(r, c)] = v;
      }
    }
  }

  crash(): void {
    this.#alive = false;
  }

  stealFocus(): void {
    this.#focusedNodeId = "system:notification";
    this.#bump();
  }

  setSaveDelay(ms: number): void {
    this.#saveDelayMs = ms;
  }

  isSavePending(): boolean {
    return this.#saveQueued;
  }
}
