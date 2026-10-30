import "server-only";

import { z } from "zod";
import { readCurrentAccount } from "@/lib/auth/account";
import { logger } from "@/lib/logger";
import { createClient } from "@/lib/supabase/server";
import { getDataSource } from "@/lib/db/data-source";
import { findOwnedBookingRevision } from "@/lib/db/repositories/bookings.repository";
import { loadAdminTransactionContext } from "@/lib/db/repositories/payments.repository";
import { findPendingAdjustment } from "@/lib/db/repositories/booking-adjustments.repository";
import { summarizeReportedFinancials } from "@/lib/payments/financials";
import type { RefundReason } from "@/lib/payments/refund-context";
import { localStartInstant } from "@/lib/courts/local-time";
import { refundBackedAdjustment } from "./domain";
import type { OwnBookingPayment, OwnBookingPaymentOperation } from "./personal";

const refundLabels: Record<RefundReason, string> = {
  booking_cancellation: "Cancellation refund",
  booking_price_reduction: "Booking change refund",
  failed_adjustment_compensation: "Refund of unapplied change payment",
  late_capture_compensation: "Refund of late payment",
};

type Result = { ok: true; payment: OwnBookingPayment } | { ok: false; message: string };
const unavailable = { ok: false as const, message: "Payment details are unavailable. Try again." };

// Reuses the Admin reporting facts: paid money comes only from capture receipts
// and refunds count as refunded only with a verified successful execution.
export async function getOwnBookingPayment(id: unknown, client?: Awaited<ReturnType<typeof createClient>>, now = new Date()): Promise<Result> {
  const parsed = z.uuid().safeParse(id);
  if (!parsed.success) return unavailable;
  try {
    const account = await readCurrentAccount(client ?? await createClient());
    if (account.state !== "active") return { ok: false, message: "An active account is required." };
    const manager = (await getDataSource()).manager;
    const owned = await findOwnedBookingRevision(manager, parsed.data, account.userId);
    if (!owned) return unavailable;
    const { status, revision } = owned;
    const facts = await loadAdminTransactionContext(manager, { bookingIds: [parsed.data], revisionIds: [], adjustmentIds: [] });
    const financials = summarizeReportedFinancials(facts);
    const currency = revision.currency;
    const totals = financials.totals.find((total) => total.currency === currency);
    const operations: OwnBookingPaymentOperation[] = [];
    for (const payment of facts.payments) {
      // Pay-at-club requests are uncollected; they are never shown as money paid.
      if (payment.method !== "online" || payment.currency !== currency) continue;
      const label = payment.adjustmentId ? "Booking change payment" : "Booking payment";
      const captures = financials.captures.filter((capture) => capture.paymentAttemptId === payment.id && capture.currency === currency);
      for (const capture of captures) operations.push({ kind: "payment", label, amount: capture.amount, state: "completed",
        at: capture.firstObservedAt });
      // Cancelled or expired attempts moved no money and stay out of the customer view.
      if (!captures.length && (payment.status === "pending" || payment.status === "failed")) operations.push({ kind: "payment", label,
        amount: payment.amountMinor, state: payment.status, at: payment.createdAt.toISOString() });
    }
    for (const refund of financials.refunds) {
      // A voided obligation belongs to an abandoned change; no money moved.
      if (refund.status === "voided" || refund.currency !== currency || !refund.reason) continue;
      const state = refund.verified ? "completed" : refund.status === "failed" ? "failed" : "pending";
      operations.push({ kind: "refund", label: refundLabels[refund.reason], amount: refund.amount, state, at: refund.verifiedAt ?? refund.createdAt });
    }
    operations.sort((a, b) => (a.at ? Date.parse(a.at) : 0) - (b.at ? Date.parse(b.at) : 0));
    const paid = totals?.captured ?? 0;
    const refunded = totals?.refunded ?? 0;
    // A pending cancellation or reduction keeps the current total until its refunds
    // are verified. Partly completed refunds are not customer debt: measure the
    // balance against the total that the accepted change leaves.
    const pending = status === "confirmed" ? await findPendingAdjustment(manager, parsed.data) : null;
    const owed = pending && refundBackedAdjustment(pending)
      ? pending.kind === "cancellation" ? 0 : pending.newTotal : revision.totalAmountMinor;
    const balance = status === "confirmed" ? Math.max(0, owed - (paid - refunded)) : 0;
    const ended = Date.parse(localStartInstant(revision.timezone, revision.bookingDate, revision.endMinute)) <= now.getTime();
    const atClub = revision.paymentMethod === "pay_at_club";
    return { ok: true, payment: {
      method: revision.paymentMethod, currency, timezone: revision.timezone, total: revision.totalAmountMinor, paid, refunded,
      refundPending: operations.filter((item) => item.kind === "refund" && item.state === "pending").reduce((sum, item) => sum + item.amount, 0),
      // Club payments are not recorded online, so a past club booking shows no balance.
      dueAtClub: atClub && !ended ? balance : 0, outstanding: atClub ? 0 : balance,
      operations,
    } };
  } catch {
    logger.error({ event: "bookings.own_payment_read_failed" }, "Unable to load own booking payment details");
    return unavailable;
  }
}
