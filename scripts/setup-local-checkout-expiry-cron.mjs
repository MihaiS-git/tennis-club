// Run with `node --env-file=.env.local scripts/setup-local-checkout-expiry-cron.mjs`.
// Configures only this project's disposable local Supabase database.
import pg from "pg";

const databaseUrl = new URL(process.env.DATABASE_URL ?? "");
const supabaseUrl = process.env.SUPABASE_URL?.replace(/\/$/, "");
const cronUrl = process.env.CHECKOUT_EXPIRY_CRON_URL;
const secret = process.env.CHECKOUT_EXPIRY_CRON_SECRET?.trim();

if (process.env.NODE_ENV === "production"
  || !["http://127.0.0.1:54321", "http://localhost:54321"].includes(supabaseUrl)
  || !["127.0.0.1", "localhost"].includes(databaseUrl.hostname)
  || databaseUrl.port !== "54322" || databaseUrl.pathname !== "/postgres"
  || databaseUrl.username !== "postgres" || databaseUrl.search || databaseUrl.hash
  || cronUrl !== "http://host.docker.internal:3000/api/payments/holds/expire"
  || !secret || secret.length < 32) {
  throw new Error("Local checkout expiry Cron requires the local Supabase URLs and a 32-character secret.");
}

const client = new pg.Client({ connectionString: databaseUrl.href });
try {
  await client.connect();
  await client.query("BEGIN");
  await client.query("CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog");
  await client.query("CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions");
  for (const [name, value] of [
    ["tennis_club_checkout_expiry_cron_url", cronUrl],
    ["tennis_club_checkout_expiry_cron_secret", secret],
  ]) {
    const existing = await client.query("SELECT id FROM vault.secrets WHERE name=$1", [name]);
    if (existing.rows.length) {
      await client.query("SELECT vault.update_secret($1,$2)", [existing.rows[0].id, value]);
    } else {
      await client.query("SELECT vault.create_secret($1,$2)", [value, name]);
    }
  }
  const command = `SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='tennis_club_checkout_expiry_cron_url'),
    headers := jsonb_build_object('Content-Type','application/json',
      'Authorization','Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets
        WHERE name='tennis_club_checkout_expiry_cron_secret')),
    body := '{}'::jsonb, timeout_milliseconds := 25000
  )`;
  await client.query("SELECT cron.schedule($1,$2,$3)", ["tennis-club-checkout-hold-expiry", "*/5 * * * *", command]);
  await client.query("COMMIT");
  console.log("Local checkout hold expiry Cron is scheduled every five minutes.");
} catch {
  await client.query("ROLLBACK").catch(() => undefined);
  throw new Error("Local checkout expiry Cron setup failed; inspect local PostgreSQL availability and configuration.");
} finally {
  await client.end();
}
