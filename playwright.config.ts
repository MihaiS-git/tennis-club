import { defineConfig } from "@playwright/test";

import { configureTestEnvironment } from "./tests/local/environment.mjs";

configureTestEnvironment();
const appUrl = "http://localhost:3100";
process.env.STRIPE_SECRET_KEY = "sk_test_IsolatedFixture";
process.env.STRIPE_PUBLISHABLE_KEY = "pk_test_IsolatedFixture";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_IsolatedFixture";
process.env.STRIPE_TEST_API_URL = "http://127.0.0.1:3111";
process.env.APP_URL = appUrl;
process.env.PLAYWRIGHT_APP_URL = appUrl;
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
    baseURL: appUrl,
    browserName: "chromium",
    channel: "chrome",
  },
  webServer: [{ command: "node tests/e2e/fixtures/stripe-server.mjs", url: "http://127.0.0.1:3111/health", reuseExistingServer: false }, {
    command: "node tests/local/assert-next-server-environment.mjs production && npm run --silent build && npm run --silent start -- --port 3100",
    url: appUrl,
    reuseExistingServer: false,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 180_000,
  }],
});
