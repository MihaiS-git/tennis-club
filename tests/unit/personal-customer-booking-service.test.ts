import { createClient } from "@supabase/supabase-js";
import { beforeEach, expect, test, vi } from "vitest";
import type { CurrentAccount } from "@/lib/auth/account";

const { account, writer } = vi.hoisted(() => ({ account: vi.fn(), writer: vi.fn() }));
vi.mock("@/lib/auth/account", () => ({ readCurrentAccount: account }));
vi.mock("@/lib/supabase/booking-writer", () => ({ createBookingWriter: writer }));
import { listOwnUpcomingCustomerBookings } from "@/lib/bookings/personal-service";

const owner = "ca000000-0000-4000-8000-000000000001";
const now = new Date("2026-10-02T12:30:45Z");
const row = {
  id: "ca000000-0000-4000-8000-000000000010", customer_name: "Snapshot Name",
  customer_email: "snapshot@example.test", customer_phone: "+40 123",
  cancellation_notice_minutes: 120, total_amount_minor: 9000, currency: "RON",
  reservation: { booking_date: "2026-10-02", starts_at_minute: 900, ends_at_minute: 960,
    court: { name: "Court 1", location: { name: "Club", timezone: "Europe/Bucharest" } } },
};
const fetchRead = vi.fn<typeof fetch>();
const userClient = createClient("http://localhost:54321", "user-key", { auth: { persistSession: false } });

beforeEach(() => {
  account.mockReset(); writer.mockReset(); fetchRead.mockReset();
  account.mockResolvedValue({ state: "active", userId: owner, email: "member@example.test", roles: [] });
  fetchRead.mockResolvedValue(Response.json([row]));
  writer.mockReturnValue(createClient("http://localhost:54321", "server-key", {
    auth: { persistSession: false }, global: { fetch: fetchRead },
  }));
});

test.each([[], ["admin"], ["coach"]])("reads only the verified owner's confirmed, active bookings for roles %j", async (...roles) => {
  account.mockResolvedValue({ state: "active", userId: owner, roles });
  const result = await listOwnUpcomingCustomerBookings(userClient, now);
  expect(account).toHaveBeenCalledWith(userClient);
  const url = new URL(String(fetchRead.mock.calls[0][0]));
  expect(url.pathname).toBe("/rest/v1/bookings");
  expect(url.searchParams.get("account_user_id")).toBe(`eq.${owner}`);
  expect(url.searchParams.get("status")).toBe("eq.confirmed");
  expect(url.searchParams.get("reservation.status")).toBe("eq.active");
  expect(url.searchParams.get("order")).toBe("reservation(booking_date).asc,reservation(starts_at_minute).asc,id.asc");
  expect(url.searchParams.get("select")).toBe("id,customer_name,customer_email,customer_phone,cancellation_notice_minutes,total_amount_minor,currency,reservation:court_reservations!inner(booking_date,starts_at_minute,ends_at_minute,court:courts!inner(name,location:locations!inner(name,timezone)))");
  expect(result).toEqual([{
    id: row.id, customer_name: row.customer_name, customer_email: row.customer_email,
    customer_phone: row.customer_phone, cancellation_notice_minutes: 120, total_amount_minor: 9000, currency: "RON",
    booking_date: "2026-10-02", starts_at_minute: 900, ends_at_minute: 960,
    court_name: "Court 1", location_name: "Club", location_timezone: "Europe/Bucharest",
    starts_at_instant: "2026-10-02T12:00:00.000Z",
  }]);
});

test.each<CurrentAccount>([
  { state: "suspended", userId: owner, email: "member@example.test", roles: [] },
  { state: "unauthenticated" }, { state: "missing-profile" }, { state: "load-error" },
])("rejects unauthorized accounts before privileged access: %j", async (state) => {
  account.mockResolvedValue(state);
  await expect(listOwnUpcomingCustomerBookings(userClient, now)).rejects.toThrow("An active account is required.");
  expect(writer).not.toHaveBeenCalled();
  expect(fetchRead).not.toHaveBeenCalled();
});

function interval(id: string, date: string, start: number, end: number, timezone = "Europe/Bucharest") {
  return { ...row, id, reservation: { ...row.reservation, booking_date: date,
    starts_at_minute: start, ends_at_minute: end,
    court: { ...row.reservation.court, location: { ...row.reservation.court.location, timezone } } } };
}

test("filters past and finished same-day intervals with each location clock, preserving DB order and ID ties", async () => {
  const id = (suffix: string) => `ca000000-0000-4000-8000-0000000000${suffix}`;
  fetchRead.mockResolvedValue(Response.json([
    interval(id("30"), "2026-10-01", 900, 960),
    interval(id("31"), "2026-10-02", 540, 600, "America/New_York"),
    interval(id("32"), "2026-10-02", 840, 900),
    interval(id("33"), "2026-10-02", 870, 930),
    interval(id("34"), "2026-10-02", 900, 960),
    interval(id("35"), "2026-10-02", 900, 960),
    interval(id("36"), "2026-10-03", 0, 60),
  ]));
  expect((await listOwnUpcomingCustomerBookings(userClient, now)).map((booking) => booking.id))
    .toEqual([id("31"), id("34"), id("35"), id("36")]);
});

test("uses the location date across midnight rather than the UTC date", async () => {
  fetchRead.mockImplementation(async () => Response.json([interval(row.id, "2026-10-03", 0, 60)]));
  expect(await listOwnUpcomingCustomerBookings(userClient, new Date("2026-10-02T21:30:00Z"))).toHaveLength(1);
  expect(await listOwnUpcomingCustomerBookings(userClient, new Date("2026-10-02T22:00:00Z"))).toEqual([]);
});

test("reads beyond the PostgREST cap when finished rows fill the first page", async () => {
  fetchRead.mockResolvedValueOnce(Response.json(Array.from({ length: 1000 }, () => interval(row.id, "2026-10-01", 0, 60))))
    .mockResolvedValueOnce(Response.json([interval(row.id, "2026-10-03", 0, 60)]));
  expect((await listOwnUpcomingCustomerBookings(userClient, now)).map((booking) => booking.id)).toEqual([row.id]);
  const urls = fetchRead.mock.calls.map(([input]) => new URL(String(input)));
  expect(urls.map((url) => [url.searchParams.get("offset"), url.searchParams.get("limit")]))
    .toEqual([["0", "1000"], ["1000", "1000"]]);
  expect(urls.every((url) => url.searchParams.get("account_user_id") === `eq.${owner}`
    && url.searchParams.get("status") === "eq.confirmed" && url.searchParams.get("reservation.status") === "eq.active")).toBe(true);
});

test.each([[{ id: row.id }], [{ ...row, reservation: null }]])("rejects malformed SELECT results safely", async (data) => {
  fetchRead.mockResolvedValue(Response.json(data));
  await expect(listOwnUpcomingCustomerBookings(userClient, now)).rejects.toThrow("Unable to load your bookings.");
});

test("translates database errors into a safe application error", async () => {
  fetchRead.mockResolvedValue(Response.json({ code: "42501", message: "private details" }, { status: 403 }));
  await expect(listOwnUpcomingCustomerBookings(userClient, now)).rejects.toThrow("Unable to load your bookings.");
});
