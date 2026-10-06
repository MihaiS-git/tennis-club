import { createClient } from "@supabase/supabase-js";
import { beforeEach, expect, test, vi } from "vitest";
import type { CurrentAccount } from "@/lib/auth/account";

const { account, writer } = vi.hoisted(() => ({ account: vi.fn(), writer: vi.fn() }));
vi.mock("@/lib/auth/account", () => ({ readCurrentAccount: account }));
vi.mock("@/lib/supabase/booking-writer", () => ({ createBookingWriter: writer }));
import { listOwnCourtHistory } from "@/lib/bookings/history-service";

const id = (value: number) => `ca000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const owner = id(1);
const now = new Date("2026-10-03T11:30:00Z");
const court = { name: "Court", location_id: id(2), location: { name: "Club", timezone: "Pacific/Kiritimati" } };
const interval = { booking_date: "2026-10-04", starts_at_minute: 0, ends_at_minute: 60, court };
const payments: { status: string }[] = [];
const booking = { id: id(10), account_user_id: owner, status: "confirmed", updated_at: "2026-10-03T11:00:00Z",
  customer_name: "Snapshot", customer_email: "snapshot@example.test", customer_phone: "123",
  cancellation_notice_minutes: 120, total_amount_minor: 9000, currency: "RON", payment_method: "pay_at_club",
  payments, reservation: { ...interval, status: "active" } };
type Name = { first_name: string | null; last_name: string | null } | null;
const reservation: typeof interval & {
  id: string; court_id: string; updated_at: string; reason: string | null; status: string;
  created_by_user_id: string; cancelled_at: string | null; creator: Name; canceller: Name;
} = { ...interval, id: id(20), court_id: id(3), updated_at: "2026-10-03T10:30:00Z",
  reason: "Training", status: "active", created_by_user_id: owner, cancelled_at: null,
  creator: { first_name: "Ada", last_name: "Lovelace" }, canceller: null };
const fetchRead = vi.fn<typeof fetch>();
const userClient = createClient("http://localhost:54321", "user-key", { auth: { persistSession: false } });

beforeEach(() => {
  account.mockReset(); writer.mockReset(); fetchRead.mockReset();
  account.mockResolvedValue({ state: "active", userId: owner, email: "member@example.test", roles: [] });
  fetchRead.mockResolvedValue(Response.json([]));
  writer.mockReturnValue(createClient("http://localhost:54321", "server-key", {
    auth: { persistSession: false }, global: { fetch: fetchRead },
  }));
});

function reads(bookings: typeof booking[], reservations: typeof reservation[] = []) {
  fetchRead.mockImplementation(async (input) => {
    const url = new URL(String(input));
    const params = url.searchParams;
    let rows: (typeof booking | typeof reservation)[];
    if (url.pathname.endsWith("/bookings")) {
      rows = bookings.filter((row) => `eq.${row.status}` === params.get("status")
        && `eq.${row.account_user_id}` === params.get("account_user_id")
        && (params.get("reservation.status") !== "eq.active" || row.reservation.status === "active"));
      if (params.get("status") === "eq.cancelled") rows.sort((a, b) => b.updated_at.localeCompare(a.updated_at) || b.id.localeCompare(a.id));
      else rows.sort((a, b) => ("reservation" in b ? b.reservation.booking_date : b.booking_date)
        .localeCompare("reservation" in a ? a.reservation.booking_date : a.booking_date) || b.id.localeCompare(a.id));
    } else {
      rows = reservations.filter((row) => `eq.${row.status}` === params.get("status")
        && `eq.${row.created_by_user_id}` === params.get("created_by_user_id")
        && (!params.has("cancelled_at") || (params.get("cancelled_at") === "is.null" ? row.cancelled_at === null : row.cancelled_at !== null)));
      rows.sort((a, b) => {
        const value = (row: typeof a) => params.get("status") === "eq.active" ? ("reservation" in row ? row.reservation.booking_date : row.booking_date)
          : "cancelled_at" in row ? row.cancelled_at ?? row.updated_at : row.updated_at;
        return value(b).localeCompare(value(a)) || b.id.localeCompare(a.id);
      });
    }
    const offset = Number(params.get("offset"));
    return Response.json(rows.slice(offset, offset + Number(params.get("limit"))));
  });
}

test.each<CurrentAccount>([
  { state: "suspended", userId: owner, email: "member@example.test", roles: [] },
  { state: "unauthenticated" }, { state: "missing-profile" }, { state: "load-error" },
])("rejects unauthorized accounts before privileged reads: %j", async (state) => {
  account.mockResolvedValue(state);
  await expect(listOwnCourtHistory(1, userClient, now)).rejects.toThrow("An active account is required.");
  expect(writer).not.toHaveBeenCalled();
});

test.each([0, -1, 1.5, 1_000_001, NaN, Infinity])("rejects invalid page %s before privileged reads", async (page) => {
  await expect(listOwnCourtHistory(page, userClient, now)).rejects.toThrow("Choose a valid history page.");
  expect(writer).not.toHaveBeenCalled();
});

test("ordinary owners read only scoped booking candidates and classify with location time", async () => {
  const cancelled = { ...booking, id: id(11), status: "cancelled", reservation: { ...booking.reservation, booking_date: "2099-01-01", status: "cancelled" } };
  reads([booking, cancelled, { ...booking, id: id(12), account_user_id: id(9) },
    { ...booking, id: id(13), reservation: { ...booking.reservation, ends_at_minute: 120 } },
    { ...booking, id: id(14), reservation: { ...booking.reservation, status: "cancelled" } }], [reservation]);
  const result = await listOwnCourtHistory(1, userClient, now);
  expect(result.rows.map((row) => [row.id, row.history_at])).toEqual([[id(11), booking.updated_at], [id(10), "2026-10-03T11:00:00.000Z"]]);
  expect(result.rows[0]).toMatchObject({ customer_name: "Snapshot", customer_email: "snapshot@example.test", cancellation_notice_minutes: 120 });
  const urls = fetchRead.mock.calls.map(([input]) => new URL(String(input)));
  expect(urls).toHaveLength(2);
  expect(urls.every((url) => url.pathname.endsWith("/bookings") && url.searchParams.get("account_user_id") === `eq.${owner}`)).toBe(true);
  expect(urls[1].searchParams.get("reservation.status")).toBe("eq.active");
  expect(urls.every((url) => url.searchParams.get("limit") === "21")).toBe(true);
});

test.each(["admin", "coach"])("%s merges own bookings and reservations with exact instant/kind/ID order", async (role) => {
  account.mockResolvedValue({ state: "active", userId: owner, roles: [role] });
  reads([booking, { ...booking, id: id(11) }], [reservation, { ...reservation, id: id(21) },
    { ...reservation, id: id(22), created_by_user_id: id(9) },
    { ...reservation, id: id(23), ends_at_minute: 120 },
    { ...reservation, id: id(24), status: "cancelled", cancelled_at: "2026-10-03T12:00:00Z", canceller: { first_name: null, last_name: "Admin" } },
    { ...reservation, id: id(25), status: "cancelled", updated_at: "2026-10-03T12:30:00Z", creator: null }]);
  const result = await listOwnCourtHistory(1, userClient, now);
  expect(result.rows.map((row) => row.id)).toEqual([id(25), id(24), id(11), id(10), id(21), id(20)]);
  expect(result.rows[0]).toMatchObject({ history_at: "2026-10-03T12:30:00Z", creator_name: null });
  expect(result.rows[1]).toMatchObject({ history_at: "2026-10-03T12:00:00Z", creator_name: "Ada Lovelace", cancelled_by_name: "Admin" });
  const urls = fetchRead.mock.calls.map(([input]) => new URL(String(input)));
  expect(urls.filter((url) => url.pathname.endsWith("/court_reservations"))).toHaveLength(3);
  expect(urls.filter((url) => url.pathname.endsWith("/court_reservations")).every((url) => url.searchParams.get("created_by_user_id") === `eq.${owner}`)).toBe(true);
});

test("includes an end equal to now, resolves midnight and repeated DST time with the existing utility", async () => {
  reads([booking]);
  expect((await listOwnCourtHistory(1, userClient, new Date("2026-10-03T11:00:00Z"))).rows).toHaveLength(1);
  expect((await listOwnCourtHistory(1, userClient, new Date("2026-10-03T10:59:59Z"))).rows).toEqual([]);
  reads([{ ...booking, reservation: { ...booking.reservation, booking_date: "2026-10-25", ends_at_minute: 210,
    court: { ...court, location: { ...court.location, timezone: "Europe/Bucharest" } } } }]);
  expect((await listOwnCourtHistory(1, userClient, new Date("2026-10-25T01:00:00Z"))).rows).toEqual([]);
  expect((await listOwnCourtHistory(1, userClient, new Date("2026-10-25T01:30:00Z"))).rows[0].history_at).toBe("2026-10-25T01:30:00.000Z");
});

test("keeps the online successful-payment guard", async () => {
  reads([{ ...booking, payment_method: "online" }, { ...booking, id: id(11), payment_method: "online", payments: [{ status: "succeeded" }] }]);
  expect((await listOwnCourtHistory(1, userClient, now)).rows.map((row) => row.id)).toEqual([id(11)]);
});

test("pages the mixed result, uses row 21 for hasNext, and stops cancelled reads after enough candidates", async () => {
  account.mockResolvedValue({ state: "active", userId: owner, roles: ["admin"] });
  reads(Array.from({ length: 22 }, (_, i) => ({ ...booking, id: id(100 + i), status: "cancelled" })),
    Array.from({ length: 20 }, (_, i) => ({ ...reservation, id: id(200 + i), status: "cancelled", updated_at: booking.updated_at })));
  const first = await listOwnCourtHistory(1, userClient, now);
  expect(first.rows.map((row) => row.id)).toEqual(Array.from({ length: 20 }, (_, i) => id(121 - i)));
  expect(first.hasNext).toBe(true);
  const second = await listOwnCourtHistory(2, userClient, now);
  expect(second.rows.map((row) => row.id)).toEqual([id(101), id(100), ...Array.from({ length: 18 }, (_, i) => id(219 - i))]);
  expect(second.hasNext).toBe(true);
  expect(await listOwnCourtHistory(3, userClient, now)).toMatchObject({ rows: [expect.objectContaining({ id: id(201) }), expect.objectContaining({ id: id(200) })], hasNext: false });
  expect(await listOwnCourtHistory(1_000_000, userClient, now)).toMatchObject({ rows: [], hasNext: false });
  expect(fetchRead.mock.calls.every(([input]) => Number(new URL(String(input)).searchParams.get("limit")) <= 1000)).toBe(true);
});

test("reads through local-date overlap before stopping older completed candidates", async () => {
  const recent = Array.from({ length: 21 }, (_, i) => ({ ...booking, id: id(100 + i), reservation: { ...booking.reservation, booking_date: "2026-10-02" } }));
  const older = Array.from({ length: 21 }, (_, i) => ({ ...booking, id: id(200 + i), reservation: { ...booking.reservation, booking_date: "2026-09-29" } }));
  reads([...recent, ...older, ...older.map((row) => ({ ...row, id: id(Number(row.id.slice(-12)) + 100), reservation: { ...row.reservation, booking_date: "2026-09-01" } }))]);
  const result = await listOwnCourtHistory(1, userClient, now);
  expect(result.rows.map((row) => row.id)).toEqual(Array.from({ length: 20 }, (_, i) => id(120 - i)));
  const completed = fetchRead.mock.calls.map(([input]) => new URL(String(input))).filter((url) => url.searchParams.get("status") === "eq.confirmed");
  expect(completed.map((url) => url.searchParams.get("offset"))).toEqual(["0", "21"]);
});

test.each([[{ id: id(10) }], [{ ...booking, account_user_id: id(9) }]])("rejects malformed or incorrectly scoped SELECT results", async (data) => {
  fetchRead.mockResolvedValue(Response.json(data));
  await expect(listOwnCourtHistory(1, userClient, now)).rejects.toThrow("Unable to load your booking history.");
});

test("returns a safe error for failed database reads", async () => {
  fetchRead.mockResolvedValue(Response.json({ code: "42501", message: "private details" }, { status: 403 }));
  await expect(listOwnCourtHistory(1, userClient, now)).rejects.toThrow("Unable to load your booking history.");
});


test("orders completed rows by UTC end rather than local date across locations", async () => {
  reads([
    { ...booking, id: id(30), reservation: { ...booking.reservation, booking_date: "2026-10-04", ends_at_minute: 0 } },
    { ...booking, id: id(31), reservation: { ...booking.reservation, booking_date: "2026-10-03", ends_at_minute: 60,
      court: { ...court, location: { ...court.location, timezone: "Pacific/Honolulu" } } } },
    { ...booking, id: id(32), reservation: { ...booking.reservation, booking_date: "2026-10-03", ends_at_minute: 1440 } },
  ]);
  expect((await listOwnCourtHistory(1, userClient, now)).rows.map((row) => [row.id, row.history_at])).toEqual([
    [id(31), "2026-10-03T11:00:00.000Z"], [id(32), "2026-10-03T10:00:00.000Z"], [id(30), "2026-10-03T10:00:00.000Z"],
  ]);
});

test("preserves PostgreSQL submillisecond timestamp ordering before ID ties", async () => {
  reads([
    { ...booking, id: id(30), status: "cancelled", updated_at: "2026-10-03T11:00:00.123456+00:00" },
    { ...booking, id: id(31), status: "cancelled", updated_at: "2026-10-03T11:00:00.123455Z" },
  ]);
  expect((await listOwnCourtHistory(1, userClient, now)).rows.map((row) => row.id)).toEqual([id(30), id(31)]);
});


test("reads past the PostgREST row cap for a requested page without losing the 21st item", async () => {
  reads(Array.from({ length: 1021 }, (_, i) => ({ ...booking, id: id(100 + i), status: "cancelled" })));
  const result = await listOwnCourtHistory(51, userClient, now);
  expect(result.rows.map((row) => row.id)).toEqual(Array.from({ length: 20 }, (_, i) => id(120 - i)));
  expect(result.hasNext).toBe(true);
  const cancelled = fetchRead.mock.calls.map(([input]) => new URL(String(input)))
    .filter((url) => url.searchParams.get("status") === "eq.cancelled");
  expect(cancelled.map((url) => [url.searchParams.get("offset"), url.searchParams.get("limit")]))
    .toEqual([["0", "1000"], ["1000", "1000"]]);
});
