import "server-only";

import { getDataSource } from "@/lib/db/data-source";
import { listOverdueStripeCheckouts } from "@/lib/db/repositories/payments.repository";
import { logger } from "@/lib/logger";
import { checkOnlinePayment } from "./checkout";
import { expirePaymentHolds } from "./hold-expiry";

export async function cleanupScheduledCheckouts() {
  const expired = await expirePaymentHolds();
  // Discovery and provider calls run after expiry commits, with no DB locks
  // held over HTTP. Revisit unresolved attempts even on an otherwise idle sweep.
  const attempts = await listOverdueStripeCheckouts((await getDataSource()).manager, 5);
  await Promise.all(attempts.map(async ({ id }) => {
    try {
      // Existing locked authorization decisions and settlement own all state
      // changes. Never capture here; dismissal rechecks Stripe and preserves
      // processing payments, including a race with customer submission.
      await checkOnlinePayment(id, true);
    } catch {
      logger.error({ event: "payments.scheduled_checkout_check_failed", attemptId: id },
        "Checkout remains unresolved for a later sweep or Admin check");
    }
  }));
  return expired;
}
