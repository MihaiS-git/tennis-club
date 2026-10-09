import { defineConfig } from "@playwright/test";

import { configureTestEnvironment } from "./tests/local/environment.mjs";

configureTestEnvironment();
if (process.env.PLAYWRIGHT_USE_EXISTING_SERVER === "1") {
  throw new Error("E2E tests must start their own isolated server.");
}

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
  webServer: {
    command: "npm run --silent build && npm run --silent start",
    url: "http://localhost:3000",
    reuseExistingServer: false,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 180_000,
  },
});
