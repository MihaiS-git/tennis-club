import { spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { assertTestEnvironment } from "./environment.mjs";

// Process side of runner-lock.mjs. `start` runs synchronously under the runner and returns once
// a detached `hold` process owns the lock. `hold` keeps its session while the runner or any
// process carrying the runner's TEST_DATABASE_LOCK_OWNER marker is alive: Vitest workers finish
// their current test, and web servers keep serving, after their runner is killed.
const self = fileURLToPath(import.meta.url);
// Application code uses (1791462257, 1) as its transaction-scoped configuration fence.
const lockKey = [1791462257, 1000];
const sessionName = "tennis-club-test-runner";
const followInterval = 200;
// A runner that has just finished may still be closing its session.
const releaseWait = 5_000;

/** @param {number} pid */
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
}

// Linux /proc; elsewhere only the runner's own process is followed.
/** @param {number} owner */
function startedBy(owner) {
  const marker = `TEST_DATABASE_LOCK_OWNER=${owner}`;
  let entries;
  try { entries = readdirSync("/proc"); } catch { return []; }
  return entries.filter((pid) => {
    if (!/^\d+$/.test(pid)) return false;
    try { return readFileSync(`/proc/${pid}/environ`, "latin1").split("\0").includes(marker); } catch { return false; }
  });
}

/** @param {string} runner @param {string} owner */
function start(runner, owner) {
  const holder = spawn(process.execPath, [self, "hold", runner, owner], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let output = "", errors = "";
  holder.stderr.setEncoding("utf8").on("data", (chunk) => { errors += chunk; });
  holder.on("exit", (code) => {
    process.stderr.write(errors || `The test database lock helper exited with ${code}.`);
    process.exit(1);
  });
  holder.stdout.setEncoding("utf8").on("data", (chunk) => {
    output += chunk;
    if (output !== "locked\n") return;
    holder.removeAllListeners("exit");
    holder.stdout.destroy(); holder.stderr.destroy(); holder.unref();
    process.exit(0);
  });
}

// Why the lock is taken. A run still in use fails a new run at once; only the session of a run
// whose processes have all exited is awaited while it closes.
/** @param {{ name: string, since: Date }[]} sessions */
function describe(sessions) {
  const holders = sessions.map(({ name, since }) => {
    const [, runner = "unknown", pid = ""] = name.split(":");
    return { runner, pid: Number(pid), since: since.toISOString() };
  });
  const running = holders.find(({ pid }) => !pid || alive(pid));
  if (running) {
    return { running: true, message: `Another test runner (${running.runner}, process ${running.pid || "unknown"}, since ${running.since}) `
      + "is using the isolated test database. Integration and E2E runs share it and must run one at a time; "
      + "wait for that run to finish, then retry." };
  }
  for (const { runner, pid } of holders) {
    const remaining = startedBy(pid);
    if (remaining.length) {
      return { running: true, message: `A test runner (${runner}, process ${pid}) has exited, but processes it started `
        + `(${remaining.join(", ")}) are still running and keep the isolated test database locked. `
        + "Wait for them to finish or stop them, then retry." };
    }
  }
  return { running: false, message: "The isolated test database lock was not released in time; retry." };
}

/** @param {string} runner @param {string} owner */
async function hold(runner, owner) {
  assertTestEnvironment();
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL, application_name: `${sessionName}:${runner}:${owner}` });
  client.on("error", () => process.exit(1));
  client.on("end", () => process.exit(1));
  await client.connect();
  for (const deadline = Date.now() + releaseWait; ;) {
    if ((await client.query("SELECT pg_try_advisory_lock($1, $2) AS locked", lockKey)).rows[0].locked) break;
    const sessions = (await client.query(`SELECT a.application_name AS name, a.backend_start AS since
      FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
      WHERE l.locktype = 'advisory' AND l.granted AND l.classid = $1::int::oid AND l.objid = $2::int::oid AND l.objsubid = 2`, lockKey)).rows;
    const { running, message } = describe(sessions);
    if (running || Date.now() > deadline) {
      process.stderr.write(message);
      process.exit(1);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  process.stdout.write("locked\n");
  const run = Number(owner);
  setInterval(() => { if (!alive(run) && !startedBy(run).length) process.exit(0); }, followInterval);
}

const [mode, runner, owner] = process.argv.slice(2);
if (mode === "start") start(runner, owner);
else if (mode === "hold") await hold(runner, owner);
else throw new Error("Unknown test database lock mode.");
