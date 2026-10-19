import { z } from "zod";
import { bookingEmailSubjects } from "./booking-email-subjects";

// Admin notification times and creation-date filters use the club's timezone.
export const notificationTimezone = "Europe/Bucharest";

// Delivery states derived from the outbox columns:
// sending: a delivery holds the row's lease right now.
// queued: not attempted yet (or an attempt was interrupted before its outcome was recorded).
// retrying: the last attempt failed and an automatic retry is scheduled.
// stopped: automatic retries ended (permanent rejection or attempts exhausted); only a manual retry sends it.
// failed: Brevo accepted it but then reported it undeliverable (bounce, block, error); never resent automatically.
// Accepted rows awaiting Brevo's confirmation and confirmed deliveries are not listed.
export const notificationStates = ["queued", "sending", "retrying", "stopped", "failed"] as const;
export type NotificationState = typeof notificationStates[number];
export const notificationStateLabels: Record<NotificationState, string> = {
  queued: "Queued", sending: "Sending", retrying: "Retry scheduled", stopped: "Needs manual retry", failed: "Delivery failed",
};

// Notification types are the booking email events; events sharing a subject form one type.
const typeBySubject = new Map<string, string>();
for (const [kind, subject] of Object.entries(bookingEmailSubjects)) if (!typeBySubject.has(subject)) typeBySubject.set(subject, kind);
export const notificationTypes = [...typeBySubject].map(([subject, id]) => ({ id, subject }));

const sorts = ["created", "status", "attempts", "next_retry"] as const;
export function parseAdminNotificationQuery(params: Record<string, string | string[] | undefined>) {
  const query = z.object({
    q: z.string().trim().max(200).catch(""),
    status: z.enum(["all", ...notificationStates]).catch("all"),
    type: z.enum(["all", ...notificationTypes.map((type) => type.id)] as [string, ...string[]]).catch("all"),
    from: z.iso.date().catch("").transform((value) => value || undefined),
    to: z.iso.date().catch("").transform((value) => value || undefined),
    sort: z.enum(sorts).catch("created"),
    dir: z.enum(["asc", "desc"]).catch("desc"),
    page: z.string().regex(/^[1-9]\d*$/).transform(Number).pipe(z.number().max(10_000)).catch(1),
  }).parse(Object.fromEntries(Object.entries(params).map(([key, value]) => [key, Array.isArray(value) ? undefined : value])));
  if (query.from && query.to && query.from > query.to) { query.from = undefined; query.to = undefined; }
  return query;
}
export type AdminNotificationQuery = ReturnType<typeof parseAdminNotificationQuery>;

export function notificationTypeSubject(type: string) {
  return notificationTypes.find((entry) => entry.id === type)?.subject ?? null;
}

// Defaults are omitted, so the plain path is the unfiltered first page.
export function adminNotificationHref(query: AdminNotificationQuery, page = query.page) {
  const params = new URLSearchParams();
  if (query.q) params.set("q", query.q);
  if (query.status !== "all") params.set("status", query.status);
  if (query.type !== "all") params.set("type", query.type);
  if (query.from) params.set("from", query.from);
  if (query.to) params.set("to", query.to);
  if (query.sort !== "created" || query.dir !== "desc") { params.set("sort", query.sort); params.set("dir", query.dir); }
  if (page > 1) params.set("page", String(page));
  return `/admin/payments/notifications${params.size ? `?${params}` : ""}`;
}
