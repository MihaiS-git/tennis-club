import { expect, test } from "vitest";
import { adminNotificationHref, notificationTypes, notificationTypeSubject, parseAdminNotificationQuery } from "@/lib/notifications/admin-notification-query";

test("defaults to newest first on page 1 and rejects invalid or repeated parameters", () => {
  expect(parseAdminNotificationQuery({})).toEqual({ q: "", status: "all", type: "all", from: undefined, to: undefined, sort: "created", dir: "desc", page: 1 });
  expect(parseAdminNotificationQuery({ status: "delivered", type: "invented", sort: "subject", dir: "up", page: "0", from: "2026-13-01", q: ["a", "b"] }))
    .toEqual(parseAdminNotificationQuery({}));
  expect(parseAdminNotificationQuery({ q: "  ana  ", page: "4" })).toMatchObject({ q: "ana", page: 4 });
  // An inverted range is ignored rather than returning nothing.
  expect(parseAdminNotificationQuery({ from: "2026-10-05", to: "2026-10-01" })).toMatchObject({ from: undefined, to: undefined });
});

test("types are the existing booking email events, with shared subjects listed once", () => {
  expect(notificationTypes.map((type) => type.subject)).toEqual(["Booking confirmed", "Booking cancelled", "Booking rescheduled",
    "Booking cancellation not completed", "Booking change not completed", "Refund requires attention", "Payment received after checkout ended"]);
  expect(notificationTypeSubject("customer_cancelled")).toBe("Booking cancelled");
  expect(notificationTypeSubject("all")).toBeNull();
  expect(parseAdminNotificationQuery({ type: "admin_cancelled" }).type).toBe("all");
});

test("URLs omit defaults and keep every active parameter", () => {
  expect(adminNotificationHref(parseAdminNotificationQuery({}))).toBe("/admin/payments/notifications");
  const query = parseAdminNotificationQuery({ q: "a b", status: "retrying", type: "confirmed", from: "2026-10-01", to: "2026-10-02", sort: "next_retry", dir: "asc" });
  expect(adminNotificationHref(query, 2)).toBe("/admin/payments/notifications?q=a+b&status=retrying&type=confirmed&from=2026-10-01&to=2026-10-02&sort=next_retry&dir=asc&page=2");
  expect(parseAdminNotificationQuery(Object.fromEntries(new URL(adminNotificationHref(query, 2), "http://x").searchParams))).toEqual({ ...query, page: 2 });
});
