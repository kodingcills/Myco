import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { Action, ActResult, AdapterCapabilities, AppAdapter } from "../core/adapter.ts";
import { AppCrashedError, StaleRefError, UnknownRefError } from "../core/adapter.ts";
import { cellRef } from "../core/filepersist.ts";
import type { AppState, StateNode } from "../core/state.ts";

export interface FakeAppOptions {
  filePath: string;
  rows?: number;
  cols?: number;
}

const SAVE_BUTTON_ID = "btn:save";

export class FakeSpreadsheetApp implements AppAdapter {
  #cells: Record<string, string> = {};
  #stateVersion = 0;
  #alive = true;
  #saveDelayMs = 0;
  #saveQueued = false;
  #filePath: string;
  #focusedNodeId: string | null = null;
  #dirty = false;
  #saveDropped = false;
  readonly #rows: number;
  readonly #cols: number;
  #refTable = new Map<string, { nodeId: string; refVersion: number }>();

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

  issueRef(nodeId: string): string | null {
    if (!this.#liveNodeIds().includes(nodeId)) return null;
    const boundVersion = this.#nextRefStale ? this.#stateVersion - 1 : this.#stateVersion;
    this.#nextRefStale = false;
    const ref = `ref:${boundVersion}:${nodeId}`;
    this.#refTable.set(ref, { nodeId, refVersion: boundVersion });
    return ref;
  }

  act(action: Action): Promise<ActResult> {
    if (!this.#alive) {
      return Promise.reject(new AppCrashedError("app crashed; cannot act"));
    }
    try {
      switch (action.kind) {
        case "click": {
          const nodeId = this.#resolveRef(action.ref);
          this.#focusedNodeId = nodeId;
          this.#bump();
          return Promise.resolve({
            outcome: "delivered_verified",
            details: `clicked ${nodeId}`,
            stateVersionAfter: this.#stateVersion,
          });
        }
        case "typeText": {
          const nodeId = this.#resolveRef(action.ref);
          this.#focusedNodeId = nodeId;
          this.#setCellValue(nodeId, action.text);
          return Promise.resolve({
            outcome: "delivered_verified",
            details: `typed ${action.text} into ${nodeId}`,
            stateVersionAfter: this.#stateVersion,
          });
        }
        case "setValue": {
          const nodeId = this.#resolveRef(action.ref);
          this.#setCellValue(nodeId, action.value);
          return Promise.resolve({
            outcome: "delivered_verified",
            details: `set ${nodeId} to ${action.value}`,
            stateVersionAfter: this.#stateVersion,
          });
        }
        case "keyPress": {
          if (action.keys === "ctrl+s") {
            this.#dirty = false;
            this.#bump();
            this.#flushSave();
            return Promise.resolve({
              outcome: "delivered_verified",
              details: `pressed ctrl+s; saved to ${this.#filePath}`,
              stateVersionAfter: this.#stateVersion,
            });
          }
          this.#bump();
          return Promise.resolve({
            outcome: "delivered_unverified",
            details: `pressed ${action.keys}`,
            stateVersionAfter: this.#stateVersion,
          });
        }
        case "waitFor":
          return Promise.resolve({
            outcome: "delivered_unverified",
            details: "waitFor dispatched; predicate checked by runner",
            stateVersionAfter: this.#stateVersion,
          });
        default:
          return Promise.resolve({
            outcome: "failed",
            details: `unknown action kind ${String((action as { kind: unknown }).kind)}`,
          });
      }
    } catch (error) {
      return Promise.reject(error);
    }
  }

  crash(): void {
    this.#alive = false;
  }

  get alive(): boolean {
    return this.#alive;
  }

  dropSave(): void {
    this.#saveDropped = true;
  }

  setSaveDelay(ms: number): void {
    this.#saveDelayMs = ms;
  }

  isSavePending(): boolean {
    return this.#saveQueued;
  }
  stealFocus(target?: string): void {
    this.#focusedNodeId = target ?? "system:notification";
    this.#bump();
  }

  #nextRefStale = false;

  /** Test seam: the next issued ref is bound to a superseded stateVersion. */
  markNextRefStale(): void {
    this.#nextRefStale = true;
  }

  #liveNodeIds(): string[] {
    const ids: string[] = [];
    for (let r = 0; r < this.#rows; r++) {
      for (let c = 0; c < this.#cols; c++) {
        ids.push(cellRef(r, c));
      }
    }
    ids.push(SAVE_BUTTON_ID);
    return ids;
  }

  #resolveRef(ref: string): string {
    const entry = this.#refTable.get(ref);
    if (!entry) {
      throw new UnknownRefError(ref);
    }
    if (entry.refVersion !== this.#stateVersion) {
      throw new StaleRefError(ref, entry.refVersion, this.#stateVersion);
    }
    return entry.nodeId;
  }

  #setCellValue(nodeId: string, value: string): void {
    this.#cells[nodeId] = value;
    this.#dirty = true;
    this.#bump();
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
      id: SAVE_BUTTON_ID,
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
    if (this.#saveDropped) {
      this.#saveQueued = false;
      return;
    }
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
}
