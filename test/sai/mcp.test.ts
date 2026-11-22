import { spawn } from "node:child_process";
import { expect, test, vi } from "vitest";
import { checkMcpServer } from "../../scripts/sai/mcp.ts";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => {
    throw new Error("offline fake");
  }),
}));

test("MCP launches the recorded package version with only PATH and the key", async () => {
  const key = "fake";
  await checkMcpServer(key);
  expect(spawn).toHaveBeenCalledExactlyOnceWith("npx", ["-y", "@simular-ai/sai-mcp@0.6.0"], {
    env: { PATH: process.env.PATH, SAI_API_KEY: key },
    stdio: ["pipe", "pipe", "pipe"],
  });
});
