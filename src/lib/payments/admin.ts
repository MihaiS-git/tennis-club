import "server-only";
import { getDataSource } from "@/lib/db/data-source";
import { listAdminTransactionProjection } from "@/lib/db/repositories/payments.repository";
import { normalizeDatabaseError } from "@/lib/db/errors";
import { z } from "zod";
import { requireActiveAdmin } from "@/lib/admin/authorization";
import { createClient } from "@/lib/supabase/server";
import { logger } from "@/lib/logger";
import { locationCurrencies } from "@/lib/admin/locations-validation";
import { attentionRefundStatuses, paymentNeedsAttention, paymentMethodSchema, paymentProviderSchema } from "./domain";
import { paymentStatusSchema, parseAdminPaymentQuery, type AdminPaymentQuery } from "./admin-query";

import { paymentFactSchema, providerEventFactSchema } from "@/lib/payments/facts";
import { refundableLateCapture, refundRetryEligible } from "./providers/stripe/refund-policy";
const timestamp = z.iso.datetime({ offset: true });
const refundSchema = z.object({ id: z.uuid(), amount_minor: z.number().int().positive(), currency: z.enum(locationCurrencies),
  status: z.enum(["pending", "pending_retry", "succeeded", "failed"]), provider_refund_id: z.string().nullable(),
  requested_by_user_id: z.uuid().nullable(), requested_by_name: z.string().nullable(),
  created_at: timestamp, updated_at: timestamp, last_error: z.string().nullable() });
const transactionSchema = z.object({ booking_id: z.uuid(), reservation_id: z.uuid(), customer_name: z.string(), customer_email: z.string(),
  amount_minor: z.number().int().positive(), currency: z.enum(locationCurrencies), method: paymentMethodSchema.nullable(),
  provider: paymentProviderSchema.nullable(), payment_status: paymentStatusSchema.nullable(), provider_payment_id: z.string().nullable(),
  created_at: timestamp, updated_at: timestamp, booking_date: z.iso.date(), starts_at_minute: z.number().int(), ends_at_minute: z.number().int(),
  court_name: z.string(), location_name: z.string(), location_timezone: z.string(), refund: refundSchema.nullable(),
  booking_status: z.string(), reservation_status: z.string(),
  reconciliation: z.array(providerEventFactSchema.extend({ provider: paymentProviderSchema, attempt: paymentFactSchema, received_at: timestamp })),
});
export type AdminPaymentTransaction = Omit<z.infer<typeof transactionSchema>, "reconciliation" | "booking_status" | "reservation_status"> & {
  reconciliation: (Omit<z.infer<typeof transactionSchema>["reconciliation"][number], "attempt" | "attempt_id" | "provider_payment_id" | "amount_minor" | "currency"> & { can_refund: boolean })[]; needsAttention: boolean; canRetryRefund: boolean };

export async function listAdminPaymentTransactions(query: AdminPaymentQuery,
  reader?: Awaited<ReturnType<typeof createClient>>, bookingId?: string) {
  const client = reader ?? await createClient();
  await requireActiveAdmin(client);
  const filters = parseAdminPaymentQuery({ ...query, page: String(query.page) });
  try {
    const data = await listAdminTransactionProjection((await getDataSource()).manager, {
      page: filters.page, status: filters.status, provider: filters.provider, method: filters.method,
      attention: filters.attention === "required", search: filters.q, sort: filters.sort, direction: filters.dir,
      attentionRefundStatuses, bookingId: bookingId ? z.uuid().parse(bookingId) : null,
    });
    const parsed = z.object({ rows: z.array(transactionSchema), page: z.number().int().positive(),
      total: z.number().int().nonnegative(), totalPages: z.number().int().positive() }).safeParse(data);
    if (!parsed.success) {
      logger.error({ event: "payments.admin_read_failed" }, "Admin payment read failed");
      throw new Error("Unable to load payment transactions. Try again.");
    }
    return { ...parsed.data, rows: parsed.data.rows.map((row): AdminPaymentTransaction => {
      const { booking_status, reservation_status, reconciliation, ...transaction } = row;
      return { ...transaction, canRetryRefund: refundRetryEligible(row.refund?.status, row.provider),
        reconciliation: reconciliation.map((event) => ({ event_id: event.event_id, provider: event.provider,
          outcome: event.outcome, settlement_result: event.settlement_result, received_at: event.received_at,
          resolved_at: event.resolved_at, resolved_by_user_id: event.resolved_by_user_id,
          reconciliation_required: event.reconciliation_required, can_refund: event.reconciliation_required
            && refundableLateCapture(event, event.attempt, booking_status, reservation_status) })),
        needsAttention: paymentNeedsAttention(row.refund?.status, reconciliation) };
    }) };
  } catch (error: unknown) {
    logger.error({ event: "payments.admin_read_failed", code: normalizeDatabaseError(error).sqlState }, "Database projection failed");
    throw new Error("Unable to load payment transactions. Try again.");
  }
}
