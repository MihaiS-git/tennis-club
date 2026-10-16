// Idempotent Supabase Cron setup for booking email retries; never imported by
// application code. pg_cron runs every five minutes and pg_net POSTs to the
// protected Next.js endpoint. The endpoint URL and its secret live in Supabase
// Vault; the scheduled command contains no credential and no business logic.
//
//   CRON_DATABASE_URL (default DATABASE_URL)  direct Postgres URL of the Supabase project
//   NOTIFICATION_CRON_URL                     endpoint reachable from the database
//   NOTIFICATION_CRON_SECRET                  the same value as the Next.js server
//
// Flags: (none) schedule/update, --check run one request now and report its
// HTTP status, --status show the job and recent results, --remove unschedule.
import { DataSource } from "typeorm";
import { z } from "zod";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

type Runner = { query(sql: string, parameters?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> };
const jobName = "booking-notification-delivery";
const urlSecret = "notification_cron_url", tokenSecret = "notification_cron_secret";
const command = `SELECT net.http_post(
  url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = '${urlSecret}'),
  headers := jsonb_build_object('Content-Type', 'application/json',
    'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = '${tokenSecret}')),
  body := '{}'::jsonb,
  timeout_milliseconds := 60000)`;

export function target(env: NodeJS.ProcessEnv = process.env) {
  const raw = env.CRON_DATABASE_URL?.trim() || env.DATABASE_URL;
  const url = new URL(z.string().min(1, "Set CRON_DATABASE_URL (or DATABASE_URL).").parse(raw));
  // pg accepts host/port/database overrides in the query string. Permit only
  // TLS mode, never let URL parsing and the driver's effective target disagree.
  if (!["postgres:", "postgresql:"].includes(url.protocol) || url.hash
    || [...url.searchParams].some(([key, value]) => key !== "sslmode" || !["require", "verify-full"].includes(value))
    || url.searchParams.getAll("sslmode").length > 1 || env.PGOPTIONS || env.PGSERVICE || env.PGSERVICEFILE)
    throw new Error("Use a plain PostgreSQL URL; only sslmode=require or verify-full is allowed, without PGOPTIONS/PGSERVICE overrides.");
  if (["55322", "55329"].includes(url.port) || url.hostname.includes("tennis-club-tests")
    || env.TEST_SUPABASE_PROJECT === "tennis-club-tests")
    throw new Error("Refusing to schedule notification delivery in the isolated test database.");
  if (decodeURIComponent(url.username) !== "postgres" || url.pathname !== "/postgres")
    throw new Error("Cron requires the project's direct postgres connection to the postgres database.");
  const supabase = new URL(z.string().url("Set SUPABASE_URL to the intended project.").parse(env.SUPABASE_URL));
  if (supabase.username || supabase.password || supabase.search || supabase.hash || !["", "/"].includes(supabase.pathname))
    throw new Error("SUPABASE_URL must be a project origin.");
  const loopback = ["localhost", "127.0.0.1", "[::1]"];
  if (loopback.includes(url.hostname)) {
    if (url.port !== "54322" || !loopback.includes(supabase.hostname) || supabase.port !== "54321"
      || supabase.protocol !== "http:") throw new Error("Local Cron requires the development Supabase project on ports 54321/54322.");
    url.hostname = "127.0.0.1";
  } else {
    const project = supabase.hostname.match(/^([a-z0-9]+)\.supabase\.co$/)?.[1];
    if (!project || supabase.protocol !== "https:" || supabase.port
      || url.hostname !== `db.${project}.supabase.co` || url.port && url.port !== "5432")
      throw new Error("Hosted Cron requires the direct database hostname matching SUPABASE_URL.");
    url.port = "5432";
  }
  // Pass decoded, explicit settings to TypeORM below; do not let PG* defaults
  // or a connection-string parser select a different endpoint.
  url.search = "";
  return url;
}

function localSystemIdentifier() {
  const config = readFileSync(resolve("supabase/config.toml"), "utf8");
  if (!/^project_id = "tennis-club"$/m.test(config)) throw new Error("Unexpected local Supabase project identity.");
  // Compare the connected server with this exact development container, so a
  // forwarded development port cannot silently point at the test database.
  return execFileSync("docker", ["exec", "supabase_db_tennis-club", "psql", "-U", "postgres", "-d", "postgres", "-Atc",
    "SELECT system_identifier::text FROM pg_control_system()"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10_000 }).trim();
}

export async function verifyTarget(client: Runner, url: URL, developmentIdentity: () => string = localSystemIdentifier) {
  const { rows } = await client.query(`SELECT current_database() AS database,current_user AS actor,
    EXISTS (SELECT 1 FROM pg_namespace WHERE nspname='auth') AND
    EXISTS (SELECT 1 FROM pg_namespace WHERE nspname='storage') AS supabase`);
  const identity = z.object({ database: z.literal("postgres"), actor: z.literal("postgres"), supabase: z.literal(true) }).safeParse(rows[0]);
  if (!identity.success) throw new Error("Cannot verify the intended Supabase database identity.");
  if (url.hostname === "127.0.0.1") {
    const expected = developmentIdentity();
    const result = await client.query("SELECT system_identifier::text AS id FROM pg_control_system()");
    if (!/^\d+$/.test(expected) || result.rows[0]?.id !== expected)
      throw new Error("Connected database is not the verified development Supabase project.");
  }
}

function endpoint() {
  const url = new URL(z.string().url("Set NOTIFICATION_CRON_URL to the full endpoint URL.").parse(process.env.NOTIFICATION_CRON_URL));
  const local = ["localhost", "127.0.0.1", "host.docker.internal"].includes(url.hostname) || /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(url.hostname);
  if (url.pathname !== "/api/notifications/deliver" || url.search || url.hash || url.username || url.password)
    throw new Error("NOTIFICATION_CRON_URL must be <origin>/api/notifications/deliver without query or credentials.");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local))
    throw new Error("NOTIFICATION_CRON_URL must use https outside local development.");
  // 127.0.0.1 inside the database container is the container itself, not your machine.
  if (["localhost", "127.0.0.1"].includes(url.hostname))
    console.warn("Warning: the database container cannot reach localhost on your machine; use host.docker.internal.");
  return url.href;
}

