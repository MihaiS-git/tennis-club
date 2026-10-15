import { defineConfig } from "@playwright/test";
import base from "../../playwright.config";
// Focused verification uses the isolated Next dev server; no production build.
process.env.PAYMENT_RECOVERY_INTERVAL_SECONDS = "15";
export default defineConfig({ ...base, testDir: ".", testMatch: ["booking-refund-recovery.e2e.ts", "booking-adjustments.e2e.ts"],
  webServer: (Array.isArray(base.webServer) ? base.webServer : []).map(server => ({ ...server, cwd: process.cwd(),
    command: server.command.includes("build") ? "node node_modules/next/dist/bin/next dev --port 3100" : server.command,
  })),
});
