import { createClient } from "@supabase/supabase-js";
import { beforeEach, expect, test, vi } from "vitest";
import type { CurrentAccount } from "@/lib/auth/account";

const { account, writer } = vi.hoisted(() => ({ account: vi.fn(), writer: vi.fn() }));
vi.mock("@/lib/auth/account", () => ({ readCurrentAccount: account }));
vi.mock("@/lib/supabase/booking-writer", () => ({ createBookingWriter: writer }));
import { editDirectReservationAsAdmin, getAdminReservationEditDay } from "@/lib/reservations/service";

const id = (n: number) => `ca000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const now = new Date("2026-10-15T09:00:00Z");
const date = "2026-10-15";
const token = "2026-10-01T12:00:00.123456+00:00";
const location = { id: id(1), name: "Club", timezone: "UTC", is_active: true, archived_at: null,
  courts: [{ id: id(3), name: "Court B", is_active: true }, { id: id(2), name: "Court A", is_active: true }] };
const target = { id: id(5), court_id: id(2), booking_date: date,
  starts_at_minute: 600, ends_at_minute: 660, reason: "Practice", status: "active", updated_at: token,
  court: { location_id: id(1), is_active: true, location: { timezone: "UTC", is_active: true, archived_at: null } } };
const row = { court_id: id(3), starts_at_minute: 600, ends_at_minute: 660, status: "active", hold_expires_at: null,
  court: { is_active: true, location: { is_active: true, archived_at: null } } };
const hours = { id: id(4), location_id: id(1), weekday: 3, opens_at_minute: 600, closes_at_minute: 840,
  created_at: token, updated_at: token };
const fetchRead = vi.fn<typeof fetch>();
const fetchUser = vi.fn<typeof fetch>();
const client = createClient("http://localhost:54321", "user-key", {
  auth: { persistSession: false }, global: { fetch: fetchUser },
});
const load = (requestedDate = date) => getAdminReservationEditDay({ reservationId: target.id, date: requestedDate }, client, now);

beforeEach(() => {
  account.mockReset(); writer.mockReset(); fetchRead.mockReset(); fetchUser.mockReset();
  account.mockResolvedValue({ state: "active", userId: id(6), roles: ["admin"] });
  fetchRead.mockImplementation(async (input) => {
    const url = new URL(String(input));
    return Response.json(url.searchParams.get("id") === `eq.${target.id}` ? target : [row]);
  });
  fetchUser.mockImplementation(async (input) => Response.json(String(input).includes("location_opening_hours") ? [hours] : location));
  writer.mockReturnValue(createClient("http://localhost:54321", "server-key", {
    auth: { persistSession: false }, global: { fetch: fetchRead },
  }));
});

test.each<CurrentAccount>([
  { state: "unauthenticated" }, { state: "missing-profile" }, { state: "load-error" },
  { state: "active", userId: id(6), email: "member@example.test", roles: [] },
  { state: "active", userId: id(6), email: "coach@example.test", roles: ["coach"] },
  { state: "suspended", userId: id(6), email: "admin@example.test", roles: ["admin"] },
])("rejects non-Admins before privileged reads: %j", async (state) => {
  account.mockResolvedValue(state);
  await expect(load()).rejects.toThrow();
  expect(writer).not.toHaveBeenCalled();
  expect(fetchRead).not.toHaveBeenCalled();
  expect(fetchUser).not.toHaveBeenCalled();
});

test("preserves current values, exact stale token, fixed location and court/occupancy order", async () => {
  const result = await load("2026-10-16");
  expect(account.mock.invocationCallOrder[0]).toBeLessThan(writer.mock.invocationCallOrder[0]);
  expect(result.date).toBe("2026-10-16");
  expect(result.location).toEqual({ id: id(1), name: "Club", timezone: "UTC" });
  expect(result.reservation).toEqual({ location_id: id(1), location_timezone: "UTC", court_id: id(2),
    booking_date: date, starts_at_minute: 600, ends_at_minute: 660, reason: "Practice", updated_at: token,
    occupancy: [{ court_id: id(3), starts_at_minute: 600, ends_at_minute: 660 }] });
  expect(result.day.courts.map((court) => court.court.id)).toEqual([id(3), id(2)]);
  const urls = fetchRead.mock.calls.map(([input]) => new URL(String(input)));
  expect(Object.fromEntries(urls[0].searchParams)).toMatchObject({ id: `eq.${target.id}`, status: "eq.active",
    "court.is_active": "eq.true", "court.location.is_active": "eq.true", "court.location.archived_at": "is.null", booking: "is.null" });
  expect(urls[0].searchParams.get("select")).toBe("id,court_id,booking_date,starts_at_minute,ends_at_minute,reason,status,updated_at,court:courts!inner(location_id,is_active,location:locations!inner(timezone,is_active,archived_at)),booking:bookings(reservation_id)");
  expect(Object.fromEntries(urls[1].searchParams)).toMatchObject({ id: `neq.${target.id}`, booking_date: "eq.2026-10-16",
    "court.location_id": `eq.${id(1)}`, status: "in.(active,held)", order: "court_id.asc,starts_at_minute.asc,id.asc" });
  expect(fetchRead.mock.calls.every(([, init]) => init?.method === "GET")).toBe(true);
});

test("active and live held intervals block; equal/expired deadlines do not block", async () => {
  fetchRead.mockResolvedValueOnce(Response.json(target)).mockResolvedValueOnce(Response.json([
    row,
    { ...row, starts_at_minute: 660, ends_at_minute: 720, status: "held", hold_expires_at: "2026-10-15T09:00:00.000001Z" },
    { ...row, starts_at_minute: 720, ends_at_minute: 780, status: "held", hold_expires_at: now.toISOString() },
    { ...row, starts_at_minute: 780, ends_at_minute: 840, status: "held", hold_expires_at: "2026-10-15T08:59:59Z" },
  ]));
  const result = await load();
  expect(result.reservation.occupancy).toEqual([
    { court_id: id(3), starts_at_minute: 600, ends_at_minute: 660 },
    { court_id: id(3), starts_at_minute: 660, ends_at_minute: 720 },
  ]);
  expect(result.day.courts[0].cells).toEqual(["booked", "booked", "booked", "booked", "available", "available", "available", "available"]);
  expect(result.day.courts[1].cells.every((cell) => cell === "available")).toBe(true);
});

test.each([null, { ...target, status: "cancelled" }, { id: target.id }])("unavailable target fails before occupancy: %j", async (data) => {
  fetchRead.mockResolvedValueOnce(Response.json(data));
  await expect(load()).rejects.toThrow("This reservation is no longer available to edit.");
  expect(fetchRead).toHaveBeenCalledTimes(1);
});

test("read failures retain safe edit-context errors", async () => {
  fetchRead.mockResolvedValueOnce(Response.json({ code: "42501", message: "private" }, { status: 403 }));
  await expect(load()).rejects.toThrow("This reservation is no longer available to edit.");
});

test("reason-only saves pass the original token to the unchanged edit command and honor its stale result", async () => {
  fetchUser.mockResolvedValue(Response.json("stale"));
  const result = await editDirectReservationAsAdmin({ id: target.id, expectedUpdatedAt: token, kind: "reason", reason: "Changed" }, client, now);
  expect(result).toMatchObject({ ok: false, stale: true });
  expect(new URL(String(fetchUser.mock.calls[0][0])).pathname).toBe("/rest/v1/rpc/edit_admin_court_reservation");
  expect(JSON.parse(String(fetchUser.mock.calls[0][1]?.body))).toEqual({ p_id: target.id, p_expected_updated_at: token,
    p_reason: "Changed", p_schedule: false, p_court_id: null, p_booking_date: null, p_starts_at_minute: null, p_ends_at_minute: null });
});
