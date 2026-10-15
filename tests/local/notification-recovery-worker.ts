// Separate processes exercise durable state and database leases, with no real mail.
import { assertTestEnvironment } from "./environment.mjs";
import { registerHooks } from "node:module";
// Match the bundler's directory-index resolution in this standalone test process.
registerHooks({ resolve(specifier, context, nextResolve) {
  try { return nextResolve(specifier, context); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ERR_UNSUPPORTED_DIR_IMPORT"
      && "url" in error && typeof error.url === "string") return nextResolve(`${error.url}/index.ts`, context);
    throw error;
  }
} });
assertTestEnvironment();
process.env.BREVO_API_KEY = "simulated-brevo";
process.env.BOOKING_MAIL_FROM = "bookings@example.test";
const mode = process.argv[2];
globalThis.fetch = async (input, init) => {
  if (String(input) !== "https://api.brevo.com/v3/smtp/email") throw new Error("Unexpected network request");
  console.log(`BREVO ${String(init?.body)}`);
  if (mode === "crash") process.exit(86); // HTTP may have been accepted; no DB acknowledgement.
  await new Promise(resolve => setTimeout(resolve, 100));
  return new Response(null, { status: mode === "temporary" ? 503 : 201 });
};
const { getDataSource } = await import("../../src/lib/db/data-source");
try {
  if (mode === "scheduler") {
    process.env.NEXT_RUNTIME = "nodejs";
    process.env.PAYMENT_RECOVERY_INTERVAL_SECONDS = "3600";
    const { register } = await import("../../src/instrumentation");
    await register();
    // Keep the standalone process alive for the real boot timer, with no requests.
    await new Promise(resolve => setTimeout(resolve, 17_000));
  } else {
    const { deliverPendingBookingNotifications } = await import("../../src/lib/notifications/booking-delivery");
    console.log(JSON.stringify(await deliverPendingBookingNotifications(Date.now() + 10_000)));
  }
} finally {
  const database = await getDataSource();
  await database.destroy();
}
