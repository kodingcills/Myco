/**
 * TIF-58 EF-005 — the todo-app `LiveTransport`.
 *
 * This is the piece that turns the VM slot into a configuration change. It implements the
 * arm-facing `LiveTransport` over a `GuestProtocol`, so:
 *
 *   - offline, a `fakeGuest` drives it and the contract tests run in CI;
 *   - on the VM, a `mycoAgentGuest` (or any other protocol implementation) drives it and
 *     nothing above this file changes.
 *
 * Two decisions worth stating, because both are about not overclaiming:
 *
 * 1. **A pixel arm reads no text.** The todo app is Tkinter and Tk registers no AT-SPI node
 *    (RT-003), so a screenshot arm sees pixels. `screen()` therefore returns an empty
 *    `visibleText` for the pixel channel rather than inventing text the arm could not read.
 *    The state oracle still decides the verdict; the screen oracle simply records that it
 *    had nothing to match, and the report says so.
 * 2. **A tool call must prove what it touched.** `tool()` returns the accesses the guest
 *    reports. A guest that cannot say what a call touched throws, which marks the trial
 *    incomplete — the scorer then excludes it rather than assuming the call did nothing.
 */

import type { ScreenView, TraceAct } from "../types.ts";
import type { LiveTransport, RecordedAccessShape, ToolRequest } from "./executor.ts";
import type { GuestProtocol } from "./guest.ts";

export type TodoChannel = "pixel" | "structural";

export interface TodoTransportOptions {
  readonly guest: GuestProtocol;
  /**
   * `pixel` is the honest screenshot arm: it clicks coordinates and reads no text.
   * `structural` is the same transport with a guest that can also report widget text.
   */
  readonly channel: TodoChannel;
  /** The app command, launched once per trial. */
  readonly argv: readonly string[];
  /** Optional text extraction for the structural channel; absent means no text. */
  readonly readText?: () => Promise<readonly string[]>;
}

/**
 * Maps a `TraceAct` onto the guest's coordinate input.
 *
 * The action union is element-oriented (`click(ref)`), but a pixel arm has no refs. The
 * convention here is that `target` carries `"x,y"` for a click and the key name for a
 * keypress, which is what a pixel arm's planner emits. An action the transport cannot map
 * throws rather than silently doing nothing — a no-op that looks delivered is the failure
 * mode this whole harness exists to catch.
 */
function coordinatesOf(target: string | undefined): { x: number; y: number } {
  const match = /^(-?\d+)\s*,\s*(-?\d+)$/.exec(target ?? "");
  if (!match) throw new Error(`pixel channel needs "x,y" as the target, got ${target ?? "none"}`);
  return { x: Number(match[1]), y: Number(match[2]) };
}

export function todoTransport(options: TodoTransportOptions): LiveTransport {
  const { guest, channel } = options;
  let launched = false;

  return {
    async screen(): Promise<ScreenView> {
      const reachable = await guest.alive();
      if (!reachable) return { visibleText: [], reachable: false };
      // A pixel arm cannot read Tk text; a structural one can, if the guest offers it.
      if (channel === "pixel" || options.readText === undefined) {
        return { visibleText: [], reachable: true };
      }
      return { visibleText: [...(await options.readText())], reachable: true };
    },

    async readPersistence(paths) {
      const files: Record<string, Uint8Array> = {};
      for (const path of paths) files[path] = await guest.readFile(path);
      return files;
    },

    async act(action: TraceAct) {
      if (!launched) {
        await guest.launch(options.argv);
        launched = true;
      }
      switch (action.kind) {
        case "launch":
          return;
        case "click": {
          const { x, y } = coordinatesOf(action.target);
          return guest.click(x, y);
        }
        case "typeText":
          return guest.type(action.detail ?? "");
        case "keyPress":
          return guest.key(action.target ?? action.detail ?? "");
        case "setValue":
          // A pixel arm has no set-value primitive; typing is the honest equivalent.
          return guest.type(action.detail ?? "");
        case "waitFor":
          // Waiting is the harness's job, not the guest's; nothing to deliver.
          return;
      }
    },

    async tool(via, request: ToolRequest): Promise<readonly RecordedAccessShape[]> {
      // The guest protocol exposes reads only. A write or exec request is refused rather
      // than faked: an arm that tries to shortcut through the filesystem must be recorded
      // as having tried, and the scorer decides what that means.
      if (request.operation !== "read" || request.path === undefined) {
        throw new Error(
          `the todo guest exposes reads only; refused ${request.operation} via ${via}`,
        );
      }
      await guest.readFile(request.path);
      return [{ operation: "read", path: request.path }];
    },
  };
}

/**
 * A `GuestProtocol` over the existing `myco-agent` op set.
 *
 * The agent already speaks NDJSON with `launch`, `screenshot`, `read_file` and
 * `uia_invoke`. What it does not have is a coordinate click or an arbitrary keystroke —
 * M1-023 recorded that gap. This adapter therefore takes those two as injected functions
 * rather than pretending the ops exist: on the VM they are supplied by whichever input
 * channel the guest provides, and if none does, the arm cannot run and says so.
 */
export interface AgentOps {
  readonly launch: (argv: readonly string[]) => Promise<void>;
  readonly screenshot: () => Promise<Uint8Array>;
  readonly readFile: (path: string) => Promise<Uint8Array>;
  readonly alive: () => Promise<boolean>;
  /** Absent when the guest has no coordinate-input channel. */
  readonly click?: (x: number, y: number) => Promise<void>;
  /** Absent when the guest has no arbitrary-keystroke channel. */
  readonly key?: (name: string) => Promise<void>;
  /** Absent when the guest has no text-entry channel. */
  readonly type?: (text: string) => Promise<void>;
}

export function mycoAgentGuest(ops: AgentOps): GuestProtocol {
  const require = <T>(fn: T | undefined, what: string): T => {
    if (fn === undefined)
      throw new Error(
        `the guest has no ${what} channel; a pixel arm cannot run without it (M1-023)`,
      );
    return fn;
  };
  return {
    launch: ops.launch,
    screenshot: ops.screenshot,
    readFile: ops.readFile,
    alive: ops.alive,
    // Async so a missing channel rejects rather than throwing synchronously: the protocol
    // promises a Promise, and a caller using `await` must see the failure the same way it
    // would see a guest error.
    click: async (x, y) => require(ops.click, "coordinate-click")(x, y),
    key: async (name) => require(ops.key, "keystroke")(name),
    type: async (text) => require(ops.type, "text-entry")(text),
  };
}
