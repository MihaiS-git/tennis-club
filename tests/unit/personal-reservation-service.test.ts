import { createClient } from "@supabase/supabase-js";
import { beforeEach, expect, test, vi } from "vitest";
import type { CurrentAccount } from "@/lib/auth/account";

const { account, query } = vi.hoisted(() => ({ account: vi.fn(), query: vi.fn() }));
vi.mock("@/lib/auth/account", () => ({ readCurrentAccount: account }));
vi.mock("@/lib/db/data-source", () => ({ getDataSource: async () => ({ manager: { query } }) }));
import { getOwnReservationEditDay } from "@/lib/reservations/personal-service";

const id = (n: number) => `ca000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const owner = id(1), other = id(2), locationId = id(20);
const now = new Date("2026-10-02T12:30:45Z");
const token = "2026-10-01T12:00:00.123456+00:00";
const row = { id: id(10), court_id: id(11), updated_at: token, created_at: token,
  booking_date: "2026-10-02", starts_at_minute: 900, ends_at_minute: 960, reason: "Practice", status: "active",
  created_by_user_id: owner, cancelled_at: null, cancelled_by_user_id: null, hold_expires_at: null,
  creator_name: "Ana Pop", cancelled_by_name: null, court_name: "Court 1", court_active: true,
  location_id: locationId, location_name: "Club", location_timezone: "Europe/Bucharest", location_active: true, archived_at: null };
const location = { id: locationId, name: "Club", timezone: "Europe/Bucharest", is_active: true, archived_at: null,
  courts: [{ id: row.court_id, name: "Court 1", is_active: true }] };
const hours = { id: other, location_id: locationId, weekday: 4, opens_at_minute: 900, closes_at_minute: 1200,
  created_at: token, updated_at: token };
const interval = { court_id: row.court_id, starts_at_minute: 960, ends_at_minute: 1020, status: "active", hold_expires_at: null };
const network = vi.fn<typeof fetch>();
const client = createClient("http://localhost:54321", "user-key", { auth: { persistSession: false }, global: { fetch: network } });

beforeEach(() => {
  vi.clearAllMocks(); query.mockReset();
  account.mockResolvedValue({ state: "active", userId: owner, roles: ["admin"] });
  query.mockResolvedValue([row]);
});

test.each<CurrentAccount>([
  { state: "active", userId: owner, email: "member@example.test", roles: [] },
  { state: "suspended", userId: owner, email: "staff@example.test", roles: ["coach"] },
])("rejects unauthorized accounts before persistence: %j", async (state) => {
  account.mockResolvedValue(state);
  await expect(getOwnReservationEditDay({ reservationId: row.id, date: row.booking_date }, client, now)).rejects.toThrow();
  expect(query).not.toHaveBeenCalled();
});

function prepareEdit(target: unknown = row, occupancy: unknown = [interval]) {
  query.mockImplementation(async (sql: string) => {
    if (sql.includes("r.id = $1")) return target === null ? [] : [target];
    if (sql.includes("court_reservations")) return occupancy;
    if (sql.includes("location_opening_hours")) return [hours];
    return [location];
  });
}
const editInput = { reservationId: row.id, date: row.booking_date };

test.each(["coach"])("own availability authorizes %s, scopes target to owner and excludes it from occupancy", async (role) => {
  account.mockResolvedValue({ state: "active", userId: owner, roles: [role] }); prepareEdit();
  const result = await getOwnReservationEditDay(editInput, client, now);
  expect(query.mock.calls[0][1]).toEqual([row.id, owner]);
  expect(query.mock.calls[0][0]).toContain("r.created_by_user_id = $2");
  expect(query.mock.calls[0][0]).toContain("NOT EXISTS(SELECT 1 FROM public.bookings");
  expect(query.mock.calls[1][1]).toEqual([row.booking_date, locationId, row.id, 0, 1000]);
  expect(result).toMatchObject({ date: row.booking_date, location: { id: locationId, name: "Club", timezone: "Europe/Bucharest" } });
  expect(result.day.courts[0].cells.slice(0, 4)).toEqual(["past", "available", "booked", "booked"]);
  expect(network).not.toHaveBeenCalled();
});

test.each([null, { ...row, id: other }])(
  "rejects missing/non-owned/finished target before occupancy: %j", async (target) => {
    prepareEdit(target);
    await expect(getOwnReservationEditDay(editInput, client, now)).rejects.toThrow("This reservation is no longer available to edit.");
    expect(query).toHaveBeenCalledTimes(1);
  });

test("own edit uses one now for precise hold expiry and returns generic intervals only", async () => {
  prepareEdit(row, [interval,
    { ...interval, status: "held", starts_at_minute: 1020, ends_at_minute: 1080, hold_expires_at: "2026-10-02T12:30:45.000001Z" },
    { ...interval, status: "held", hold_expires_at: now.toISOString() },
    { ...interval, status: "held", hold_expires_at: "2026-10-02T12:30:44Z" },
    { ...interval, status: "held", hold_expires_at: null },
  ]);
  const result = await getOwnReservationEditDay(editInput, client, now);
  expect(result.day.courts[0].cells).toEqual(["past", "available", "booked", "booked", "booked", "booked", "available", "available", "available", "available"]);
  expect(JSON.stringify(result)).not.toMatch(/created_by_user_id|hold_expires_at|reason|customer/);
});
