import { z } from "zod";
import { bookingEmailSubjects } from "./booking-email-subjects";

export const inboxPageSize = 25;
export const inboxTypes = Object.keys(bookingEmailSubjects) as (keyof typeof bookingEmailSubjects)[];
export type InboxQuery = ReturnType<typeof parseInboxQuery>;
export function parseInboxQuery(input: Record<string, unknown> = {}) {
  return z.object({
    q: z.string().trim().max(200).catch(""),
    status: z.enum(["all", "unread", "read"]).catch("all"),
    type: z.enum(["all", ...inboxTypes]).catch("all"),
    sort: z.enum(["newest", "oldest"]).catch("newest"),
    page: z.coerce.number().int().min(1).max(1000000).catch(1),
  }).parse(input);
}
export function inboxHref(query: InboxQuery, patch: Partial<InboxQuery> = {}) {
  const next = { ...query, ...patch };
  const params = new URLSearchParams();
  if (next.q) params.set("q", next.q);
  if (next.status !== "all") params.set("status", next.status);
  if (next.type !== "all") params.set("type", next.type);
  if (next.sort !== "newest") params.set("sort", next.sort);
  if (next.page > 1) params.set("page", String(next.page));
  return `/my-activity/notifications${params.size ? `?${params}` : ""}`;
}
export const inboxTypeLabels: Record<keyof typeof bookingEmailSubjects, string> = {
  confirmed: "Confirmation", customer_cancelled: "Your cancellation", admin_cancelled: "Club cancellation",
  customer_rescheduled: "Reschedule", cancellation_failed: "Cancellation issue", modification_failed: "Change issue",
  refund_incomplete: "Refund issue", late_payment_refund: "Late payment",
};
