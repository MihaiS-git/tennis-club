import { createClient } from "@supabase/supabase-js";
import { beforeEach, expect, test, vi } from "vitest";
import type { CurrentAccount } from "@/lib/auth/account";

const { account, query } = vi.hoisted(() => ({ account: vi.fn(), query: vi.fn() }));
vi.mock("@/lib/auth/account", () => ({ readCurrentAccount: account }));
vi.mock("@/lib/db/data-source", () => ({ getDataSource: async () => ({ manager: { query } }) }));
import { getReservationDay, readInternalOccupancy } from "@/lib/reservations/service";

const id = (n: number) => `ca000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const now = new Date("2026-10-15T09:00:00Z");
const date = "2026-10-15";
const location = { id: id(1), name: "Club", timezone: "UTC", courts: [{ id: id(2), name: "Court 1" }, { id: id(3), name: "Court 2" }] };
const client = createClient("http://localhost:54321", "user-key", { auth: { persistSession: false } });
const row = { court_id: id(2), starts_at_minute: 600, ends_at_minute: 660, status: "active", hold_expires_at: null };
const hours = { id: id(4), location_id: id(1), weekday: 3, opens_at_minute: 600, closes_at_minute: 840,
  created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z" };
let detailRows: unknown[] = [];
const common = { court_id: id(2), booking_date: date, starts_at_minute: 600, ends_at_minute: 660,
  cancellation_notice_minutes: null, total_amount_minor: null, currency: null, payment_facts: [] };
const direct = { ...common, kind: "reservation", id: id(5), reason: "Practice", created_by_user_id: id(6),
  creator_name: "Own Name", customer_name: null, customer_email: null, customer_phone: null };
const booking = { ...common, kind: "booking", id: id(7), starts_at_minute: 660, ends_at_minute: 720,
  reason: null, created_by_user_id: null, creator_name: null, customer_name: "Snapshot", customer_email: "snapshot@example.test",
  customer_phone: "123", cancellation_notice_minutes: 120, total_amount_minor: 9000, currency: "RON" };

beforeEach(() => {
  vi.clearAllMocks(); query.mockReset();
  account.mockResolvedValue({ state: "active", userId: id(6), roles: ["coach"] });
  query.mockImplementation(async (sql: string) => sql.includes(" AS kind") ? detailRows : sql.includes("location_opening_hours") ? [hours] : [row]);
  detailRows = [direct, booking];
});

test.each<CurrentAccount>([
  { state: "unauthenticated" },
  { state: "active", userId: id(6), email: "member@example.test", roles: [] },
  { state: "suspended", userId: id(6), email: "coach@example.test", roles: ["coach"] },
])("rejects non-staff before any read: %j", async (state) => {
  account.mockResolvedValue(state);
  await expect(getReservationDay(location, date, now, client)).rejects.toThrow();
  expect(query).not.toHaveBeenCalled();
});

test.each(["coach"])("authorizes %s before bounded exact-resource reads", async (role) => {
  account.mockResolvedValue({ state: "active", userId: id(6), roles: [role] });
  const result = await getReservationDay(location, date, now, client);
  expect(account).toHaveBeenCalledWith(client);
  expect(account.mock.invocationCallOrder[0]).toBeLessThan(query.mock.invocationCallOrder[0]);
  const [sql, args] = query.mock.calls.find(([sql]) => sql.includes("court_reservations"))!;
  expect(args).toEqual([date, [id(2), id(3)], null, 0, 1000]);
  expect(sql).toContain("r.status IN ('active', 'held')");
  expect(sql).toContain("AND c.is_active"); expect(sql).toContain("l.archived_at IS NULL");
  expect(sql).toContain("ORDER BY r.court_id, r.starts_at_minute, r.id");
  expect(sql).not.toMatch(/UPDATE|DELETE|INSERT/);
  expect(result.occupancy).toEqual([{ court_id: id(2), starts_at_minute: 600, ends_at_minute: 660 }]);
  expect(result.courts[0].cells.slice(0, 2)).toEqual(["booked", "booked"]);
  if (role === "coach") { expect(result.adminOccupancy).toEqual([]); }
});

test("includes live held rows with microseconds, excludes equal/expired/null deadlines and never writes", async () => {
  query.mockResolvedValue([
    row,
    { ...row, status: "held", starts_at_minute: 660, ends_at_minute: 720, hold_expires_at: "2026-10-15T09:00:00.000001Z" },
    { ...row, status: "held", hold_expires_at: now.toISOString() },
    { ...row, status: "held", hold_expires_at: "2026-10-15T08:59:59Z" },
    { ...row, status: "held", hold_expires_at: null },
  ]);
  expect(await readInternalOccupancy({ courtIds: [id(2)] }, date, now)).toEqual([
    { court_id: id(2), starts_at_minute: 600, ends_at_minute: 660 },
    { court_id: id(2), starts_at_minute: 660, ends_at_minute: 720 },
  ]);
  expect(query.mock.calls.every(([sql]) => !/UPDATE|DELETE|INSERT/.test(sql))).toBe(true);
});
