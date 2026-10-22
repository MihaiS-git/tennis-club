import { defineConfig } from "@playwright/test";

import { configureTestEnvironment } from "./tests/local/environment.mjs";

// Real Stripe test mode against `node tests/e2e-live/dev-server.mjs` (no production
// build). Fixtures use only the isolated test Supabase project. See docs/testing.md.
configureTestEnvironment();
process.env.APP_URL = "http://localhost:3100";

export default defineConfig({
  testDir: "./tests/e2e-live",
  testMatch: "**/*.e2e.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "list",
  timeout: 240_000,
  use: { baseURL: "http://localhost:3100", browserName: "chromium", channel: "chrome", trace: "retain-on-failure" },
  webServer: {
    command: "node tests/e2e-live/dev-server.mjs",
    url: "http://localhost:3100",
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
