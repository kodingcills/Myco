import type { AppState } from "./state.ts";

export class StaleRefError extends Error {
  readonly ref: string;
  readonly refVersion: number;
  readonly currentVersion: number;

  constructor(ref: string, refVersion: number, currentVersion: number) {
    super(`stale ref ${ref}: issued for stateVersion ${refVersion}, app is at ${currentVersion}`);
    this.name = "StaleRefError";
    this.ref = ref;
    this.refVersion = refVersion;
    this.currentVersion = currentVersion;
  }
}

export class AppCrashedError extends Error {
  constructor(message = "app crashed") {
    super(message);
    this.name = "AppCrashedError";
  }
}

export type Action =
  | { kind: "click"; ref: string }
  | { kind: "typeText"; ref: string; text: string }
  | { kind: "setValue"; ref: string; value: string }
  | { kind: "keyPress"; keys: string }
  | { kind: "waitFor"; predicate: (state: AppState) => boolean; timeoutMs: number };

export type ActionInput = Action;

export interface ActResult {
  dispatched: true;
  stateVersionAfter: number;
}

export interface AdapterCapabilities {
  readonly ids: readonly string[];
}

export interface AppAdapter {
  observe(): Promise<AppState>;
  act(action: ActionInput): Promise<ActResult>;
  capabilities(): AdapterCapabilities;
}
