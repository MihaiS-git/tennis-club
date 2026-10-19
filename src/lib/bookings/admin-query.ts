import { z } from "zod";
import type { StatusTone } from "@/components/status-badge";
import { adminPaymentHref, adminTransactionHref, parseAdminPaymentQuery } from "@/lib/payments/admin-query";

// Existing customer booking lifecycle states; direct staff reservations are not bookings.
const bookingStatusSchema = z.enum(["confirmed", "pending_payment", "cancelled", "failed", "expired"]);
export type BookingStatus = z.infer<typeof bookingStatusSchema>;
export const bookingStatusLabels: Record<BookingStatus, string> = {
  confirmed: "Confirmed", pending_payment: "Payment pending", cancelled: "Cancelled", failed: "Failed", expired: "Expired",
};
export const bookingStatusTones: Record<BookingStatus, StatusTone> = {
  confirmed: "success", pending_payment: "warning", cancelled: "neutral", failed: "danger", expired: "neutral",
};
export const ADMIN_BOOKINGS_PAGE_SIZE = 20;

const optionalUuid = z.uuid().transform((value) => value.toLowerCase()).catch("");
const optionalDate = z.iso.date().catch("");

export function parseAdminBookingQuery(params: Record<string, string | string[] | undefined>) {
  const query = z.object({
    q: z.string().trim().max(200).catch(""),
    type: z.enum(["all", "court", "coaching"]).catch("all"),
    status: z.enum(["all", ...bookingStatusSchema.options]).catch("all"),
    location: optionalUuid, court: optionalUuid, coach: optionalUuid, from: optionalDate, to: optionalDate,
    sort: z.enum(["created", "scheduled"]).catch("created"),
    dir: z.enum(["asc", "desc"]).catch("desc"),
    page: z.string().regex(/^[1-9]\d*$/).transform(Number).pipe(z.number().max(1000000)).catch(1),
  }).parse(params);
  // Resource filters are meaningful only within their selected scope.
  return { ...query, court: query.location ? query.court : "", coach: query.type === "coaching" ? query.coach : "" };
}
export type AdminBookingQuery = ReturnType<typeof parseAdminBookingQuery>;

export function adminBookingQueryString(query: AdminBookingQuery, page = query.page) {
  const params = new URLSearchParams();
  if (query.q) params.set("q", query.q);
  if (query.type !== "all") params.set("type", query.type);
  if (query.type === "coaching" && query.coach) params.set("coach", query.coach);
  if (query.status !== "all") params.set("status", query.status);
  for (const key of ["location", "court", "from", "to"] as const) if (query[key]) params.set(key, query[key]);
  if (query.sort !== "created") params.set("sort", query.sort);
  if (query.dir !== "desc") params.set("dir", query.dir);
  if (page > 1) params.set("page", String(page));
  return params.toString();
}
export function adminBookingsHref(query: AdminBookingQuery, page = query.page) {
  const search = adminBookingQueryString(query, page);
  return `/admin/bookings${search ? `?${search}` : ""}`;
}
export function adminBookingHref(id: string, query: AdminBookingQuery) {
  const search = adminBookingQueryString(query);
  return `/admin/bookings/${id}${search ? `?${search}` : ""}`;
}

// Financial history paging is its own parameter; the list query (including the list
// page) is preserved so "Back to Bookings" returns to the same list position.
export function parseFinancialHistoryPage(params: Record<string, string | string[] | undefined>) {
  return z.string().regex(/^[1-9]\d*$/).transform(Number).pipe(z.number().max(1000000)).catch(1).parse(params.history);
}
export function adminBookingHistoryHref(id: string, query: AdminBookingQuery, historyPage: number, back?: string) {
  const params = new URLSearchParams(adminBookingQueryString(query));
  if (back) params.set("back", back);
  if (historyPage > 1) params.set("history", String(historyPage));
  const search = params.toString();
  return `/admin/bookings/${id}${search ? `?${search}` : ""}#financial-history`;
}

// Booking details opened from another Admin page carry that page's own URL in
// "back" ("from" is already the list's date filter), so "Back" returns to the same
// filters and page. Short references are presentation only; links use the full UUID.
export function adminBookingLinkFrom(id: string, source: string) {
  return `/admin/bookings/${id}?${new URLSearchParams({ back: source })}`;
}

const transactionDetailPath = /^\/admin\/payments\/transactions\/(payment|refund|booking)\/([0-9a-f-]{36})$/i;
const bookingDetailPath = /^\/admin\/bookings\/([0-9a-f-]{36})$/i;

// A same-origin, path-only "back" value; anything else is ignored.
function internalReturn(params: Record<string, string | string[] | undefined>) {
  const back = params.back;
  if (typeof back !== "string" || !back.startsWith("/") || back.startsWith("//")) return null;
  let url: URL;
  try { url = new URL(back, "http://admin.invalid"); } catch { return null; }
  return url.origin === "http://admin.invalid" ? url : null;
}

// Only known Admin sources are accepted, and each is rebuilt from its own query
// parser, so "back" can never point outside these pages or carry arbitrary input.
export function parseAdminBookingReturn(params: Record<string, string | string[] | undefined>) {
  const url = internalReturn(params);
  if (!url) return null;
  const search = Object.fromEntries(url.searchParams);
  if (url.pathname === "/admin/payments/transactions")
    return { href: adminPaymentHref(parseAdminPaymentQuery(search)), label: "Back to Transactions" };
  const detail = transactionDetailPath.exec(url.pathname);
  const transactionId = detail && z.uuid().safeParse(detail[2]);
  if (detail && transactionId?.success) {
    const list = adminPaymentHref(parseAdminPaymentQuery(search)).split("?")[1];
    return { href: adminTransactionHref(detail[1] as "payment" | "refund" | "booking", transactionId.data, list), label: "Back to Transaction" };
  }
  return null;
}

// Transaction Details opened from a booking's Financial History carry that Booking
// Details view (list filters and page, history page and its own "back") in "back".
export function adminBookingTransactionHref(kind: "payment" | "refund" | "booking", transactionId: string, bookingId: string,
  query: AdminBookingQuery, historyPage: number, back?: string) {
  const booking = adminBookingHistoryHref(bookingId, query, historyPage, back).split("#")[0];
  return adminTransactionHref(kind, transactionId, new URLSearchParams({ back: booking }).toString());
}

// Accepted only for the transaction's own booking, and rebuilt from the booking
// parsers, so the restored Booking Details link carries no arbitrary input.
export function parseTransactionBookingReturn(params: Record<string, string | string[] | undefined>, bookingId: string) {
  const url = internalReturn(params);
  const detail = url && bookingDetailPath.exec(url.pathname);
  const id = detail && z.uuid().safeParse(detail[1]);
  if (!url || !id?.success || id.data.toLowerCase() !== bookingId.toLowerCase()) return null;
  const search = Object.fromEntries(url.searchParams);
  return adminBookingHistoryHref(bookingId, parseAdminBookingQuery(search), parseFinancialHistoryPage(search),
    parseAdminBookingReturn(search)?.href);
}

export function bookingCreatedLabel(value: string, timezone: string) {
  return new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: timezone }).format(new Date(value));
}
