import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "**/*.pw.ts",
  workers: 1,
  use: {
    offline: true,
    timezoneId: "America/New_York",
    reducedMotion: "reduce",
    viewport: { width: 1440, height: 900 },
    launchOptions: { executablePath: process.env.MYCO_VIEWER_CHROMIUM },
  },
});
