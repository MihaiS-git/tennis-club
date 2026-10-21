import { beforeEach, expect, test, vi } from "vitest";

const { authorize, query } = vi.hoisted(() => ({ authorize: vi.fn(), query: vi.fn() }));
vi.mock("@/lib/admin/authorization", () => ({ requireActiveAdmin: authorize }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({}) }));
vi.mock("@/lib/db/data-source", () => ({ getDataSource: async () => ({ manager: { query } }) }));

import type { EntityManager } from "typeorm";
import { findAdminBookingDetails } from "@/lib/db/repositories/bookings.repository";

const id = "ba000000-0000-4000-8000-000000000001";
const userId = "ba000000-0000-4000-8000-000000000002";
const booking = { id, includes_coaching: false, coach_user_id: null, coach_name: null, coaching_program_name: null, coaching: null, status: "cancelled", booking_date: "2025-01-01", starts_at_minute: 600, ends_at_minute: 660,
  location_name: "Historical club", location_timezone: "Europe/Bucharest", court_name: "Old court",
  customer_name: "Guest", customer_email: "guest@example.test", customer_phone: "123456789", cancellation_notice_minutes: 1440,
  total_amount_minor: 5000, currency: "RON", payment_method: "online", account_user_id: null, created_at: "2024-12-20T09:30:00.123456+00:00" };

beforeEach(() => { vi.clearAllMocks(); authorize.mockResolvedValue({ userId, roles: ["admin"] }); query.mockResolvedValue([booking]); });

test("reads historical and cancelled booking snapshots by full UUID without live resource restrictions", async () => {
  const manager = { query } as unknown as EntityManager;
  expect(await findAdminBookingDetails(manager, id)).toEqual(booking);
  const [sql, args] = query.mock.calls[0];
  expect(args).toEqual([id]);
  expect(sql).toContain("v.id=b.current_revision_id AND v.booking_id=b.id");
  expect(sql).toContain("v.starts_at_minute,v.ends_at_minute");
  expect(sql).not.toMatch(/is_active|archived_at|clock_timestamp|b.status\s*=|UPDATE|INSERT|DELETE/);
  query.mockResolvedValue([]);
  expect(await findAdminBookingDetails(manager, id)).toBeNull();
});
