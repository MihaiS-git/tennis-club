// Run with `node --env-file=.env.local scripts/setup-local-notification-cron.mjs`.
// Configures only this project's disposable local Supabase database.
import pg from "pg";
import { z } from "zod";

const databaseUrl = new URL(process.env.DATABASE_URL ?? "");
const supabaseUrl = process.env.SUPABASE_URL?.replace(/\/$/, "");
const cronUrl = process.env.NOTIFICATION_CRON_URL;
const secret = process.env.NOTIFICATION_CRON_SECRET?.trim();
const cutoff = process.env.NOTIFICATION_DELIVERY_NOT_BEFORE?.trim();

if (process.env.NODE_ENV === "production" || process.env.NOTIFICATION_TEST_RUNNER === "1"
  || !["http://127.0.0.1:54321", "http://localhost:54321"].includes(supabaseUrl)
  || !["127.0.0.1", "localhost"].includes(databaseUrl.hostname)
  || databaseUrl.port !== "54322" || databaseUrl.pathname !== "/postgres"
  || databaseUrl.username !== "postgres" || databaseUrl.search || databaseUrl.hash
  || cronUrl !== "http://host.docker.internal:3000/api/notifications/deliver"
  || process.env.NOTIFICATION_EMAIL_MODE !== "live"
  || !secret || secret.length < 32
  || (cutoff && !z.iso.datetime({ offset: true }).safeParse(cutoff).success)) {
  throw new Error("Local notification Cron requires the local Supabase URLs, live mode, a 32-character secret, and a valid ISO timestamp if a cutoff is provided.");
}

const client = new pg.Client({ connectionString: databaseUrl.href });
try {
  await client.connect();
  await client.query("BEGIN");
  await client.query("CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog");
  await client.query("CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions");
  for (const [name, value] of [
    ["tennis_club_notification_cron_url", cronUrl],
    ["tennis_club_notification_cron_secret", secret],
  ]) {
    const existing = await client.query("SELECT id FROM vault.secrets WHERE name=$1", [name]);
    if (existing.rows.length) {
      await client.query("SELECT vault.update_secret($1,$2)", [existing.rows[0].id, value]);
    } else {
      await client.query("SELECT vault.create_secret($1,$2)", [value, name]);
    }
  }
  const command = `SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='tennis_club_notification_cron_url'),
    headers := jsonb_build_object('Content-Type','application/json',
      'Authorization','Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets
        WHERE name='tennis_club_notification_cron_secret')),
    body := '{}'::jsonb, timeout_milliseconds := 25000
  )`;
  await client.query("SELECT cron.schedule($1,$2,$3)", ["tennis-club-notification-delivery", "*/5 * * * *", command]);
  await client.query("COMMIT");
  console.log("Local notification delivery Cron is scheduled every five minutes.");
} catch {
  await client.query("ROLLBACK").catch(() => undefined);
  throw new Error("Local notification Cron setup failed; inspect local PostgreSQL availability and configuration.");
} finally {
  await client.end();
}
