import type { AppState } from "./state.ts";

export class UnknownRefError extends Error {
  readonly ref: string;

  constructor(ref: string) {
    super(`unknown ref ${ref}: not issued by this app or expired from the ref table`);
    this.name = "UnknownRefError";
    this.ref = ref;
  }
}

export class AmbiguousTargetError extends Error {
  readonly ref: string;
  readonly matchCount: number;

  constructor(ref: string, matchCount: number) {
    super(`ambiguous target ${ref}: matches ${matchCount} live nodes`);
    this.name = "AmbiguousTargetError";
    this.ref = ref;
    this.matchCount = matchCount;
  }
}

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

export type TargetRef = string | { nodeId: string };

export type ProgramAction =
  | { kind: "click"; ref: TargetRef }
  | { kind: "typeText"; ref: TargetRef; text: string }
  | { kind: "setValue"; ref: TargetRef; value: string }
  | { kind: "keyPress"; keys: string }
  | { kind: "waitFor"; predicate: (state: AppState) => boolean; timeoutMs: number };

export type Action =
  | { kind: "click"; ref: string }
  | { kind: "typeText"; ref: string; text: string }
  | { kind: "setValue"; ref: string; value: string }
  | { kind: "keyPress"; keys: string }
  | { kind: "waitFor"; predicate: (state: AppState) => boolean; timeoutMs: number };

export type ActionInput = Action;

export type ActResult =
  | { outcome: "delivered_verified"; details: string; stateVersionAfter: number }
  | { outcome: "delivered_unverified"; details: string; stateVersionAfter: number }
  | { outcome: "failed"; details: string };

export interface AdapterCapabilities {
  readonly ids: readonly string[];
}

export interface AppAdapter {
  observe(): Promise<AppState>;
  act(action: ProgramAction): Promise<ActResult>;
  capabilities(): AdapterCapabilities;
  /** Issues an opaque ref for a node, bound to the current stateVersion. */
  issueRef?(nodeId: string): string | null;
}
