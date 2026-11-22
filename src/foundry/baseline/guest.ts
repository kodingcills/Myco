/**
 * TIF-58 EF-005 — the guest protocol, and the two implementations of it.
 *
 * `LiveTransport` (executor.ts) is what an arm needs. `GuestProtocol` is what a *guest*
 * must offer to satisfy it. Splitting them is what makes the VM slot a configuration
 * change: the transport is written and tested once against this protocol, and the only
 * thing a real guest adds is an implementation of six methods.
 *
 * The protocol is deliberately coordinate-based rather than element-based. The todo app is
 * Tkinter, and Tk registers no AT-SPI node (docs/backlog/runtime.md, RT-003), so a
 * structural arm cannot address its widgets at all. A screenshot arm clicks pixels, which
 * is exactly what this protocol exposes — and what M1-023 recorded the agent op union as
 * lacking.
 */

import type { AppState } from "../tasks/app-model.ts";
import {
  addItem,
  bootApp,
  deleteItem,
  persistedFiles,
  saveApp,
  visibleScreen,
} from "../tasks/app-model.ts";
import type { TodoFixtureSpec } from "../tasks/todo.ts";

/** What a guest must offer. Every method may throw; the executor records the failure. */
export interface GuestProtocol {
  /** Start the app. Idempotent: launching twice is not an error. */
  launch(argv: readonly string[]): Promise<void>;
  /** A PNG of the app window, for evidence. */
  screenshot(): Promise<Uint8Array>;
  /** Pointer click at window-relative coordinates. */
  click(x: number, y: number): Promise<void>;
  /** Type text into whatever has focus. */
  type(text: string): Promise<void>;
  /** Press a named key (`Return`, `Delete`, `ctrl+s`). */
  key(name: string): Promise<void>;
  /** Read a file from the guest filesystem. */
  readFile(path: string): Promise<Uint8Array>;
  /** Whether the app process is still alive. */
  alive(): Promise<boolean>;
}

/**
 * A fake guest that drives the real todo app model.
 *
 * It is not a mock of the transport: it is a guest whose app happens to be simulated. That
 * matters, because the transport's contract tests then exercise the same listbox, status
 * bar and save semantics the state oracle grades — a mock that returned canned strings
 * would prove only that the transport can copy strings.
 *
 * Coordinates are a fixed layout, so a test can click a named control the way a pixel arm
 * would: the listbox occupies the top, then Add, then Save.
 */
export interface FakeGuestOptions {
  readonly spec: TodoFixtureSpec;
  /** Fail the next call of this kind, to exercise the transport's failure path. */
  readonly failOn?: "launch" | "screenshot" | "click" | "type" | "key" | "readFile";
  /** Report the app as dead after this many actions. */
  readonly dieAfter?: number;
}

export interface FakeGuest extends GuestProtocol {
  /** The app state, for assertions. */
  state(): AppState;
  /** Every action the guest received, in order. */
  received(): readonly string[];
}

/** The fixed layout a pixel arm clicks against. */
export const LAYOUT = {
  listbox: { x: 20, y: 20, width: 380, height: 240 },
  add: { x: 210, y: 280 },
  save: { x: 210, y: 320 },
} as const;

export function fakeGuest(options: FakeGuestOptions): FakeGuest {
  let state = bootApp(options.spec);
  let launched = false;
  let actions = 0;
  let pendingText = "";
  let selected: string | undefined;
  const log: string[] = [];

  const tick = (kind: string) => {
    actions += 1;
    log.push(kind);
    if (options.failOn === kind) throw new Error(`guest refused ${kind}`);
    if (options.dieAfter !== undefined && actions > options.dieAfter)
      throw new Error("app process died");
  };

  return {
    async launch() {
      tick("launch");
      launched = true;
    },
    async screenshot() {
      tick("screenshot");
      // A 1x1 PNG is enough to prove the channel carries bytes; the real guest sends a frame.
      return new Uint8Array([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
        0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f,
        0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00,
        0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49,
        0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
      ]);
    },
    async click(x, y) {
      tick("click");
      if (!launched) throw new Error("app is not running");
      // Hit-test against the fixed layout, the way a pixel arm's click would land.
      const near = (p: { x: number; y: number }) =>
        Math.abs(p.x - x) <= 24 && Math.abs(p.y - y) <= 16;
      if (near(LAYOUT.add)) state = addItem(state, pendingText);
      else if (near(LAYOUT.save)) state = saveApp(options.spec, state);
      else if (
        x >= LAYOUT.listbox.x &&
        x <= LAYOUT.listbox.x + LAYOUT.listbox.width &&
        y >= LAYOUT.listbox.y &&
        y <= LAYOUT.listbox.y + LAYOUT.listbox.height
      ) {
        // Clicking a row selects it; a following Delete removes it.
        const row = Math.floor((y - LAYOUT.listbox.y) / 20);
        selected = state.listbox[row];
      }
    },
    async type(text) {
      tick("type");
      if (!launched) throw new Error("app is not running");
      pendingText = text;
    },
    async key(name) {
      tick("key");
      if (!launched) throw new Error("app is not running");
      if (name === "Delete" && selected !== undefined) {
        state = deleteItem(state, selected);
        selected = undefined;
      }
      if (name === "Return") state = addItem(state, pendingText);
    },
    async readFile(path) {
      tick("readFile");
      const files = persistedFiles(state);
      const bytes = files[path];
      if (bytes === undefined) throw new Error(`no such file: ${path}`);
      return bytes;
    },
    async alive() {
      return launched && !(options.dieAfter !== undefined && actions > options.dieAfter);
    },
    state: () => state,
    received: () => [...log],
  };
}

/** The text a pixel arm could read. Tk exposes none, so this is empty by construction. */
export function pixelArmScreen(reachable: boolean): { visibleText: string[]; reachable: boolean } {
  return { visibleText: [], reachable };
}

/** The text a structural arm could read, if the guest can supply it. */
export function structuralScreen(state: AppState): { visibleText: string[]; reachable: boolean } {
  return { visibleText: visibleScreen(state), reachable: true };
}
