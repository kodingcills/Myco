/**
 * A fake HCU MCP session for the pre-agent probe tests (#733 round 2, B1). It speaks the subset
 * of HCU's MCP the arm's client uses (`initialize`, `tools/list`, `tools/call GUI`), so the
 * probe runs through the real `connectHcuGui`. No SSH, no VM.
 */
import type { HcuSession } from "../../src/pilot/hcu-ssh.ts";

export type FakeHcuMode =
  /** HCU answers and serves a PNG screenshot of the desktop. */
  | "ok"
  /** The channel cannot be opened (SSH / HCU unreachable): `open()` throws. */
  | "unreachable"
  /** HCU answers, serves `GUI`, but its screenshot is an error (no interactive desktop). */
  | "no-screenshot"
  /** HCU answers, serves `GUI`, but returns no image at all (e.g. text only). */
  | "no-image"
  /** HCU answers but does not serve the `GUI` tool. */
  | "no-gui"
  /** HCU never answers. */
  | "hang"
  /**
   * A freshly booted guest (VM-owner findings on #733): the first two screenshots time out in
   * HCU's Windows runtime, the third succeeds.
   */
  | "cold-2";

/** HCU's warm-up failure text, which must never reach a log or a fault message. */
export const HCU_COLD_TEXT = "Windows runtime timed out after 838.8614ms";

export const FAKE_PNG = "iVBORw0KGgo=";

export function fakeHcuSession(
  mode: FakeHcuMode,
  log: string[] = [],
): { open: () => HcuSession; log: string[]; closed: () => number } {
  let closed = 0;
  let screenshots = 0;
  const open = (): HcuSession => {
    log.push("hcu-open");
    if (mode === "unreachable")
      throw new Error("ssh: connect to host myco-win11 port 22: secret host detail");
    return {
      mcp: {
        async request(method: string, params?: object) {
          if (mode === "hang") return new Promise(() => {});
          if (method === "initialize") return { protocolVersion: "2025-06-18" };
          if (method === "tools/list")
            return { tools: mode === "no-gui" ? [{ name: "AX" }] : [{ name: "GUI" }] };
          const actions = (params as { arguments?: { actions?: { type: string }[] } }).arguments
            ?.actions;
          if (actions?.[0]?.type === "screenshot") {
            log.push("hcu-screenshot");
            screenshots += 1;
            if (mode === "cold-2" && screenshots <= 2)
              return {
                isError: true,
                content: [{ type: "text", text: JSON.stringify({ error: HCU_COLD_TEXT }) }],
              };
            if (mode === "no-screenshot")
              return {
                isError: true,
                content: [
                  { type: "text", text: '{"ok":false,"code":"no_interactive_desktop C:\\\\x"}' },
                ],
              };
            if (mode === "no-image") return { content: [{ type: "text", text: '{"ok":true}' }] };
            return {
              content: [
                { type: "text", text: '{"ok":true}' },
                { type: "image", mimeType: "image/png", data: FAKE_PNG },
              ],
            };
          }
          return { content: [{ type: "text", text: '{"ok":true}' }] };
        },
        async notify() {},
      },
      close() {
        closed += 1;
        log.push("hcu-close");
      },
    };
  };
  return { open, log, closed: () => closed };
}
