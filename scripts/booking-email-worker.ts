import { setTimeout } from "node:timers/promises";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import { createSmtpMailAdapter } from "../src/lib/mail/smtp.ts";
import { deliverNextBookingEmail } from "../src/lib/notifications/worker.ts";

const config = z.object({ url: z.url(), key: z.string().min(1) }).parse({
  url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SECRET_KEY,
});
const client = createClient(config.url, config.key, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});
const mail = createSmtpMailAdapter();
const once = process.argv.includes("--once");
let stopping = false;
process.on("SIGINT", () => { stopping = true; });
process.on("SIGTERM", () => { stopping = true; });
while (!stopping) {
  try {
    const processed = await deliverNextBookingEmail(client, mail);
    if (!processed && once) break;
    if (!processed) await setTimeout(2000);
  } catch {
    console.error("Booking email worker failed; delivery state remains durable.");
    if (once) { process.exitCode = 1; break; }
    await setTimeout(5000);
  }
}