const secret = () => z.string().trim().min(32, "NOTIFICATION_CRON_SECRET must have at least 32 characters.")
  .parse(process.env.NOTIFICATION_CRON_SECRET ?? "");

async function upsertSecret(client: Runner, name: string, value: string, description: string) {
  const existing = await client.query("SELECT id FROM vault.secrets WHERE name=$1", [name]);
  if (existing.rows.length) await client.query("SELECT vault.update_secret($1, $2)", [existing.rows[0].id, value]);
  else await client.query("SELECT vault.create_secret($1, $2, $3)", [value, name, description]);
}

async function schedule(client: Runner) {
  const url = endpoint(), token = secret();
  await client.query("BEGIN");
  try {
    await client.query("CREATE EXTENSION IF NOT EXISTS pg_cron");
    await client.query("CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions");
    await upsertSecret(client, urlSecret, url, "Booking email retry endpoint called by pg_cron");
    await upsertSecret(client, tokenSecret, token, "Bearer secret for the booking email retry endpoint");
    // cron.schedule replaces an existing job with the same name.
    await client.query("SELECT cron.schedule($1, '*/5 * * * *', $2)", [jobName, command]);
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  console.log(`Scheduled ${jobName} every five minutes for ${new URL(url).origin}.`);
}

// One immediate request through the same Vault values; pg_net runs it in the background.
async function check(client: Runner) {
  const { rows } = await client.query(`${command} AS id`);
  const id = z.coerce.number().parse(rows[0]?.id);
  for (let waited = 0; waited < 70_000; waited += 1000) {
    const result = await client.query("SELECT status_code,timed_out,error_msg FROM net._http_response WHERE id=$1", [id]);
    if (result.rows.length) {
      const [{ status_code: status, timed_out: timedOut, error_msg: error }] = result.rows;
      console.log(status ? `Endpoint answered HTTP ${status} (200 expected).` : `No HTTP response (${timedOut ? "timed out" : error ?? "unknown error"}).`);
      process.exitCode = status === 200 ? 0 : 1;
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  console.log("pg_net has not completed the request yet; check net._http_response later.");
  process.exitCode = 1;
}

async function status(client: Runner) {
  const job = await client.query("SELECT jobid,schedule,active FROM cron.job WHERE jobname=$1", [jobName]);
  console.log(job.rows.length ? job.rows[0] : `${jobName} is not scheduled.`);
  if (!job.rows.length) return;
  const runs = await client.query(`SELECT status,start_time FROM cron.job_run_details WHERE jobid=$1
    ORDER BY start_time DESC LIMIT 5`, [job.rows[0].jobid]);
  const responses = await client.query(`SELECT status_code,timed_out,created FROM net._http_response ORDER BY created DESC LIMIT 5`);
  console.log("Recent runs:", runs.rows, "\nRecent pg_net responses:", responses.rows);
}

async function remove(client: Runner) {
  await client.query("BEGIN");
  try {
    await client.query("SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname=$1", [jobName]);
    await client.query("DELETE FROM vault.secrets WHERE name = ANY($1::text[])", [[urlSecret, tokenSecret]]);
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  console.log(`Removed ${jobName} and its Vault secrets.`);
}

async function main() {
  const url = target();
  // A plain connection with no entities: this configures infrastructure only.
  const database = new DataSource({ type: "postgres", host: url.hostname, port: Number(url.port), database: "postgres",
    username: "postgres", password: decodeURIComponent(url.password),
    ssl: url.hostname === "127.0.0.1" ? false : { rejectUnauthorized: true },
    entities: [], migrations: [], installExtensions: false, poolSize: 1 });
  console.log(`Target database ${url.hostname}:${url.port || 5432}${url.pathname}`);
  await database.initialize();
  const runner = database.createQueryRunner();
  const client: Runner = { query: async (sql, parameters) => ({ rows: await runner.query(sql, parameters) }) };
  try {
    await verifyTarget(client, url);
    if (process.argv.includes("--remove")) await remove(client);
    else if (process.argv.includes("--status")) await status(client);
    else if (process.argv.includes("--check")) await check(client);
    else await schedule(client);
  } finally { await runner.release(); await database.destroy(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch((error: unknown) => {
  // Never print connection strings or secret values.
  console.error(error instanceof z.ZodError ? error.issues.map(issue => issue.message).join("\n")
    : error instanceof Error ? error.message : "Notification cron configuration failed.");
  process.exitCode = 1;
});
