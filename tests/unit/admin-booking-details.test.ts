import { beforeEach, expect, test, vi } from "vitest";

const { authorize, query } = vi.hoisted(() => ({ authorize: vi.fn(), query: vi.fn() }));
vi.mock("@/lib/admin/authorization", () => ({ requireActiveAdmin: authorize }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({}) }));
vi.mock("@/lib/db/data-source", () => ({ getDataSource: async () => ({ manager: { query } }) }));

import { getAdminBookingDetails } from "@/lib/bookings/admin-details";
import { listAdminUndeliveredNotifications } from "@/lib/notifications/admin-notifications";

const id = "ba000000-0000-4000-8000-000000000001";
const userId = "ba000000-0000-4000-8000-000000000002";
const booking = { id, status: "cancelled", booking_date: "2025-01-01", starts_at_minute: 600, ends_at_minute: 660,
  location_name: "Historical club", location_timezone: "Europe/Bucharest", court_name: "Old court",
  customer_name: "Guest", customer_email: "guest@example.test", customer_phone: "123456789", cancellation_notice_minutes: 1440,
  total_amount_minor: 5000, currency: "RON", payment_method: "online", account_user_id: null };

beforeEach(() => { vi.clearAllMocks(); authorize.mockResolvedValue({ userId, roles: ["admin"] }); query.mockResolvedValue([booking]); });

test("authorizes before reading booking details and propagates authorization failures", async () => {
  authorize.mockRejectedValue(new Error("Forbidden"));
  await expect(getAdminBookingDetails(id)).rejects.toThrow("Forbidden");
  await expect(listAdminUndeliveredNotifications()).rejects.toThrow("Forbidden");
  expect(query).not.toHaveBeenCalled();
});

test("rejects invalid IDs without reading and gracefully handles missing bookings", async () => {
  expect(await getAdminBookingDetails("ba000000")).toBeNull();
  expect(query).not.toHaveBeenCalled();
  query.mockResolvedValue([]);
  expect(await getAdminBookingDetails(id)).toBeNull();
});

test("reads historical and cancelled booking snapshots by full UUID without live resource restrictions", async () => {
  expect(await getAdminBookingDetails(id)).toEqual(booking);
  const [sql, args] = query.mock.calls[0];
  expect(args).toEqual([id]);
  expect(sql).toContain("v.id=b.current_revision_id AND v.booking_id=b.id");
  expect(sql).toContain("v.starts_at_minute,v.ends_at_minute");
  expect(sql).not.toMatch(/is_active|archived_at|clock_timestamp|b.status\s*=|UPDATE|INSERT|DELETE/);
  expect(authorize.mock.invocationCallOrder[0]).toBeLessThan(query.mock.invocationCallOrder[0]);
});

test("notification customer association uses the booking account and existing user, never recipient email", async () => {
  const notification = { id, booking_id: id, account_user_id: userId, recipient: "different@example.test", subject: "Booking cancelled",
    attempts: 8, last_error: "unavailable", important: false, state: "stopped", created_at: "2026-10-17T09:00:00Z", next_attempt_at: null };
  query.mockResolvedValueOnce([notification]).mockResolvedValueOnce([{ total: 1, unacknowledged_exceptions: 0 }]);
  const result = await listAdminUndeliveredNotifications();
  expect(result.rows[0].account_user_id).toBe(userId);
  const sql = query.mock.calls[0][0];
  expect(sql).toContain("JOIN public.users u ON u.id=b.account_user_id");
  expect(sql).toContain("b.id=booking_notification_deliveries.booking_id");
  expect(sql).not.toMatch(/u\.email|b\.customer_email/);
});

test("notification lists preserve guest and missing associations as null", async () => {
  query.mockResolvedValueOnce([{ id, booking_id: null, account_user_id: null, recipient: "guest@example.test", subject: "Booking confirmed",
    attempts: 8, last_error: "unavailable", important: false, state: "stopped", created_at: "2026-10-17T09:00:00Z", next_attempt_at: null }])
    .mockResolvedValueOnce([{ total: 1, unacknowledged_exceptions: 0 }]);
  expect((await listAdminUndeliveredNotifications()).rows[0]).toMatchObject({ booking_id: null, account_user_id: null });
});
