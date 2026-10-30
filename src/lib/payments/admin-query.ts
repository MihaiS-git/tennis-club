import { z } from "zod";

export const paymentStatusSchema = z.enum([
  "pending",
  "pending_retry",
  "succeeded",
  "failed",
  "cancelled",
  "expired",
  "due",
  "voided",
]);
export const paymentStatusLabels = {
  pending: "Pending",
  pending_retry: "Confirming with Stripe",
  succeeded: "Paid",
  failed: "Failed",
  cancelled: "Cancelled",
  expired: "Expired",
  due: "Due",
  voided: "Not refunded · change abandoned",
};
export const paymentProviderLabels = { stripe: "Stripe", netopia: "NETOPIA" };
export const paymentMethodLabels = {
  online: "Online",
  pay_at_club: "Pay at club",
};
export function parseAdminPaymentQuery(
  params: Record<string, string | string[] | undefined>,
) {
  return z
    .object({
      status: z.enum(["all", ...paymentStatusSchema.options]).catch("all"),
      provider: z.enum(["all", "stripe", "netopia"]).catch("all"),
      method: z.enum(["all", "online", "pay_at_club"]).catch("all"),
      attention: z.enum(["all", "required"]).catch("all"),
      q: z.string().trim().max(200).catch(""),
      page: z
        .string()
        .regex(/^[1-9]\d*$/)
        .transform(Number)
        .pipe(z.number().max(1000000))
        .catch(1),
      sort: z.enum(["date", "amount", "payment"]).catch("date"),
      dir: z.enum(["asc", "desc"]).catch("desc"),
    })
    .parse(params);
}
export type AdminPaymentQuery = ReturnType<typeof parseAdminPaymentQuery>;
export function adminPaymentHref(query: AdminPaymentQuery, page = query.page) {
  return `/admin/payments/transactions?${new URLSearchParams({ ...query, page: String(page) })}`;
}

export function adminTransactionHref(kind: "payment" | "refund" | "booking", id: string, query?: string) {
  return `/admin/payments/transactions/${kind}/${id}${query ? `?${query}` : ""}`;
}
export function transactionTimestamp(value: string, timezone: string) {
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium", timeStyle: "medium", timeZone: timezone,
  }).format(new Date(value));
}
// Tone for the shared status badge: attention and failures first, then in-flight, then completed.
export function transactionStatusTone(t: Pick<import("./admin").AdminPaymentTransaction, "needsAttention" | "transaction_status">) {
  if (t.needsAttention || t.transaction_status === "failed") return "danger" as const;
  if (t.transaction_status === "pending" || t.transaction_status === "pending_retry") return "warning" as const;
  return t.transaction_status === "succeeded" ? "success" as const : "neutral" as const;
}

export function transactionStatusLabel(t: Pick<import("./admin").AdminPaymentTransaction,
  "transaction_kind" | "transaction_status" | "amount_minor" | "refunded_minor">) {
  if (!t.transaction_status) return "Unknown";
  if (t.transaction_kind === "refund") return t.transaction_status === "succeeded" ? "Completed" : paymentStatusLabels[t.transaction_status];
  const status = paymentStatusLabels[t.transaction_status];
  // A late capture keeps its ended attempt status; its verified compensation still shows.
  if (t.refunded_minor === 0) return status;
  return `${status} · ${t.refunded_minor >= t.amount_minor ? "Fully refunded" : "Partially refunded"}`;
}
