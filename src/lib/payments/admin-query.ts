import { z } from "zod";

export const paymentStatusSchema = z.enum([
  "pending",
  "succeeded",
  "failed",
  "cancelled",
  "expired",
  "due",
]);
export const paymentStatusLabels = {
  pending: "Pending",
  succeeded: "Paid",
  failed: "Failed",
  cancelled: "Cancelled",
  expired: "Expired",
  due: "Due",
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
  return `/admin/payments?${new URLSearchParams({ ...query, page: String(page) })}`;
}
