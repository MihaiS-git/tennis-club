import { createClient } from "@supabase/supabase-js";
import { beforeEach, expect, test, vi } from "vitest";
import type { CurrentAccount } from "@/lib/auth/account";

const { account, query, command } = vi.hoisted(() => ({ account: vi.fn(), query: vi.fn(), command: vi.fn() }));
vi.mock("@/lib/auth/account", () => ({ readCurrentAccount: account }));
vi.mock("@/lib/db/data-source", () => ({ getDataSource: async () => ({ manager: { query } }) }));
vi.mock("@/lib/reservations/commands", () => ({ editDirectReservationCommand: command }));
import { getAdminReservationEditDay } from "@/lib/reservations/service";

const id = (n: number) => `ca000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const now = new Date("2026-10-15T09:00:00Z"), date = "2026-10-15";
const token = "2026-10-01T12:00:00.123456+00:00";
const location = { id: id(1), name: "Club", timezone: "UTC", is_active: true, archived_at: null,
  courts: [{ id: id(3), name: "Court B", is_active: true }, { id: id(2), name: "Court A", is_active: true }] };
const target = { id: id(5), court_id: id(2), booking_date: date, starts_at_minute: 600, ends_at_minute: 660,
  reason: "Practice", status: "active", updated_at: token, created_at: token, created_by_user_id: id(6),
  cancelled_at: null, cancelled_by_user_id: null, hold_expires_at: null,
  court_name: "Court A", court_active: true, location_id: id(1), location_name: "Club",
  location_timezone: "UTC", location_active: true, archived_at: null };
const row = { court_id: id(3), starts_at_minute: 600, ends_at_minute: 660, status: "active", hold_expires_at: null };
const hours = { id: id(4), location_id: id(1), weekday: 3, opens_at_minute: 600, closes_at_minute: 840, created_at: token, updated_at: token };
const client = createClient("http://localhost:54321", "user-key", { auth: { persistSession: false } });
const load = (requestedDate = date) => getAdminReservationEditDay({ reservationId: target.id, date: requestedDate }, client, now);

beforeEach(() => {
  vi.clearAllMocks(); query.mockReset(); command.mockReset();
  account.mockResolvedValue({ state: "active", userId: id(6), roles: ["admin"] });
  query.mockImplementation(async (sql: string) => {
    if (sql.includes("r.id = $1")) return [target];
    if (sql.includes("court_reservations")) return [row];
    if (sql.includes("location_opening_hours")) return [hours];
    return [location];
  });
});

test.each<CurrentAccount>([
  { state: "unauthenticated" },
  { state: "active", userId: id(6), email: "member@example.test", roles: [] },
  { state: "suspended", userId: id(6), email: "admin@example.test", roles: ["admin"] },
])("rejects non-Admins before persistence: %j", async (state) => {
  account.mockResolvedValue(state);
  await expect(load()).rejects.toThrow();
  expect(query).not.toHaveBeenCalled(); expect(command).not.toHaveBeenCalled();
});

test("preserves current values, microsecond token, fixed location and court/occupancy order", async () => {
  const result = await load("2026-10-16");
  expect(account.mock.invocationCallOrder[0]).toBeLessThan(query.mock.invocationCallOrder[0]);
  expect(result.reservation).toEqual({ location_id: id(1), location_timezone: "UTC", court_id: id(2), booking_date: date,
    starts_at_minute: 600, ends_at_minute: 660, reason: "Practice", updated_at: token,
    occupancy: [{ court_id: id(3), starts_at_minute: 600, ends_at_minute: 660 }] });
  expect(result.day.courts.map((court) => court.court.id)).toEqual([id(3), id(2)]);
  expect(query.mock.calls[0][1]).toEqual([target.id, null]);
  expect(query.mock.calls[0][0]).toContain("NOT EXISTS(SELECT 1 FROM public.bookings");
  expect(query.mock.calls[0][0]).toContain("AND c.is_active");
  expect(query.mock.calls[1][1]).toEqual(["2026-10-16", id(1), target.id, 0, 1000]);
  expect(query.mock.calls.every(([sql]) => !/INSERT|UPDATE|DELETE/.test(sql))).toBe(true);
});

test("active/live held intervals block; equal and expired deadlines do not", async () => {
  query.mockImplementation(async (sql: string) => {
    if (sql.includes("r.id = $1")) return [target];
    if (sql.includes("court_reservations")) return [row,
      { ...row, starts_at_minute: 660, ends_at_minute: 720, status: "held", hold_expires_at: "2026-10-15T09:00:00.000001Z" },
      { ...row, status: "held", hold_expires_at: now.toISOString() },
      { ...row, status: "held", hold_expires_at: "2026-10-15T08:59:59Z" }];
    if (sql.includes("location_opening_hours")) return [hours];
    return [location];
  });
  const result = await load();
  expect(result.reservation.occupancy).toEqual([
    { court_id: id(3), starts_at_minute: 600, ends_at_minute: 660 },
    { court_id: id(3), starts_at_minute: 660, ends_at_minute: 720 },
  ]);
  expect(result.day.courts[0].cells).toEqual(["booked", "booked", "booked", "booked", "available", "available", "available", "available"]);
  expect(result.day.courts[1].cells.every((cell) => cell === "available")).toBe(true);
});

test.each([{ rows: [] }])("unavailable/malformed targets fail before occupancy: %j", async ({ rows }) => {
  query.mockResolvedValueOnce(rows);
  await expect(load()).rejects.toThrow("This reservation is no longer available to edit.");
  expect(query).toHaveBeenCalledTimes(1);
});
