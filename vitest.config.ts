import { defineConfig } from "vitest/config";

// Defaults everywhere except one setup file; see test/setup/yield-to-event-loop.ts
// for why every test yields one event-loop turn (the macOS "Timeout calling
// onTaskUpdate" failures).
export default defineConfig({
  test: {
    setupFiles: ["./test/setup/yield-to-event-loop.ts"],
  },
});
