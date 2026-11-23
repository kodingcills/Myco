import { type Action, checkPurity } from "./index.ts";

export class PixelRouteError extends Error {}

export interface Screenshot {
  mimeType: "image/png" | "image/jpeg";
  data: string;
}

/**
 * What actually happened to one Cua action, kept distinct because the previous
 * single `refused` boolean conflated four different events (TIF-167).
 *
 * The distinction is not cosmetic. `C1.execute` used to return
 * `refused: result.isError === true || effect === "refused"`, so a *routing*
 * refusal - the delivery layer declining to send the input at all - was
 * indistinguishable from the model failing to save. arm-003c's
 * `cua-action-refused` was read as the latter for a day when it was the former,
 * and the probe on 2026-11-23 settled it: background `key_combo` on a SALFRAME
 * window is refused before the app is ever reached, identically for Ctrl+S and
 * for Ctrl+F12.
 *
 * - `routing-refused`   the delivery layer declined to deliver; the app never saw
 *                       it. NOT a model outcome.
 * - `delivered-dismissed` the input landed and something closed the result - for a
 *                       save, a dialog the app itself opened. NOT a model outcome.
 * - `delivered-stalled` the input landed but Cua could not confirm the target read
 *                       it within its budget. NOT a model outcome: it is unproven
 *                       whether the app acted, and Cua requires reading the target
 *                       before repeating rather than blind-retrying.
 * - `delivered`         the input landed and Cua verified it.
 * - `save-failed`       a save was attempted, was delivered, and did not take. This
 *                       is the ONLY outcome that counts against the model.
 */
export type CuaOutcome =
  | "routing-refused"
  | "delivered"
  | "delivered-dismissed"
  | "delivered-stalled"
  | "save-failed";

/** Where an action ended up being delivered. Recorded per action (TIF-167). */
export type DeliveryMode = "background" | "foreground";

export interface Mcp {
  request(method: string, params: object): Promise<unknown>;
  notify(method: string): Promise<void>;
}

export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Turn one raw Cua response into a single outcome.
 *
 * Order matters. The `background_unavailable` code is checked before the
 * generic `effect === "refused"`, because a refusal the delivery layer can
 * escalate is a different event from one it cannot: only the former should be
 * retried in foreground mode, and conflating them would either retry something
 * unfixable or drop the only escape hatch that works.
 *
 * `escalatable` is deliberately narrow. Cua's own message names
 * `delivery_mode:"foreground"` for this case; nothing else in its vocabulary
 * promises that a retry helps.
 */
function classify(result: unknown): {
  outcome: CuaOutcome;
  escalatable: boolean;
  verified?: boolean;
} {
  const outer = record(result);
  const inner = record(outer.structuredContent);
  const { effect, verified, path, code } = inner;
  if (typeof path === "string" && !["pixel", "key_events", "key_events_fg"].includes(path))
    throw new PixelRouteError("unexpected Cua delivery path");

  const verifiedField = typeof verified === "boolean" ? { verified } : {};

  // The delivery layer declined, and says a mode change would work.
  if (code === "background_unavailable")
    return { outcome: "routing-refused", escalatable: true, ...verifiedField };

  // Delivered, but Cua could not confirm the target read it. NOT a failure and
  // NOT to be retried blindly: the driver itself says to inspect first.
  if (code === "tool_invocation_failed" && typeof inner.foreground_restored === "boolean")
    return { outcome: "delivered-stalled", escalatable: false, ...verifiedField };

  // Any other refusal, including one with no code at all, is routing-level and
  // must not be counted against the model.
  if (outer.isError === true || effect === "refused")
    return { outcome: "routing-refused", escalatable: false, ...verifiedField };

  return { outcome: "delivered", escalatable: false, ...verifiedField };
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
  if (!checkPurity("c1", { actions: [action], claims: [], deliveries: [] }).ok)
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
    async execute(input: Action): Promise<{
      outcome: CuaOutcome;
      deliveryMode: DeliveryMode;
      escalated: boolean;
      verified?: boolean;
    }> {
      const action = pixelAction(input);
      // One background attempt. `delivery_mode` is added here rather than in
      // `pixelAction` because that validator pins the argument count, and the
      // planner must not be able to pick a mode - the escalation is policy, not
      // a model choice.
      const background = await call(action.tool, {
        ...record(action.arguments),
        pid,
        window_id,
      });
      const first = classify(background);

      // Escalate ONCE, and only on the specific refusal that has a documented
      // escape hatch. Any other failure is reported as-is: retrying a
      // `delivered-stalled` action would duplicate it, and retrying an
      // unexpected error would hide a real fault.
      //
      // `escalatable` is consumed here and deliberately not returned: it is a
      // property of this decision, not of what the caller observed.
      if (first.outcome !== "routing-refused" || !first.escalatable) {
        const { escalatable: _drop, ...observed } = first;
        return { ...observed, deliveryMode: "background", escalated: false };
      }

      const foreground = await call(action.tool, {
        ...record(action.arguments),
        pid,
        window_id,
        delivery_mode: "foreground",
      });
      const { escalatable: _alsoDrop, ...observed } = classify(foreground);
      return { ...observed, deliveryMode: "foreground", escalated: true };
    },
  };
}
