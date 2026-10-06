import "server-only";
import { randomUUID } from "node:crypto";
import {
  commandFence,
  readBookingActor,
  readBookingContext,
} from "@/lib/bookings/persistence";
import {
  refundableLateCapture,
  refundRetryEligible,
  resolvableRefundEvents,
} from "./providers/stripe/refund-policy";
import { z } from "zod";
import { requireActiveAdmin } from "@/lib/admin/authorization";
import { createClient } from "@/lib/supabase/server";
import { createBookingWriter } from "@/lib/supabase/booking-writer";
import { logger } from "@/lib/logger";
import { processBookingRefund } from "./refunds";
import {
  listAdminPaymentTransactions,
  type AdminPaymentTransaction,
} from "./admin";
import { parseAdminPaymentQuery } from "./admin-query";

export type AdminRefundActionResult =
  | { ok: true; transaction: AdminPaymentTransaction; message: string }
  | { ok: false; message: string };
type Reader = Awaited<ReturnType<typeof createClient>>;
type Writer = ReturnType<typeof createBookingWriter>;

async function execute(
  kind: "retry" | "reconcile",
  id: unknown,
  reader?: Reader,
  writer?: Writer,
): Promise<AdminRefundActionResult> {
  const client = reader ?? (await createClient());
  const actor = await requireActiveAdmin(client);
  const parsed = (
    kind === "retry" ? z.uuid() : z.string().trim().min(1).max(255)
  ).safeParse(id);
  if (!parsed.success)
    return { ok: false, message: "Choose a valid payment record." };
  const persistence = writer ?? createBookingWriter();
  const source =
    kind === "retry"
      ? await persistence
          .from("payment_refunds")
          .select("booking_id")
          .eq("id", parsed.data)
          .maybeSingle()
      : await persistence
          .from("payment_provider_events")
          .select("attempt_id")
          .eq("provider", "stripe")
          .eq("event_id", parsed.data)
          .maybeSingle();
  if (source.error || !source.data)
    return {
      ok: false,
      message:
        "This payment is not eligible for this action. Refresh its details.",
    };
  let bookingId: string;
  if (kind === "retry")
    bookingId = z
      .object({ booking_id: z.uuid() })
      .parse(source.data).booking_id;
  else {
    const attemptId = z
      .object({ attempt_id: z.uuid() })
      .parse(source.data).attempt_id;
    const attempt = await persistence
      .from("payment_attempts")
      .select("booking_id")
      .eq("id", attemptId)
      .single();
    if (attempt.error) throw new Error("Payment evidence unavailable");
    bookingId = z
      .object({ booking_id: z.uuid() })
      .parse(attempt.data).booking_id;
  }
  let completed = false;
  for (let retry = 0; retry < 3; retry++) {
    const context = await readBookingContext(bookingId, persistence);
    if (!context) break;
    const event =
      kind === "reconcile"
        ? context.events.find(
            (e) => e.provider === "stripe" && e.event_id === parsed.data,
          )
        : null;
    const refund = context.refund;
    const payment = context.payments.find(
      (p) => p.id === (event?.attempt_id ?? refund?.payment_attempt_id),
    );
    if (
      !payment ||
      payment.provider !== "stripe" ||
      payment.method !== "online"
    )
      break;
    const late = context.events.some((e) =>
      refundableLateCapture(
        e,
        payment,
        context.booking.status,
        context.reservation.status,
      ),
    );
    if (
      !(
        payment.status === "succeeded" && context.booking.status === "cancelled"
      ) &&
      !late
    )
      break;
    if (
      event &&
      !refundableLateCapture(
        event,
        payment,
        context.booking.status,
        context.reservation.status,
      )
    )
      break;
    if (
      refund &&
      (refund.provider !== payment.provider ||
        refund.payment_attempt_id !== payment.id ||
        refund.provider_payment_id !== payment.provider_payment_id ||
        refund.amount_minor !== payment.amount_minor ||
        refund.currency !== payment.currency)
    )
      break;
    if (kind === "retry" && refund?.status === "succeeded")
      return { ok: false, message: "This refund has already succeeded." };
    if (
      kind === "retry" &&
      (!refund ||
        refund.id !== parsed.data ||
        !refundRetryEligible(refund.status, refund.provider))
    )
      break;
    if (
      kind === "reconcile" &&
      (!event ||
        (!event.reconciliation_required && refund?.status !== "succeeded"))
    )
      break;
    if (
      refund?.admin_lease_until &&
      Date.parse(refund.admin_lease_until) > Date.parse(context.now)
    )
      return {
        ok: false,
        message: "Another refund request is in progress. Refresh shortly.",
      };
    const token = refund?.status === "succeeded" ? null : randomUUID();
    const actorFacts = await readBookingActor(actor.userId, persistence);
    const prepared = await persistence.rpc("claim_refund_command", {
      ...commandFence(context),
      p_actor: actor.userId,
      p_actor_expected: actorFacts,
      p_token: token,
      p_lease_seconds: 5 * 60,
      p_events:
        token === null ? resolvableRefundEvents(context, payment.id) : [],
      p_refund: refund
        ? null
        : {
            payment_attempt_id: payment.id,
            provider: payment.provider,
            provider_payment_id: payment.provider_payment_id,
            amount_minor: payment.amount_minor,
            currency: payment.currency,
          },
    });
    if (prepared.error?.code === "40001") continue;
    if (prepared.error) {
      logger.error(
        {
          event: "payments.admin_refund_prepare_failed",
          code: prepared.error.code,
        },
        "Admin refund preparation failed",
      );
      return {
        ok: false,
        message: "Unable to prepare this refund. Refresh and try again.",
      };
    }
    if (prepared.data?.outcome === "busy")
      return {
        ok: false,
        message: "Another refund request is in progress. Refresh shortly.",
      };
    const claim = z.object({ refund_id: z.uuid() }).parse(prepared.data);
    if (token)
      await processBookingRefund(claim.refund_id, persistence, {
        token,
        actorId: actor.userId,
        bookingId,
      });
    completed = true;
    break;
  }
  if (!completed)
    return {
      ok: false,
      message:
        "This payment is not eligible for this action. Refresh its details.",
    };
  // Always re-read authoritative detail data; do not turn an adapter response into UI truth.
  const page = await listAdminPaymentTransactions(
    parseAdminPaymentQuery({}),
    client,
    bookingId,
  );
  const transaction = page.rows.find((row) => row.booking_id === bookingId);
  if (!transaction)
    return {
      ok: false,
      message:
        "The refund request was handled, but its details could not be refreshed. Refresh the page.",
    };
  const status = transaction.refund?.status;
  const unresolved = transaction.reconciliation.some(
    (event) => event.reconciliation_required,
  );
  const resolved =
    transaction.reconciliation.some((event) => event.resolved_at !== null) &&
    !transaction.needsAttention;
  logger.info(
    {
      event: "payments.admin_refund_result",
      actorId: actor.userId,
      bookingId: bookingId,
      status,
      resolved,
    },
    "Admin Stripe refund operation completed",
  );
  return {
    ok: true,
    transaction,
    message:
      status === "succeeded"
        ? resolved
          ? "Full refund succeeded. Reconciliation resolved."
          : "Full refund succeeded."
        : status === "failed"
          ? "The refund failed. Review the refund error before retrying."
          : `The refund is awaiting completion or retry.${unresolved ? " Reconciliation remains unresolved." : ""}`,
  };
}
export async function retryAdminPaymentRefund(
  id: unknown,
  reader?: Reader,
  writer?: Writer,
) {
  return execute("retry", id, reader, writer);
}
export async function resolveAdminPaymentReconciliation(
  id: unknown,
  reader?: Reader,
  writer?: Writer,
) {
  return execute("reconcile", id, reader, writer);
}
