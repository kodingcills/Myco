import { type Action, checkPurity } from "./index.ts";

export class PixelRouteError extends Error {}

export interface Screenshot {
  mimeType: "image/png" | "image/jpeg";
  data: string;
}

export interface Mcp {
  request(method: string, params: object): Promise<unknown>;
  notify(method: string): Promise<void>;
}

export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function pixelAction(input: unknown): Action {
  const { tool, arguments: args } = record(input);
  const { x, y, text, key } = record(args);
  if (
    (tool !== "click" && tool !== "type_text" && tool !== "press_key") ||
    typeof x !== "number" ||
    !Number.isFinite(x) ||
    x < 0 ||
    typeof y !== "number" ||
    !Number.isFinite(y) ||
    y < 0 ||
    Object.keys(record(input)).length !== 2 ||
    Object.keys(record(args)).length !== (tool === "click" ? 2 : 3)
  )
    throw new Error("invalid pixel action");
  if (tool === "type_text" && (typeof text !== "string" || text.length > 256))
    throw new Error("invalid pixel action");
  if (tool === "press_key" && (typeof key !== "string" || !/^[a-z0-9+_-]{1,32}$/i.test(key)))
    throw new Error("invalid pixel action");
  const action = { tool, arguments: args };
  if (!checkPurity("c1", { actions: [action], claims: [] }).ok)
    throw new Error("impure pixel action");
  return action;
}

export async function connectC1(mcp: Mcp, window: { pid: number; window_id: number }) {
  // Copy the operator-supplied target. The planner cannot select or override it.
  const { pid, window_id } = window;
  if (![pid, window_id].every((id) => Number.isSafeInteger(id) && id > 0))
    throw new Error("invalid Calc window");
  const protocolVersion = "2025-11-25";
  const init = record(
    await mcp.request("initialize", {
      protocolVersion,
      capabilities: {},
      clientInfo: { name: "myco-c1", version: "1" },
    }),
  );
  if (
    init.protocolVersion !== protocolVersion &&
    init.protocolVersion !== "2024-11-05" &&
    init.protocolVersion !== "2025-06-18" &&
    init.protocolVersion !== "2025-03-26" &&
    init.protocolVersion !== "2026-07-28"
  )
    throw new Error("unsupported MCP protocol");
  await mcp.notify("notifications/initialized");

  const call = async (name: string, args: object) =>
    record(await mcp.request("tools/call", { name, arguments: args }));

  return {
    async screenshot(): Promise<Screenshot> {
      const result = await call("get_window_state", { pid, window_id, include_screenshot: true });
      if (result.isError !== true && Array.isArray(result.content)) {
        for (const item of result.content) {
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
      }
      throw new Error("guest screenshot unavailable");
    },
    async execute(input: Action): Promise<{ refused: boolean; verified?: boolean }> {
      const action = pixelAction(input);
      const result = await call(action.tool, { ...record(action.arguments), pid, window_id });
      const { effect, verified, path } = record(result.structuredContent);
      if (typeof path === "string" && !["pixel", "key_events", "key_events_fg"].includes(path))
        throw new PixelRouteError("unexpected Cua delivery path");
      return {
        refused: result.isError === true || effect === "refused",
        ...(typeof verified === "boolean" ? { verified } : {}),
      };
    },
  };
}
