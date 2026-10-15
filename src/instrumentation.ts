// Called once per Next.js server instance (`next start`, `next dev`). The
// payment recovery scheduler runs in the Node.js server process, independently
// of browser sessions, customers, Admins and webhook delivery.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.NEXT_PHASE === "phase-production-build") return;
  const { startPaymentRecoveryScheduler } = await import("./lib/payments/recovery-scheduler");
  startPaymentRecoveryScheduler();
}
