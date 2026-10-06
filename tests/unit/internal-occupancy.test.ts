import { createClient } from "@supabase/supabase-js";
import { beforeEach, expect, test, vi } from "vitest";
import type { CurrentAccount } from "@/lib/auth/account";

const { account, writer } = vi.hoisted(() => ({ account: vi.fn(), writer: vi.fn() }));
vi.mock("@/lib/auth/account", () => ({ readCurrentAccount: account }));
vi.mock("@/lib/supabase/booking-writer", () => ({ createBookingWriter: writer }));
import { getReservationDay, readInternalOccupancy } from "@/lib/reservations/service";

const id = (n: number) => `ca000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const now = new Date("2026-10-15T09:00:00Z");
const date = "2026-10-15";
const location = { id: id(1), name: "Club", timezone: "UTC", courts: [{ id: id(2), name: "Court 1" }, { id: id(3), name: "Court 2" }] };
const fetchRead = vi.fn<typeof fetch>();
const fetchUser = vi.fn<typeof fetch>();
const userClient = createClient("http://localhost:54321", "user-key", {
  auth: { persistSession: false }, global: { fetch: fetchUser },
});
const row = { court_id: id(2), starts_at_minute: 600, ends_at_minute: 660, status: "active", hold_expires_at: null,
  court: { is_active: true, location: { is_active: true, archived_at: null } } };
const hours = { id: id(4), location_id: id(1), weekday: 3, opens_at_minute: 600, closes_at_minute: 840,
  created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z" };
const detailCommon = { court_id: id(2), booking_date: date, starts_at_minute: 600, ends_at_minute: 660,
  cancellation_notice_minutes: null, total_amount_minor: null, currency: null, payment_facts: [] };
const direct = { ...detailCommon, kind: "reservation", id: id(5), reason: "Practice", created_by_user_id: id(6),
  creator_name: "Own Name", customer_name: null, customer_email: null, customer_phone: null };
const booking = { ...detailCommon, kind: "booking", id: id(7), starts_at_minute: 660, ends_at_minute: 720,
  reason: null, created_by_user_id: null, creator_name: null,
  customer_name: "Snapshot", customer_email: "snapshot@example.test", customer_phone: "123",
  cancellation_notice_minutes: 120, total_amount_minor: 9000, currency: "RON" };

beforeEach(() => {
  account.mockReset(); writer.mockReset(); fetchRead.mockReset(); fetchUser.mockReset();
  account.mockResolvedValue({ state: "active", userId: id(6), roles: ["coach"] });
  fetchRead.mockResolvedValue(Response.json([row]));
  fetchUser.mockImplementation(async (input) => Response.json(String(input).includes("/rpc/") ? [direct, booking] : [hours]));
  writer.mockReturnValue(createClient("http://localhost:54321", "server-key", {
    auth: { persistSession: false }, global: { fetch: fetchRead },
  }));
});

test.each<CurrentAccount>([
  { state: "unauthenticated" }, { state: "missing-profile" }, { state: "load-error" },
  { state: "active", userId: id(6), email: "member@example.test", roles: [] },
  { state: "suspended", userId: id(6), email: "coach@example.test", roles: ["coach"] },
])("rejects non-staff before any read: %j", async (state) => {
  account.mockResolvedValue(state);
  await expect(getReservationDay(location, date, now, userClient)).rejects.toThrow();
  expect(writer).not.toHaveBeenCalled();
  expect(fetchRead).not.toHaveBeenCalled();
  expect(fetchUser).not.toHaveBeenCalled();
});

test.each(["admin", "coach"])("authorizes %s before a bounded SELECT for exact courts/date/statuses", async (role) => {
  account.mockResolvedValue({ state: "active", userId: id(6), roles: [role] });
  const result = await getReservationDay(location, date, now, userClient);
  expect(account).toHaveBeenCalledWith(userClient);
  expect(account.mock.invocationCallOrder[0]).toBeLessThan(writer.mock.invocationCallOrder[0]);
  const url = new URL(String(fetchRead.mock.calls[0][0]));
  expect(url.pathname).toBe("/rest/v1/court_reservations");
  expect(Object.fromEntries(url.searchParams)).toMatchObject({
    court_id: `in.(${id(2)},${id(3)})`, booking_date: `eq.${date}`, status: "in.(active,held)",
    "court.is_active": "eq.true", "court.location.is_active": "eq.true", "court.location.archived_at": "is.null",
    order: "court_id.asc,starts_at_minute.asc,id.asc", offset: "0", limit: "1000",
  });
  expect(url.searchParams.get("select")).toBe("court_id,starts_at_minute,ends_at_minute,status,hold_expires_at,court:courts!inner(is_active,location:locations!inner(is_active,archived_at))");
  expect(result.occupancy).toEqual([{ court_id: id(2), starts_at_minute: 600, ends_at_minute: 660 }]);
  expect(result.courts[0].cells.slice(0, 2)).toEqual(["booked", "booked"]);
  if (role === "coach") {
    expect(result.adminOccupancy).toEqual([]);
    expect(fetchUser.mock.calls.every(([input]) => !String(input).includes("/rpc/"))).toBe(true);
  }
});

test("includes active and live held rows, excluding expired/equal deadlines with one now and no mutations", async () => {
  fetchRead.mockResolvedValue(Response.json([
    row,
    { ...row, status: "held", starts_at_minute: 660, ends_at_minute: 720, hold_expires_at: "2026-10-15T09:00:00.000001Z" },
    { ...row, status: "held", starts_at_minute: 720, ends_at_minute: 780, hold_expires_at: "2026-10-15T09:00:00Z" },
    { ...row, status: "held", starts_at_minute: 780, ends_at_minute: 840, hold_expires_at: "2026-10-15T08:59:59Z" },
  ]));
  const result = await getReservationDay(location, date, now, userClient);
  expect(result.occupancy).toEqual([
    { court_id: id(2), starts_at_minute: 600, ends_at_minute: 660 },
    { court_id: id(2), starts_at_minute: 660, ends_at_minute: 720 },
  ]);
  expect(result.courts[0].cells).toEqual(["booked", "booked", "booked", "booked", "available", "available", "available", "available"]);
  expect(fetchRead.mock.calls.every(([, init]) => init?.method === "GET")).toBe(true);
});

test("preserves Admin direct/booking detail shapes and their existing result order", async () => {
  account.mockResolvedValue({ state: "active", userId: id(6), roles: ["admin"] });
  fetchUser.mockImplementation(async (input) => Response.json(String(input).includes("/rpc/") ? [booking, direct] : [hours]));
  const result = await getReservationDay(location, date, now, userClient);
  expect(result.adminOccupancy).toEqual([
    { kind: "booking", id: id(7), court_id: id(2), booking_date: date, starts_at_minute: 660, ends_at_minute: 720,
      customer_name: "Snapshot", customer_email: "snapshot@example.test", customer_phone: "123",
      cancellation_notice_minutes: 120, total_amount_minor: 9000, currency: "RON", stripe_refund_available: false },
    { kind: "reservation", id: id(5), court_id: id(2), booking_date: date, starts_at_minute: 600, ends_at_minute: 660,
      reason: "Practice", created_by_user_id: id(6), creator_name: "Own Name" },
  ]);
});

test("reads additional bounded batches without losing occupancy beyond the PostgREST cap", async () => {
  fetchRead.mockResolvedValueOnce(Response.json(Array.from({ length: 1000 }, () => row)))
    .mockResolvedValueOnce(Response.json([{ ...row, court_id: id(3), starts_at_minute: 660, ends_at_minute: 720 }]));
  const result = await getReservationDay(location, date, now, userClient);
  expect(result.occupancy).toHaveLength(1001);
  expect(result.occupancy.at(-1)).toEqual({ court_id: id(3), starts_at_minute: 660, ends_at_minute: 720 });
  expect(result.courts[1].cells.slice(2, 4)).toEqual(["booked", "booked"]);
  const urls = fetchRead.mock.calls.map(([input]) => new URL(String(input)));
  expect(urls.map((url) => [url.searchParams.get("offset"), url.searchParams.get("limit")])).toEqual([["0", "1000"], ["1000", "1000"]]);
  expect(urls.every((url) => url.searchParams.get("booking_date") === `eq.${date}`
    && url.searchParams.get("court_id") === `in.(${id(2)},${id(3)})`)).toBe(true);
});

test("an empty court scope performs no privileged read", async () => {
  expect((await getReservationDay({ ...location, courts: [] }, date, now, userClient)).occupancy).toEqual([]);
  expect(writer).not.toHaveBeenCalled();
});

test.each([{ data: [{ court_id: id(2) }], status: 200 },
  { data: { code: "42501", message: "private details" }, status: 403 }])("maps invalid results/errors safely", async ({ data, status }) => {
  fetchRead.mockResolvedValue(Response.json(data, { status }));
  await expect(getReservationDay(location, date, now, userClient)).rejects.toThrow("Unable to load court availability.");
});


test("edit occupancy excludes the edited ID across bounded location/date batches and preserves interval projection/order", async () => {
  const excludedId = id(8);
  const second = { ...row, court_id: id(3), starts_at_minute: 660, ends_at_minute: 720 };
  fetchRead.mockResolvedValueOnce(Response.json(Array.from({ length: 1000 }, () => row)))
    .mockResolvedValueOnce(Response.json([second]));
  const occupancy = await readInternalOccupancy({ locationId: location.id }, date, now, excludedId);
  expect(occupancy).toHaveLength(1001);
  expect(occupancy[0]).toEqual({ court_id: id(2), starts_at_minute: 600, ends_at_minute: 660 });
  expect(occupancy.at(-1)).toEqual({ court_id: id(3), starts_at_minute: 660, ends_at_minute: 720 });
  const urls = fetchRead.mock.calls.map(([input]) => new URL(String(input)));
  expect(urls.map((url) => url.searchParams.get("offset"))).toEqual(["0", "1000"]);
  for (const url of urls) {
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      "court.location_id": `eq.${location.id}`, booking_date: `eq.${date}`, id: `neq.${excludedId}`,
      status: "in.(active,held)", "court.is_active": "eq.true", "court.location.is_active": "eq.true",
      "court.location.archived_at": "is.null", order: "court_id.asc,starts_at_minute.asc,id.asc", limit: "1000",
    });
  }
});
