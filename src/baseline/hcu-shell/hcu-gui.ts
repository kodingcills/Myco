/**
 * TIF-268 - the live GUI channel for the `hcu+shell` arm: Microsoft Hybrid Computer Use's
 * stdio MCP server (`computer-use mcp`, `github.com/microsoft/Hybrid-Computer-Use`, MIT),
 * driven through its public `GUI` tool. This is the `HcuGui` the library faked until now.
 *
 * Contract used (HCU `docs/MCP.md` "GUI" and "Errors", `internal/contract/tool_contract.go`,
 * read 2026-11-27):
 *  - `GUI {"actions":[{"type":"screenshot"}]}` observes and returns one image (scaled to fit
 *    1366x768); its pixels are the coordinate space of the next input batch.
 *  - An input batch is up to 64 ordered actions; we send exactly one arm action per batch:
 *    `click` -> `[{type:"click",x,y}]`;
 *    `type_text` -> `[{type:"click",x,y},{type:"type",text}]` (focus the point, then type);
 *    `press_key` -> `[{type:"keypress",keys:[...]}]` (one chord, `ctrl+s` -> `["CTRL","S"]`;
 *    the point is not clicked, so a key never moves the selection).
 *  - Every result starts with one JSON status line: `ok`, and on failure `code` and
 *    `input_emitted`. Mapped to the arm's delivery outcomes (the C1 vocabulary, `../c1.ts`):
 *    `ok` -> `delivered` (unverified: HCU has no confirmation token, its own docs say pixels
 *    prove nothing about the document); a code that HCU documents as "no input sent"
 *    (`invalid_argument`, `gui_frame_stale`, `permission_denied`, `global_input_forbidden`)
 *    or `input_emitted: false` -> `routing-refused`; anything else, including an unreadable
 *    status line -> `delivered-stalled` (input may have landed; never blindly resent).
 *
 * The planner cannot pick the tool, the batch or the delivery: it emits one C1 pixel action,
 * which `pixelAction` validates before anything is sent. The `AX` tool is not offered: the
 * arm is the C1 pixel arm plus a shell, so its GUI surface stays pixel-only (recorded
 * asymmetry: HCU's accessibility channel is unused).
 */
import {
  type CuaOutcome,
  type DeliveryMode,
  type Mcp,
  pixelAction,
  record,
  type Screenshot,
} from "../c1.ts";
import type { Action } from "../index.ts";
import type { HcuGui } from "./trial.ts";

export const HCU_GUI_TOOL = "GUI";
/** Codes HCU documents as "input may have been sent: no". */
export const HCU_NOT_SENT_CODES: readonly string[] = [
  "invalid_argument",
  "gui_frame_stale",
  "permission_denied",
  "global_input_forbidden",
];
const PROTOCOLS = ["2025-06-18", "2025-03-26"];

export class HcuUnavailableError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "HcuUnavailableError";
  }
}

/** HCU key-chord tokens for a C1 `press_key` key (`ctrl+s`, `enter`, `ctrl+shift+f12`). */
export function hcuKeys(key: string): string[] {
  const tokens = key.split("+").map((t) => t.trim().toUpperCase());
  if (tokens.length === 0 || tokens.some((t) => t === "")) throw new Error("invalid key chord");
  return tokens.map((t) => (t === "CONTROL" ? "CTRL" : t === "ESCAPE" ? "ESC" : t));
}

/** The one HCU input batch for one validated arm action. */
export function hcuBatch(action: Action): Record<string, unknown>[] {
  const a = pixelAction(action);
  const args = record(a.arguments);
  if (a.tool === "click") return [{ type: "click", x: args.x, y: args.y }];
  if (a.tool === "type_text")
    return [
      { type: "click", x: args.x, y: args.y },
      { type: "type", text: args.text },
    ];
  return [{ type: "keypress", keys: hcuKeys(String(args.key)) }];
}

/** The status line HCU puts first in every GUI result, or null when it cannot be read. */
export function hcuStatus(result: unknown): Record<string, unknown> | null {
  const content = record(result).content;
  if (!Array.isArray(content)) return null;
  const text = content.map(record).find((c) => c.type === "text" && typeof c.text === "string");
  const first = typeof text?.text === "string" ? text.text.split("\n")[0] : undefined;
  if (first === undefined) return null;
  try {
    const status = record(JSON.parse(first));
    return typeof status.ok === "boolean" ? status : null;
  } catch {
    return null;
  }
}

export function classifyHcu(result: unknown): CuaOutcome {
  const status = hcuStatus(result);
  if (status === null) return "delivered-stalled";
  if (status.ok === true && record(result).isError !== true) return "delivered";
  if (status.input_emitted === false) return "routing-refused";
  if (typeof status.code === "string" && HCU_NOT_SENT_CODES.includes(status.code))
    return "routing-refused";
  return "delivered-stalled";
}

function screenshotOf(result: unknown): Screenshot {
  const r = record(result);
  if (Array.isArray(r.content))
    for (const item of r.content) {
      const { type, mimeType, data } = record(item);
      if (
        type === "image" &&
        (mimeType === "image/png" || mimeType === "image/jpeg") &&
        typeof data === "string" &&
        data.length > 0 &&
        data.length <= 8_000_000 &&
        /^[A-Za-z0-9+/]+={0,2}$/.test(data)
      )
        return { mimeType, data };
    }
  throw new HcuUnavailableError("hcu-screenshot-unavailable");
}

/**
 * Initialise HCU's MCP session and check it serves `GUI`. Throws `HcuUnavailableError` with a
 * code (`hcu-protocol-unsupported`, `hcu-gui-tool-missing`) on anything else.
 */
export async function connectHcuGui(mcp: Mcp): Promise<HcuGui> {
  const init = record(
    await mcp.request("initialize", {
      protocolVersion: PROTOCOLS[0],
      capabilities: {},
      clientInfo: { name: "myco-hcu-shell", version: "1" },
    }),
  );
  if (typeof init.protocolVersion !== "string" || !PROTOCOLS.includes(init.protocolVersion))
    throw new HcuUnavailableError("hcu-protocol-unsupported");
  await mcp.notify("notifications/initialized");
  const tools = record(await mcp.request("tools/list", {})).tools;
  if (!Array.isArray(tools) || !tools.some((t) => record(t).name === HCU_GUI_TOOL))
    throw new HcuUnavailableError("hcu-gui-tool-missing");
  const gui = (actions: Record<string, unknown>[]) =>
    mcp.request("tools/call", { name: HCU_GUI_TOOL, arguments: { actions } });
  return {
    async screenshot() {
      const result = await gui([{ type: "screenshot" }]);
      if (record(result).isError === true || hcuStatus(result)?.ok === false)
        throw new HcuUnavailableError("hcu-screenshot-unavailable");
      return screenshotOf(result);
    },
    async execute(action: Action): Promise<{
      outcome: CuaOutcome;
      deliveryMode: DeliveryMode;
      escalated: boolean;
      verified?: boolean;
    }> {
      const batch = hcuBatch(action);
      let result: unknown;
      try {
        result = await gui(batch);
      } catch {
        // The transport failed after the request may have been written: unknown, not refused.
        return { outcome: "delivered-stalled", deliveryMode: "foreground", escalated: false };
      }
      return { outcome: classifyHcu(result), deliveryMode: "foreground", escalated: false };
    },
  };
}
