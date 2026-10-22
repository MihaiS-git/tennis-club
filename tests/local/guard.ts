import { expect } from "vitest";
import { assertTestEnvironment } from "./environment.mjs";

process.env.NOTIFICATION_EMAIL_MODE = "sandbox";
process.env.NOTIFICATION_DELIVERY_NOT_BEFORE = "";
process.env.NOTIFICATION_TEST_RUNNER = "1";

if (expect.getState().testPath?.replaceAll("\\", "/").includes("/tests/integration/")) {
  assertTestEnvironment();
} else {
  // Unit and component tests use mocks; an inherited development URL must
  // never let an accidental database read/write reach the live Cron database.
  process.env.DATABASE_URL = "";
  process.env.LOCAL_SUPABASE_DB_URL = "";
}
