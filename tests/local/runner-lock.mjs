import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { assertTestEnvironment } from "./environment.mjs";

// One database-using test runner at a time on the isolated test database. A detached helper
// holds a PostgreSQL session advisory lock while the runner, or any process it started, is
// alive; PostgreSQL releases the lock with the helper's session. Nothing persists that would
// need manual recovery.
// Resolved like environment.mjs: Playwright loads this module as CommonJS, without import.meta.
const helper = resolve("tests/local/runner-lock-helper.mjs");

/**
 * Locks the isolated test database for this run, or throws at once while another run holds it.
 * @param {string} runner
 */
export function lockTestDatabase(runner) {
  // Playwright workers load the config too; they run under their runner's lock.
  if (process.env.TEST_WORKER_INDEX !== undefined || process.env.TEST_DATABASE_LOCK_OWNER === `${process.pid}`) return;
  assertTestEnvironment();
  try {
    execFileSync(process.execPath, [helper, "start", runner, `${process.pid}`],
      { encoding: "utf8", stdio: ["ignore", "ignore", "pipe"], timeout: 30_000 });
  } catch (error) {
    throw new Error(error.stderr?.trim() || `Cannot lock the isolated test database: ${error.message}`);
  }
  // Inherited by every process the runner starts; the helper follows them all.
  process.env.TEST_DATABASE_LOCK_OWNER = `${process.pid}`;
}
