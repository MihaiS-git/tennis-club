import "server-only";

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { inTransaction } from "@/lib/db/transaction";
import { claimJobLease, releaseJobLease } from "@/lib/db/repositories/job-leases.repository";
import { logger } from "@/lib/logger";
import { runPaymentRecovery } from "./recovery";

// Entry point only: overlap fencing and timing. All financial decisions live in
// runPaymentRecovery and the commands it reuses.
const jobName = "payment_recovery";
// Longer than the run budget, so a live run is never taken over; a crashed
// process's lease expires and the next instance continues.
const leaseSeconds = 10 * 60;
const runBudgetMs = 4 * 60_000;
const defaultIntervalSeconds = 60;

function paymentRecoveryIntervalSeconds(env: Record<string, string | undefined> = process.env): number | null {
  const raw = env.PAYMENT_RECOVERY_INTERVAL_SECONDS?.trim();
  if (!raw) return defaultIntervalSeconds;
  if (raw === "0") return null;
  const parsed = z.coerce.number().int().min(15).max(3600).safeParse(raw);
  if (!parsed.success) {
    logger.warn({ event: "payments.recovery_interval_invalid" }, "Invalid PAYMENT_RECOVERY_INTERVAL_SECONDS; using the default");
    return defaultIntervalSeconds;
  }
  return parsed.data;
}

let running = false;
export async function runScheduledPaymentRecovery(): Promise<"completed" | "busy" | "failed"> {
  if (running) return "busy";
  running = true;
  const token = randomUUID();
  try {
    if (!await inTransaction(manager => claimJobLease(manager, { name: jobName, token, seconds: leaseSeconds }))) return "busy";
    try {
      const summary = await runPaymentRecovery({ budgetMs: runBudgetMs });
      logger.debug({ event: "payments.recovery_run", summary }, "Payment recovery run completed");
      return "completed";
    } finally {
      await inTransaction(manager => releaseJobLease(manager, { name: jobName, token }));
    }
  } catch {
    logger.error({ event: "payments.recovery_run_failed" }, "Payment recovery run failed; the next run retries");
    return "failed";
  } finally {
    running = false;
  }
}

// Survives development module reloads: one timer per server process.
const scheduler = globalThis as typeof globalThis & { __paymentRecoveryTimer?: ReturnType<typeof setInterval> };
export function startPaymentRecoveryScheduler() {
  if (scheduler.__paymentRecoveryTimer) return;
  const interval = paymentRecoveryIntervalSeconds();
  if (interval === null) {
    logger.warn({ event: "payments.recovery_disabled" }, "Automatic payment recovery is disabled by PAYMENT_RECOVERY_INTERVAL_SECONDS=0");
    return;
  }
  const tick = () => { void runScheduledPaymentRecovery(); };
  scheduler.__paymentRecoveryTimer = setInterval(tick, interval * 1000);
  scheduler.__paymentRecoveryTimer.unref();
  // Start soon after boot so work interrupted by a crash or deploy resumes.
  setTimeout(tick, 15_000).unref();
  logger.info({ event: "payments.recovery_started", intervalSeconds: interval }, "Automatic payment recovery scheduled");
}
