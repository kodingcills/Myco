/**
 * TIF-268: the live HCU GUI channel over a fake MCP session (no guest, no HCU binary).
 */
import { describe, expect, it } from "vitest";
import type { Mcp } from "../../../src/baseline/c1.ts";
import {
  classifyHcu,
  connectHcuGui,
  HCU_NOT_SENT_CODES,
  hcuBatch,
  hcuKeys,
} from "../../../src/baseline/hcu-shell/hcu-gui.ts";
import { PROBE_SCREENSHOT } from "../../../src/baseline/hcu-shell-live/planner.ts";

const status = (s: Record<string, unknown>, image = true) => ({
  content: [
    { type: "text", text: `${JSON.stringify(s)}\nscreen: 1366x768` },
    ...(image ? [{ type: "image", mimeType: "image/png", data: PROBE_SCREENSHOT.data }] : []),
  ],
});

function fakeMcp(
  opts: { protocol?: string; tools?: string[]; reply?: (args: unknown) => unknown } = {},
) {
  const sent: { method: string; params: unknown }[] = [];
  const mcp: Mcp = {
    async request(method, params) {
      sent.push({ method, params });
      if (method === "initialize") return { protocolVersion: opts.protocol ?? "2025-06-18" };
      if (method === "tools/list")
        return { tools: (opts.tools ?? ["AX", "GUI"]).map((name) => ({ name })) };
      const args = (params as { arguments: { actions: { type: string }[] } }).arguments;
      if (args.actions[0]?.type === "screenshot") return status({ ok: true });
      return (opts.reply ?? (() => status({ ok: true })))(args);
    },
    async notify() {},
  };
  return { mcp, sent };
}

describe("action mapping", () => {
  it("maps each C1 pixel action to exactly one HCU GUI batch", () => {
    expect(hcuBatch({ tool: "click", arguments: { x: 3, y: 4 } })).toEqual([
      { type: "click", x: 3, y: 4 },
    ]);
    expect(hcuBatch({ tool: "type_text", arguments: { x: 3, y: 4, text: "42" } })).toEqual([
      { type: "click", x: 3, y: 4 },
      { type: "type", text: "42" },
    ]);
    expect(hcuBatch({ tool: "press_key", arguments: { x: 3, y: 4, key: "ctrl+s" } })).toEqual([
      { type: "keypress", keys: ["CTRL", "S"] },
    ]);
  });
  it("refuses an action the C1 validator refuses, before anything is sent", () => {
    expect(() => hcuBatch({ tool: "drag", arguments: { x: 1, y: 1 } })).toThrow();
    expect(() => hcuBatch({ tool: "click", arguments: { x: -1, y: 1 } })).toThrow();
  });
  it("spells chords as HCU names", () => {
    expect(hcuKeys("Control+Shift+F12")).toEqual(["CTRL", "SHIFT", "F12"]);
    expect(hcuKeys("escape")).toEqual(["ESC"]);
    expect(() => hcuKeys("ctrl++")).toThrow();
  });
});

describe("result classification", () => {
  it("ok is delivered", () => expect(classifyHcu(status({ ok: true }))).toBe("delivered"));
  it.each(HCU_NOT_SENT_CODES)("%s (no input sent) is routing-refused", (code) =>
    expect(classifyHcu(status({ ok: false, code }))).toBe("routing-refused"),
  );
  it("input_emitted false is routing-refused whatever the code", () =>
    expect(classifyHcu(status({ ok: false, code: "runtime_error", input_emitted: false }))).toBe(
      "routing-refused",
    ));
  it.each(["effect_unknown", "window_changed", "runtime_error", "new_code"])(
    "%s (input may have landed) is delivered-stalled, never refused",
    (code) =>
      expect(classifyHcu(status({ ok: false, code, input_emitted: null }))).toBe(
        "delivered-stalled",
      ),
  );
  it("an unreadable status line is delivered-stalled", () => {
    expect(classifyHcu({ content: [{ type: "text", text: "garbage" }] })).toBe("delivered-stalled");
    expect(classifyHcu({})).toBe("delivered-stalled");
    expect(classifyHcu({ isError: true, ...status({ ok: true }) })).toBe("delivered-stalled");
  });
});

describe("the session", () => {
  it("initialises, requires the GUI tool, observes and acts through GUI only", async () => {
    const { mcp, sent } = fakeMcp();
    const gui = await connectHcuGui(mcp);
    expect(await gui.screenshot()).toEqual(PROBE_SCREENSHOT);
    const r = await gui.execute({ tool: "press_key", arguments: { x: 1, y: 1, key: "ctrl+s" } });
    expect(r).toEqual({ outcome: "delivered", deliveryMode: "foreground", escalated: false });
    const calls = sent.filter((s) => s.method === "tools/call");
    expect(calls.map((c) => (c.params as { name: string }).name)).toEqual(["GUI", "GUI"]);
  });
  it("refuses a server without GUI, or with an unknown protocol, with a code", async () => {
    await expect(connectHcuGui(fakeMcp({ tools: ["AX"] }).mcp)).rejects.toMatchObject({
      code: "hcu-gui-tool-missing",
    });
    await expect(connectHcuGui(fakeMcp({ protocol: "1999-01-01" }).mcp)).rejects.toMatchObject({
      code: "hcu-protocol-unsupported",
    });
  });
  it("a transport failure mid-action is delivered-stalled, not refused", async () => {
    const { mcp } = fakeMcp({
      reply: () => {
        throw new Error("pipe closed");
      },
    });
    const gui = await connectHcuGui(mcp);
    expect((await gui.execute({ tool: "click", arguments: { x: 1, y: 1 } })).outcome).toBe(
      "delivered-stalled",
    );
  });
});
