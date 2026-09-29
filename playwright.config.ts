import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "**/*.e2e.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "list",
  use: {
    baseURL: "http://localhost:3000",
    browserName: "chromium",
    channel: "chrome",
  },
  // Opt in when testing against a server that is already running, without a build.
  webServer: process.env.PLAYWRIGHT_USE_EXISTING_SERVER === "1" ? undefined : {
    command: "npm run --silent build && npm run --silent start",
    url: "http://localhost:3000",
    reuseExistingServer: false,
    stderr: "pipe",
    timeout: 180_000,
  },
});
