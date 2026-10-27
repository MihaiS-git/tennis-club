import { z } from "zod";
import { createClient } from "@supabase/supabase-js";
import { beforeEach, expect, test, vi } from "vitest";
import type { CurrentAccount } from "@/lib/auth/account";
import { parseActivityQuery } from "@/lib/bookings/activity-query";
import { writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { createHash } from "node:crypto";
import { Session, type Profiler } from "node:inspector";
import * as localTime from "@/lib/courts/local-time";

const { account, dataSource, queryRead, ownedRevision } = vi.hoisted(() => ({ account: vi.fn(), dataSource: vi.fn(), queryRead: vi.fn(), ownedRevision: vi.fn() }));
vi.mock("@/lib/auth/account", () => ({ readCurrentAccount: account }));
vi.mock("@/lib/db/data-source", () => ({ getDataSource: dataSource }));
vi.mock("@/lib/db/repositories/bookings.repository", () => ({ findOwnedBookingRevision: ownedRevision }));
vi.mock("@/lib/db/repositories/booking-adjustments.repository", () => ({
  listBookingsWithLivePayment: vi.fn(async () => new Set<string>()),
  listBookingsWithPendingChange: vi.fn(async () => new Set<string>()),
}));
import { findOwnBookingActivityTarget, listOwnCourtActivity, listOwnUpcomingActivity } from "@/lib/bookings/activity-service";

const id = (n: number) => `ca000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const owner = id(1);
const now = new Date("2026-10-03T12:00:00Z");
const userClient = createClient("http://localhost:54321", "user-key", { auth: { persistSession: false } });
const interval = {
  court_id: id(2), status: "active", booking_date: "2026-10-03", starts_at_minute: 900, ends_at_minute: 960,
  court: { name: "Court A", location_id: id(3), location: { name: "Club A", timezone: "Europe/Bucharest" } },
};
const booking = {
  id: id(4), account_user_id: owner, status: "confirmed", updated_at: "2026-10-01T00:00:00Z",
  customer_name: "Snapshot", customer_email: "snapshot@example.test", customer_phone: "123", includes_coaching: false, coach_name: null, coaching_program_name: null,
  cancellation_notice_minutes: 120, total_amount_minor: 9000, currency: "RON",
  payment_method: "pay_at_club", reservation: interval,
};
const reservation = {
  ...interval, id: id(5), updated_at: "2026-10-01T00:00:00Z", reason: "Practice", created_by_user_id: owner,
  cancelled_at: null, creator: { first_name: "Own", last_name: "Name" }, canceller: null,
};
// Existing service-policy fixtures use a low-level SQL transport stub; real
// authorization/query visibility is covered by the integration suites.
function serve(bookings: unknown[], reservations: unknown[] = [], succeededIds: string[] = []) {
  const orderedBookings = z.array(z.object({ id: z.string() }).passthrough()).parse(bookings).sort((a, b) => a.id.localeCompare(b.id));
  const orderedReservations = z.array(z.object({ id: z.string() }).passthrough()).parse(reservations).sort((a, b) => a.id.localeCompare(b.id));
  queryRead.mockImplementation(async (sql: string, args: unknown[]) => {
    if (sql.includes("public.payment_attempts")) return succeededIds.map(booking_id => ({ booking_id }));
    const rows = args[1] === "cancelled" ? [] : sql.includes("public.bookings b") ? orderedBookings : orderedReservations;
    const remaining = args[4] ? rows.filter(row => row.id > String(args[4])) : rows;
    return remaining.slice(0, Number(args[3])).map((row) => ({ row }));
  });
}
beforeEach(() => {
  account.mockReset(); dataSource.mockReset(); queryRead.mockReset(); ownedRevision.mockReset();
  account.mockResolvedValue({ state: "active", userId: owner, roles: [] });
  dataSource.mockResolvedValue({ manager: { query: queryRead } });
  serve([booking], [reservation]);
});

test("booking deep-link lookup rejects invalid and foreign IDs before exposing details", async () => {
  expect(await findOwnBookingActivityTarget(undefined, owner, now)).toBeNull();
  expect(await findOwnBookingActivityTarget("not-a-uuid", owner, now)).toBeNull();
  expect(ownedRevision).not.toHaveBeenCalled();
  ownedRevision.mockResolvedValue(null);
  expect(await findOwnBookingActivityTarget(id(4), owner, now)).toBeNull();
  expect(ownedRevision).toHaveBeenCalledWith(expect.anything(), id(4), owner);
});

test("owner booking deep link uses the stored snapshot and opens the correct activity scope", async () => {
  const revision = { bookingDate: "2099-10-15", startMinute: 600, endMinute: 660,
    timezone: "Europe/Bucharest", locationName: "Club A", courtName: "Court A", customerName: "Snapshot",
    customerEmail: "snapshot@example.test", customerPhone: "123", coachUserId: null, coachName: null,
    coachingProgramName: null, cancellationNoticeMinutes: 120, totalAmountMinor: 9000, currency: "RON",
    recordedAt: now };
  ownedRevision.mockResolvedValue({ status: "confirmed", revision });
  const upcoming = await findOwnBookingActivityTarget(id(4), owner, now);
  expect(upcoming).toMatchObject({ scope: "upcoming", booking: { id: id(4), court_name: "Court A", total_amount_minor: 9000 } });
  ownedRevision.mockResolvedValue({ status: "cancelled", revision });
  const history = await findOwnBookingActivityTarget(id(4), owner, now);
  expect(history).toMatchObject({ scope: "history", booking: { id: id(4), status: "cancelled" } });
});

test.each<CurrentAccount>([
  { state: "unauthenticated" },
  { state: "suspended", userId: owner, email: "member@example.test", roles: [] },
])("authorizes before privileged access: %j", async (state) => {
  account.mockResolvedValue(state);
  await expect(listOwnCourtActivity("upcoming", parseActivityQuery({}, "upcoming"), userClient, now))
    .rejects.toThrow("An active account is required.");
  expect(dataSource).not.toHaveBeenCalled();
});

test.each([["admin"]])("preserves role-specific activity result contracts for roles %j", async (...roles) => {
  account.mockResolvedValue({ state: "active", userId: owner, roles });
  const result = await listOwnCourtActivity("upcoming", parseActivityQuery({}, "upcoming"), userClient, now);
  expect(account).toHaveBeenCalledWith(userClient);
  expect(result.rows.map((row) => row.kind)).toEqual(roles.length ? ["booking", "reservation"] : ["booking"]);
  expect(result.rows[0]).toEqual({
    kind: "booking", id: booking.id, court_id: id(2), location_id: id(3), status: "confirmed",
    booking_date: interval.booking_date, starts_at_minute: 900, ends_at_minute: 960,
    location_name: "Club A", location_timezone: "Europe/Bucharest", court_name: "Court A",
    starts_at_instant: "2026-10-03T12:00:00.000Z", history_at: "2026-10-03T13:00:00.000Z",
    customer_name: "Snapshot", customer_email: "snapshot@example.test", customer_phone: "123", includes_coaching: false, coach_name: null, coaching_program_name: null,
    cancellation_notice_minutes: 120, total_amount_minor: 9000, currency: "RON",
  });
});

test("merges before pagination, preserves kind/ID ties, and keeps options before filters", async () => {
  account.mockResolvedValue({ state: "active", userId: owner, roles: ["coach"] });
  serve(Array.from({ length: 21 }, (_, n) => ({ ...booking, id: id(20 - n + 100) })), [reservation]);
  const first = await listOwnCourtActivity("upcoming", parseActivityQuery({}, "upcoming"), userClient, now);
  const second = await listOwnCourtActivity("upcoming", parseActivityQuery({ page: "2" }, "upcoming"), userClient, now);
  expect(first.rows.map((row) => row.id)).toEqual(Array.from({ length: 20 }, (_, n) => id(100 + n)));
  expect(first.hasNext).toBe(true);
  expect(second.rows.map((row) => row.id)).toEqual([id(120), reservation.id]);
  expect(second.hasNext).toBe(false);
  const filtered = await listOwnCourtActivity("upcoming", parseActivityQuery({ type: "reservation", location: id(999) }, "upcoming"), userClient, now);
  expect(filtered.rows).toEqual([]);
  expect(filtered.locations).toEqual([{ id: id(3), name: "Club A" }]);
  expect(filtered.courts).toEqual([{ id: id(2), name: "Court A", location_id: id(3) }]);
});

test("ignores a court filter that does not belong to the selected location", async () => {
  serve([booking]);
  const all = await listOwnCourtActivity("upcoming", parseActivityQuery({ location: id(3) }, "upcoming"), userClient, now);
  expect(all.rows.map((row) => row.id)).toEqual([booking.id]);
  for (const court of [id(2), id(998)]) {
    const query = parseActivityQuery({ location: id(3), court }, "upcoming");
    expect((await listOwnCourtActivity("upcoming", query, userClient, now)).rows.map((row) => row.id)).toEqual([booking.id]);
  }
  const elsewhere = await listOwnCourtActivity("upcoming", { ...parseActivityQuery({ location: id(999) }, "upcoming"), court: id(2) }, userClient, now);
  expect(elsewhere.rows).toEqual([]);
  expect(elsewhere.courts).toEqual([{ id: id(2), name: "Court A", location_id: id(3) }]);
});

test("classifies exact ends using one instant across timezones and excludes unpaid online rows", async () => {
  serve([
    { ...booking, reservation: { ...interval, ends_at_minute: 900 } },
    { ...booking, id: id(6), reservation: { ...interval, court: { ...interval.court,
      location: { name: "New York", timezone: "America/New_York" } } } },
    { ...booking, id: id(7), payment_method: "online" },
    { ...booking, id: id(8), payment_method: "online" },
  ], [], [id(8)]);
  expect((await listOwnCourtActivity("upcoming", parseActivityQuery({}, "upcoming"), userClient, now)).rows.map((row) => row.id))
    .toEqual([id(8), id(6)]);
  const history = await listOwnCourtActivity("history", parseActivityQuery({}, "history"), userClient, now);
  expect(history.rows.map((row) => row.id)).toEqual([booking.id]);
  expect(history.rows[0].history_at).toBe(now.toISOString());
});

test("continues past the row cap, retaining global sort and filter options", async () => {
  queryRead.mockResolvedValueOnce(Array.from({ length: 1000 }, (_, n) => ({ row: { ...booking, id: id(n + 100) } })))
    .mockResolvedValueOnce([{ row: { ...booking, id: id(9), reservation: { ...interval, starts_at_minute: 870 } } }]);
  const result = await listOwnCourtActivity("upcoming", parseActivityQuery({}, "upcoming"), userClient, now);
  expect(result.rows[0].id).toBe(id(9));
  expect(result.hasNext).toBe(true);

});

test.each(["datetime", "duration"] as const)("preserves %s primary sorting and history datetime tie order", async (sort) => {
  account.mockResolvedValue({ state: "active", userId: owner, roles: ["admin"] });
  const earlier = { ...interval, booking_date: "2026-10-01", starts_at_minute: 0, ends_at_minute: 120,
    court: { ...interval.court, name: "Z", location: { name: "Z", timezone: "UTC" } } };
  const later = { ...interval, booking_date: "2026-10-02", starts_at_minute: 0, ends_at_minute: 60,
    court: { ...interval.court, name: "a", location: { name: "a", timezone: "UTC" } } };
  serve([{ ...booking, reservation: earlier }], [{ ...reservation, ...later }]);
  for (const direction of ["asc", "desc"] as const) {
    const result = await listOwnCourtActivity("history", parseActivityQuery({ sort, direction }, "history"), userClient, now);
    const asc = ["location", "court", "duration", "status"].includes(sort) ? [reservation.id, booking.id] : [booking.id, reservation.id];
    expect(result.rows.map((row) => row.id)).toEqual(direction === "asc" ? asc : [...asc].reverse());
  }
});

test("preserves cancellation snapshots and history filters", async () => {
  account.mockResolvedValue({ state: "active", userId: owner, roles: ["admin"] });
  queryRead.mockImplementation(async (sql: string, args: unknown[]) => {
    if (args[1] !== "cancelled") return [];
    return (sql.includes("public.bookings b") ? [{ ...booking, status: "cancelled" }]
      : [{ ...reservation, status: "cancelled", cancelled_at: "2026-10-02T00:00:00Z", canceller: { first_name: "Admin", last_name: null } }]).map((row) => ({ row }));
  });
  const query = parseActivityQuery({ status: "cancelled", type: "reservation", court: id(2), from: "2026-10-03", to: "2026-10-03" }, "history");
  const result = await listOwnCourtActivity("history", query, userClient, now);
  expect(result.rows).toMatchObject([{ id: reservation.id, history_at: "2026-10-02T00:00:00Z", creator_name: "Own Name", cancelled_by_name: "Admin" }]);
  expect(result.hasNext).toBe(false);
});

test.each([{ rows: [{ ...booking, account_user_id: id(99) }] }])("rejects malformed or mismatched owner results", async ({ rows }) => {
  serve(rows);
  await expect(listOwnCourtActivity("upcoming", parseActivityQuery({}, "upcoming"), userClient, now))
    .rejects.toThrow("Unable to load your court activity. Try again.");
});

test("maps database failures to a safe error", async () => {
  queryRead.mockRejectedValue(new Error("private database details"));
  await expect(listOwnCourtActivity("upcoming", parseActivityQuery({}, "upcoming"), userClient, now))
    .rejects.toThrow("Unable to load your court activity. Try again.");
});

test.each([null, undefined, "obsolete"])("rejects a booking without a valid contractual payment method: %j", async paymentMethod => {
  serve([{ ...booking, payment_method: paymentMethod }]);
  await expect(listOwnCourtActivity("upcoming", parseActivityQuery({}, "upcoming"), userClient, now))
    .rejects.toThrow("Unable to load your court activity. Try again.");
});

test("uses PostgreSQL-compatible DST disambiguation and end minute 1440", async () => {
  serve([{ ...booking, reservation: { ...interval, booking_date: "2026-10-25", starts_at_minute: 180, ends_at_minute: 210 } }]);
  const beforeEnd = await listOwnCourtActivity("upcoming", parseActivityQuery({}, "upcoming"), userClient, new Date("2026-10-25T01:00:00Z"));
  expect(beforeEnd.rows[0].starts_at_instant).toBe("2026-10-25T01:00:00.000Z");
  expect((await listOwnCourtActivity("upcoming", parseActivityQuery({}, "upcoming"), userClient, new Date("2026-10-25T01:30:00Z"))).rows).toEqual([]);
  const ended = await listOwnCourtActivity("history", parseActivityQuery({}, "history"), userClient, new Date("2026-10-25T01:30:00Z"));
  expect(ended.rows[0].history_at).toBe("2026-10-25T01:30:00.000Z");
  serve([{ ...booking, reservation: { ...interval, starts_at_minute: 1380, ends_at_minute: 1440 } }]);
  expect((await listOwnCourtActivity("upcoming", parseActivityQuery({}, "upcoming"), userClient, new Date("2026-10-03T20:59:59Z"))).rows).toHaveLength(1);
  expect((await listOwnCourtActivity("upcoming", parseActivityQuery({}, "upcoming"), userClient, new Date("2026-10-03T21:00:00Z"))).rows).toEqual([]);
});

test.each([
  ["Europe/Bucharest", "2026-03-29", "2026-03-29T00:59:59.999Z"],
  ["Europe/Bucharest", "2026-03-29", "2026-03-29T01:30:00Z"],
  ["Europe/Bucharest", "2026-10-25", "2026-10-25T00:30:00Z"],
  ["Europe/Bucharest", "2026-10-25", "2026-10-25T01:30:00Z"],
  ["America/New_York", "2026-11-01", "2026-11-01T05:30:00Z"],
  ["Australia/Lord_Howe", "2026-10-04", "2026-10-03T15:30:00Z"],
  ["Pacific/Apia", "2011-12-30", "2011-12-30T10:00:00Z"],
  ["Pacific/Kiritimati", "2026-10-03", "2026-10-03T10:00:00Z"],
  ["Etc/GMT+12", "2026-10-03", "2026-10-04T12:00:00Z"],
])("matches the original exact classification across mixed dates: %s at %s / %s", async (timezone, date, clock) => {
  const resolve = localTime.createLocalStartInstantResolver();
  const records = [-4, -1, 0, 1, 4].flatMap((day, n) => [60, 180, 210, 240, 1440].map((end, m) => ({
    ...booking, id: id(100 + n * 5 + m), reservation: { ...interval,
      booking_date: localTime.addDays(date, day), starts_at_minute: end - 60, ends_at_minute: end,
      court: { ...interval.court, location: { ...interval.court.location, timezone } } },
  })));
  serve(records);
  for (const scope of ["upcoming", "history"] as const) {
    const expected = records.map(source => ({ id: source.id,
      starts_at_instant: resolve(timezone, source.reservation.booking_date, source.reservation.starts_at_minute),
      history_at: resolve(timezone, source.reservation.booking_date, source.reservation.ends_at_minute) }))
      .filter(row => scope === "history" ? Date.parse(row.history_at) <= Date.parse(clock) : Date.parse(row.history_at) > Date.parse(clock))
      .sort((a, b) => Date.parse(a.starts_at_instant) - Date.parse(b.starts_at_instant) || a.id.localeCompare(b.id));
    for (const page of [1, 2]) {
      const result = await listOwnCourtActivity(scope, parseActivityQuery({ direction: "asc", page: String(page) }, scope), userClient, new Date(clock));
      expect(result.rows.map(({ id, starts_at_instant, history_at }) => ({ id, starts_at_instant, history_at })))
        .toEqual(expected.slice((page - 1) * 20, page * 20));
      expect(result.hasNext).toBe(expected.length > page * 20);
    }
  }
});

test("resolves starts only for candidates and distant ends only for the returned page", async () => {
  const resolve = vi.fn(localTime.createLocalStartInstantResolver());
  const factory = vi.spyOn(localTime, "createLocalStartInstantResolver").mockReturnValue(resolve);
  try {
    const records = Array.from({ length: 30 }, (_, n) => ({ ...booking, id: id(100 + n),
      reservation: { ...interval, booking_date: localTime.addDays("2025-03-01", n) } }));
    serve(records);
    const result = await listOwnCourtActivity("history", parseActivityQuery({}, "history"), userClient, now);
    expect(result.rows).toHaveLength(20);
    expect(resolve.mock.calls.filter(([, , minute]) => minute === interval.starts_at_minute)).toHaveLength(30);
    expect(resolve.mock.calls.filter(([, , minute]) => minute === interval.ends_at_minute)).toHaveLength(20);
    resolve.mockClear();
    const filtered = await listOwnCourtActivity("history", parseActivityQuery({ location: id(999) }, "history"), userClient, now);
    expect(filtered.rows).toEqual([]);
    expect(filtered.locations).toHaveLength(1);
    expect(resolve).not.toHaveBeenCalled();
    serve([{ ...booking, payment_method: "online" }]);
    expect((await listOwnCourtActivity("upcoming", parseActivityQuery({}, "upcoming"), userClient, now)).rows).toEqual([]);
    expect(resolve).not.toHaveBeenCalled();
  } finally { factory.mockRestore(); }
});

test("cancelled history resolves no end instant and preserves microsecond cancellation evidence", async () => {
  const resolve = vi.fn(localTime.createLocalStartInstantResolver());
  const factory = vi.spyOn(localTime, "createLocalStartInstantResolver").mockReturnValue(resolve);
  const stamp = "2026-10-01T00:00:00.123456Z";
  try {
    queryRead.mockImplementation(async (_sql: string, args: unknown[]) => args[1] === "cancelled"
      ? [{ row: { ...booking, status: "cancelled", updated_at: stamp, reservation: { ...interval, status: "cancelled" } } }] : []);
    const result = await listOwnCourtActivity("history", parseActivityQuery({}, "history"), userClient, now);
    expect(result.rows[0].history_at).toBe(stamp);
    expect(resolve).toHaveBeenCalledExactlyOnceWith(interval.court.location.timezone, interval.booking_date, interval.starts_at_minute);
  } finally { factory.mockRestore(); }
});

test.each([
  ["Europe/Bucharest", "2026-03-29", 180, 210, "2026-03-29T01:00:00.000Z", "2026-03-29T01:30:00.000Z"],
  ["America/New_York", "2026-11-01", 60, 90, "2026-11-01T06:00:00.000Z", "2026-11-01T06:30:00.000Z"],
  ["Australia/Lord_Howe", "2026-04-05", 90, 105, "2026-04-04T15:00:00.000Z", "2026-04-04T15:15:00.000Z"],
  ["Asia/Kathmandu", "2026-10-03", 1380, 1440, "2026-10-03T17:15:00.000Z", "2026-10-03T18:15:00.000Z"],
] as const)("keeps exact Upcoming/History boundaries for %s %s", async (timezone, date, start, end, startInstant, endInstant) => {
  serve([{ ...booking, reservation: { ...interval, booking_date: date, starts_at_minute: start, ends_at_minute: end,
    court: { ...interval.court, location: { ...interval.court.location, timezone } } } }]);
  const before = new Date(Date.parse(endInstant) - 1);
  const boundary = new Date(endInstant);
  const upcomingQuery = parseActivityQuery({}, "upcoming");
  const historyQuery = parseActivityQuery({}, "history");
  expect((await listOwnCourtActivity("upcoming", upcomingQuery, userClient, before)).rows[0].starts_at_instant).toBe(startInstant);
  expect((await listOwnCourtActivity("history", historyQuery, userClient, before)).rows).toEqual([]);
  expect((await listOwnCourtActivity("upcoming", upcomingQuery, userClient, boundary)).rows).toEqual([]);
  expect((await listOwnCourtActivity("history", historyQuery, userClient, boundary)).rows[0].history_at).toBe(endInstant);
});

test("regular users cannot request direct reservations; empty and high pages keep options", async () => {
  const result = await listOwnCourtActivity("upcoming", parseActivityQuery({ type: "reservation" }, "upcoming"), userClient, now);
  expect(result.rows.map((row) => row.kind)).toEqual(["booking"]);
  const empty = await listOwnCourtActivity("upcoming", parseActivityQuery({ page: "1000000" }, "upcoming"), userClient, now);
  expect(empty).toMatchObject({ rows: [], hasNext: false, locations: result.locations, courts: result.courts });

});

test("upcoming DTO supplies ordered interleaved records, options and pagination without raw rows", async () => {
  account.mockResolvedValue({ state: "active", userId: owner, roles: ["coach"] });
  const future = { ...interval, booking_date: "2099-10-15" };
  serve([{ ...booking, reservation: { ...future, starts_at_minute: 840, ends_at_minute: 900 } },
    { ...booking, id: id(6), reservation: { ...future, starts_at_minute: 1020, ends_at_minute: 1080 } }],
  [{ ...reservation, ...future, reason: null, creator: null }]);
  const result = await listOwnUpcomingActivity({}, userClient);
  expect(Object.keys(result).sort()).toEqual(["bookings", "courts", "hasNext", "locations", "ordered", "upcoming"]);
  expect(result.ordered.map(item => [item.kind, item.row.id]))
    .toEqual([["booking", booking.id], ["reservation", reservation.id], ["booking", id(6)]]);
  expect(result.bookings).toEqual([result.ordered[0].row, result.ordered[2].row]);
  expect(result.upcoming).toEqual([result.ordered[1].row]);
  expect(result.upcoming[0]).toMatchObject({ reason: null, creator_name: null, cancelled_at: null, cancelled_by_name: null });
  expect(result.locations).toEqual([{ id: id(3), name: "Club A" }]);
  expect(result.courts).toEqual([{ id: id(2), name: "Court A", location_id: id(3) }]);
  expect(result.hasNext).toBe(false);
  const empty = await listOwnUpcomingActivity({ location: id(999) }, userClient);
  expect(empty).toEqual({ ordered: [], bookings: [], upcoming: [], hasNext: false,
    locations: result.locations, courts: result.courts });
  serve(Array.from({ length: 21 }, (_, n) => ({ ...booking, id: id(n + 100), reservation: future })));
  expect((await listOwnUpcomingActivity({}, userClient)).hasNext).toBe(true);
  const second = await listOwnUpcomingActivity({ page: "2" }, userClient);
  expect(second.hasNext).toBe(false);
  expect(second.ordered).toHaveLength(1);
});

test.each([[[], "court"], [[], "coaching"], [[], "booking"], [[], "reservation"], [["coach"], "court"], [["coach"], "coaching"], [["coach"], "booking"], [["coach"], "reservation"]] as const)(
  "Upcoming returns only %j activity of type %s", async (roles, type) => {
    account.mockResolvedValue({ state: "active", userId: owner, roles });
    const future = { ...interval, booking_date: "2099-10-15" };
    serve([{ ...booking, reservation: future }, { ...booking, id: id(6), includes_coaching: true, coach_name: "Coach", reservation: future }],
      [{ ...reservation, ...future }]);
    const result = await listOwnUpcomingActivity({ type }, userClient);
    const effectiveType = roles.length === 0 && (type === "booking" || type === "reservation") ? "booking" : type;
    const expected = { court: [["booking", booking.id]], coaching: [["booking", id(6)]],
      booking: [["booking", booking.id], ["booking", id(6)]], reservation: [["reservation", reservation.id]] }[effectiveType];
    expect(result.ordered.map(item => [item.kind, item.row.id]).sort()).toEqual(expected);
  });

test("carries coaching classification from the owner-scoped contract into Upcoming", async () => {
  serve([{ ...booking, includes_coaching: true, reservation: { ...interval, booking_date: "2099-10-15" } }]);
  expect((await listOwnUpcomingActivity({}, userClient)).bookings[0]).toMatchObject({ id: booking.id, includes_coaching: true });
});


test.each([id(998), id(2)])("court fallback scans each stream only once: %s", async (court) => {
  account.mockResolvedValue({ state: "active", userId: owner, roles: ["coach"] });
  const query = { ...parseActivityQuery({}, "upcoming"), court,
    location: court === id(2) ? id(999) : id(3) };
  const result = await listOwnCourtActivity("upcoming", query, userClient, now);
  expect(result.rows.map(row => row.id)).toEqual(court === id(2) ? [] : [booking.id, reservation.id]);
  expect(queryRead).toHaveBeenCalledTimes(2);
  expect(account).toHaveBeenCalledTimes(1);
  expect(queryRead.mock.calls.map(([, args]) => args[4])).toEqual([undefined, undefined]);
});

test("court-only URL normalization and direct service fallback preserve unfiltered results", async () => {
  for (const query of [parseActivityQuery({ court: id(2) }, "upcoming"),
    { ...parseActivityQuery({}, "upcoming"), court: id(2) }]) {
    queryRead.mockClear();
    const result = await listOwnCourtActivity("upcoming", query, userClient, now);
    expect(result.rows.map(row => row.id)).toEqual([booking.id]);
    expect(queryRead).toHaveBeenCalledTimes(1);
  }
});

test.each([true, false])("late court options choose bounded candidates across batches: compatible=%s", async (compatible) => {
  const early = Array.from({ length: 1000 }, (_, n) => ({ ...booking, id: id(100 + n) }));
  const late = Array.from({ length: 22 }, (_, n) => ({ ...booking, id: id(2000 + n),
    reservation: { ...interval, court_id: id(9), court: { ...interval.court, name: "Court B" } } }));
  serve([...early, ...late]);
  const query = parseActivityQuery({ location: id(3), court: compatible ? id(9) : id(999), page: "2" }, "upcoming");
  const result = await listOwnCourtActivity("upcoming", query, userClient, now);
  expect(result.rows.map(row => row.id)).toEqual(compatible ? [id(2020), id(2021)]
    : Array.from({ length: 20 }, (_, n) => id(120 + n)));
  expect(result.hasNext).toBe(!compatible);
  expect(result.courts.map(court => court.id)).toEqual([id(2), id(9)]);
  expect(queryRead).toHaveBeenCalledTimes(2);
  expect(queryRead.mock.calls.map(([, args]) => args[4])).toEqual([undefined, id(1099)]);
});

test.each([0, 1, 2])("online activity needs a succeeded payment fact (%s returned facts)", async (count) => {
  serve([{ ...booking, payment_method: "online" }], [], Array.from({ length: count }, () => booking.id));
  const result = await listOwnCourtActivity("upcoming", parseActivityQuery({}, "upcoming"), userClient, now);
  expect(result.rows.map(row => row.id)).toEqual(count ? [booking.id] : []);
  expect(queryRead).toHaveBeenCalledTimes(2);
  expect(queryRead.mock.calls[1][1]).toEqual([[booking.id]]);
  expect(queryRead.mock.calls[1][0]).toContain("status='succeeded'");
  expect(queryRead.mock.calls[0][0]).not.toContain("jsonb_agg");
});

test.each([false, true])("payment facts use one scoped query per online batch: last batch online=%s", async (lastOnline) => {
  const online = Array.from({ length: 1000 }, (_, n) => ({ ...booking, id: id(n + 100), payment_method: "online" }));
  serve([...online, { ...booking, id: id(2000), payment_method: lastOnline ? "online" : "pay_at_club" }], [], online.map(row => row.id));
  const result = await listOwnCourtActivity("upcoming", parseActivityQuery({}, "upcoming"), userClient, now);
  expect(result.rows).toHaveLength(20);
  expect(result.hasNext).toBe(true);
  expect(queryRead).toHaveBeenCalledTimes(lastOnline ? 4 : 3);
  const payments = queryRead.mock.calls.filter(([sql]) => sql.includes("public.payment_attempts"));
  expect(payments).toHaveLength(lastOnline ? 2 : 1);
  expect(payments[0][1]).toEqual([online.map(row => row.id)]);
  if (lastOnline) expect(payments[1][1]).toEqual([[id(2000)]]);
});

test("cancelled online history still requires succeeded payment facts", async () => {
  queryRead.mockImplementation(async (sql: string, args: unknown[]) => {
    if (sql.includes("public.payment_attempts")) return [{ booking_id: id(6) }];
    return args[1] === "cancelled" ? [booking.id, id(6)].map(id => ({ row: {
      ...booking, id, status: "cancelled", payment_method: "online",
      reservation: { ...interval, status: "cancelled" },
    } })) : [];
  });
  const result = await listOwnCourtActivity("history", parseActivityQuery({}, "history"), userClient, now);
  expect(result.rows.map(row => row.id)).toEqual([id(6)]);
  expect(queryRead).toHaveBeenCalledTimes(3);
});

test("rejects malformed payment projections and handles payment query failures safely", async () => {
  for (const value of [[{ booking_id: "invalid" }], new Error("private payment failure")]) {
    serve([{ ...booking, payment_method: "online" }]);
    if (value instanceof Error) queryRead.mockResolvedValueOnce([{ row: { ...booking, payment_method: "online" } }]).mockRejectedValueOnce(value);
    else queryRead.mockResolvedValueOnce([{ row: { ...booking, payment_method: "online" } }]).mockResolvedValueOnce(value);
    await expect(listOwnCourtActivity("upcoming", parseActivityQuery({}, "upcoming"), userClient, now))
      .rejects.toThrow("Unable to load your court activity. Try again.");
  }
});

test("does not sort retained candidates when the next batch contributes no matches", async () => {
  serve([...Array.from({ length: 1000 }, (_, n) => ({ ...booking, id: id(n + 100) })),
    { ...booking, id: id(2000), reservation: { ...interval, booking_date: "2099-10-15" } }]);
  const sort = vi.spyOn(Array.prototype, "sort");
  try {
    const result = await listOwnCourtActivity("upcoming", parseActivityQuery({ to: "2026-10-03" }, "upcoming"), userClient, now);
    // One candidate sort plus the two final option sorts; no sort for the last batch.
    const calls = sort.mock.calls.length;
    expect(result.rows.map(row => row.id)).toEqual(Array.from({ length: 20 }, (_, n) => id(n + 100)));
    expect(result.hasNext).toBe(true);
    expect(calls).toBe(3);
  } finally { sort.mockRestore(); }
});

test("defers within-bound batches and sorts only the selected court collection at the end", async () => {
  account.mockResolvedValue({ state: "active", userId: owner, roles: ["coach"] });
  serve(Array.from({ length: 1000 }, (_, n) => ({ ...booking, id: id(n + 100) })),
    Array.from({ length: 1000 }, (_, n) => ({ ...reservation, id: id(n + 2000) })));
  const sort = vi.spyOn(Array.prototype, "sort");
  try {
    const result = await listOwnCourtActivity("upcoming", parseActivityQuery({ page: "100", location: id(3), court: id(2) }, "upcoming"), userClient, now);
    const calls = sort.mock.calls.length;
    expect(result.rows.map(row => row.id)).toEqual(Array.from({ length: 20 }, (_, n) => id(2980 + n)));
    expect(result.hasNext).toBe(false);
    // One final activity sort and the two option sorts, including terminal empty
    // batches. The unused fallback array needs no final sort.
    expect(calls).toBe(3);
  } finally { sort.mockRestore(); }
});

test.each(["upcoming", "history"] as const)("%s advances raw cursors through ineligible and filtered batches without gaps", async scope => {
  account.mockResolvedValue({ state: "active", userId: owner, roles: ["coach"] });
  const unpaid = Array.from({ length: 1000 }, (_, n) => ({ ...booking, id: id(100 + n), payment_method: "online" }));
  const filtered = Array.from({ length: 1000 }, (_, n) => ({ ...booking, id: id(1100 + n),
    reservation: { ...interval, booking_date: "2026-10-04" } }));
  const last = { ...booking, id: id(5000) };
  const direct = Array.from({ length: 1001 }, (_, n) => ({ ...reservation, id: id(10000 + n) }));
  serve([...unpaid, ...filtered, last], direct);
  const expected = [last.id, ...direct.map(row => row.id)];
  const clock = scope === "upcoming" ? now : new Date("2026-10-10T00:00:00Z");
  for (const page of [1, 51, 52]) {
    queryRead.mockClear();
    const result = await listOwnCourtActivity(scope, parseActivityQuery({ page: String(page), to: "2026-10-03" }, scope), userClient, clock);
    expect(result.rows.map(row => row.id)).toEqual(expected.slice((page - 1) * 20, page * 20));
    expect(result.hasNext).toBe(page === 1);
    expect(queryRead).toHaveBeenCalledTimes(scope === "history" ? 8 : 6);
    const reads = queryRead.mock.calls.filter(([sql]) => !sql.includes("public.payment_attempts"));
    expect(reads.every(([sql]) => !sql.includes("OFFSET"))).toBe(true);
    expect(reads.filter(([sql, args]) => sql.includes("public.bookings b") && args[1] === "confirmed")
      .map(([, args]) => args[4])).toEqual([undefined, id(1099), id(2099)]);
    expect(reads.filter(([sql, args]) => !sql.includes("public.bookings b") && args[1] === "active")
      .map(([, args]) => args[4])).toEqual([undefined, id(10999)]);
    expect(reads.filter(([, args]) => args[1] === "cancelled").every(([, args]) => args[4] === undefined)).toBe(true);
    expect(result.locations).toEqual([{ id: id(3), name: "Club A" }]);
  }
}, 30000);

test("an exact full raw batch performs one terminal empty read", async () => {
  serve(Array.from({ length: 1000 }, (_, n) => ({ ...booking, id: id(100 + n) })));
  const result = await listOwnCourtActivity("upcoming", parseActivityQuery({ page: "50" }, "upcoming"), userClient, now);
  expect(result.rows.map(row => row.id)).toEqual(Array.from({ length: 20 }, (_, n) => id(1080 + n)));
  expect(result.hasNext).toBe(false);
  expect(queryRead.mock.calls.map(([, args]) => args[4])).toEqual([undefined, id(1099)]);
});

test.each(["datetime", "location", "court", "type", "duration", "status"] as const)("preserves %s ordering in both directions", async sort => {
  account.mockResolvedValue({ state: "active", userId: owner, roles: ["admin"] });
  const rowInterval = (start: number, end: number, name: string) => ({ ...interval,
    booking_date: "2026-10-01", starts_at_minute: start, ends_at_minute: end,
    court: { ...interval.court, name, location: { name, timezone: "UTC" } } });
  const a = { ...booking, id: id(100), reservation: rowInterval(540, 600, "Z") };
  const b = { ...booking, id: id(101), includes_coaching: true, reservation: rowInterval(600, 720, "a") };
  const c = { ...reservation, id: id(102), ...rowInterval(660, 750, "M") };
  serve([a, b], [c]);
  const ascending = sort === "location" || sort === "court" ? [b.id, c.id, a.id]
    : sort === "type" ? [b.id, a.id, c.id] : sort === "duration" ? [a.id, c.id, b.id]
      : sort === "status" ? [c.id, b.id, a.id] : [a.id, b.id, c.id];
  for (const direction of ["asc", "desc"] as const) {
    const result = await listOwnCourtActivity("history", parseActivityQuery({ sort, direction }, "history"), userClient, now);
    expect(result.rows.map(row => row.id)).toEqual(direction === "asc" || sort === "status" ? ascending : [...ascending].reverse());
  }
});

// Opt-in CPU-only service benchmark. SQL transport is stubbed, but authorization,
// Zod parsing, timezone conversion, eligibility, options and pagination all run.
if (process.env.ACTIVITY_SERVICE_BENCHMARK) {
  test("benchmarks the complete service with in-memory repository transport", async () => {
    account.mockResolvedValue({ state: "active", userId: owner, roles: ["coach"] });
    const schedule = { ...interval, booking_date: "2026-10-01",
      court: { ...interval.court, location: { name: "Club A", timezone: "UTC" } } };
    const mixed = process.env.ACTIVITY_SERVICE_MIXED === "1";
    const dates = ["2024-01-01", "2024-07-15", "2025-03-30", "2025-10-26", "2025-12-31",
      "2026-01-01", "2026-03-28", "2026-03-29", "2026-03-30", "2026-09-15", "2026-10-01", "2026-10-02"];
    const zones = ["Europe/Bucharest", "America/New_York", "Asia/Kathmandu", "Australia/Lord_Howe", "Pacific/Apia", "UTC"];
    const scheduleAt = (n: number) => mixed ? { ...schedule, booking_date: dates[Math.floor(n / zones.length) % dates.length],
      court_id: n % zones.length === 0 ? id(2) : id(50000 + n % zones.length),
      starts_at_minute: 360 + n % 12 * 30, ends_at_minute: 420 + n % 12 * 30,
      court: { ...schedule.court, location_id: n % zones.length === 0 ? id(3) : id(60000 + n % zones.length),
        location: { name: `Club ${n % zones.length}`, timezone: zones[n % zones.length] } } } : schedule;
    serve(Array.from({ length: 15000 }, (_, n) => ({ ...booking, id: id(100 + n), reservation: scheduleAt(n) })),
      Array.from({ length: 15000 }, (_, n) => ({ ...reservation, ...scheduleAt(n + 15000), id: id(20000 + n) })));
    const measurements = [];
    const repeats = Number(process.env.ACTIVITY_SERVICE_REPEATS ?? 3);
    const warmup = process.env.ACTIVITY_SERVICE_WARMUP === "0" ? 0 : 1;
    for (const params of [{ page: "1" }, { page: "1500" }, { page: mixed ? "250" : "1500", location: id(3), court: id(2) }]) {
      const samples = [];
      const details = [];
      for (let repeat = -warmup; repeat < repeats; repeat++) {
        queryRead.mockClear();
        const session = process.env.ACTIVITY_CPU_PROFILE ? new Session() : null;
        if (session) {
          session.connect();
          session.post("Profiler.enable");
          session.post("Profiler.setSamplingInterval", { interval: 1000 });
          session.post("Profiler.start");
        }
        const heapBefore = process.memoryUsage().heapUsed;
        const cpuBefore = process.cpuUsage();
        const started = performance.now();
        const result = await listOwnCourtActivity("history", parseActivityQuery(params, "history"), userClient, now);
        const ms = performance.now() - started;
        const cpu = process.cpuUsage(cpuBefore);
        const memory = process.memoryUsage();
        if (session) {
          const profile = await new Promise<Profiler.Profile>((resolve, reject) => {
            session.post("Profiler.stop", (error, result) => error ? reject(error) : resolve(result.profile));
          });
          writeFileSync(`${process.env.ACTIVITY_CPU_PROFILE}-${measurements.length}-${repeat}.cpuprofile`, JSON.stringify(profile));
          session.disconnect();
        }
        expect(result.rows).toHaveLength(20);
        expect(result.hasNext).toBe(params.page === "1");
        if (process.env.ACTIVITY_SERVICE_BASELINE) {
          expect(Reflect.get(globalThis, "activityProfile")).toMatchObject({ conversions: 60000 });
        }
        if (repeat >= 0) {
          samples.push(ms);
          details.push({ ms, cpuMs: (cpu.user + cpu.system) / 1000, heapBefore, heapAfter: memory.heapUsed,
            rss: memory.rss, stages: Reflect.get(globalThis, "activityProfile"),
            digest: createHash("sha256").update(JSON.stringify(result)).digest("hex") });
        }
      }
      samples.sort((a, b) => a - b);
      measurements.push({ params, medianMs: samples[Math.floor(samples.length / 2)], samples, details });
    }
    writeFileSync(process.env.ACTIVITY_SERVICE_BENCHMARK ?? "/tmp/activity-service.json", JSON.stringify(measurements, null, 2) + "\n");
  }, 900000);
}

test.each(["datetime", "location", "court", "type", "duration", "status"] as const)("retains exact mixed %s order on first, deep and exhausted pages", async sort => {
  // This matrix isolates selection; real timezone/DST behavior is covered above.
  const instant = vi.spyOn(localTime, "localStartInstant").mockImplementation((_timezone, date, minute) =>
    new Date(Date.parse(`${date}T00:00:00Z`) + (minute - 180) * 60000).toISOString());
  const resolver = vi.spyOn(localTime, "createLocalStartInstantResolver").mockReturnValue(instant);
  try {
    account.mockResolvedValue({ state: "active", userId: owner, roles: ["coach"] });
    const stamp = "2026-10-01T00:00:00.123456Z";
    // The first raw booking batch is entirely unpaid. Matching rows in later
    // batches and the staff stream must still participate in the global order.
    const unpaid = Array.from({ length: 1000 }, (_, n) => ({ ...booking, id: id(n + 100), payment_method: "online" }));
    const bookings = Array.from({ length: 1100 }, (_, n) => ({ ...booking, id: id(n + 2000), updated_at: stamp,
      includes_coaching: n % 2 === 0 }));
    const direct = Array.from({ length: 1022 }, (_, n) => ({ ...reservation, id: id(n + 5000), updated_at: stamp }));
    serve([...unpaid, ...bookings], direct);
    for (const direction of ["asc", "desc"] as const) {
      const order = sort === "type"
        ? [...bookings.filter(row => row.includes_coaching), ...bookings.filter(row => !row.includes_coaching), ...direct]
        : [...bookings, ...direct];
      if (sort === "type" && direction === "desc") {
        order.splice(0, order.length, ...direct, ...bookings.filter(row => !row.includes_coaching), ...bookings.filter(row => row.includes_coaching));
      }
      for (const page of [1, 10, 100, 107, 108]) {
        const result = await listOwnCourtActivity("history", parseActivityQuery({ sort, direction, page: String(page),
          location: id(3), court: id(2), to: "2026-10-03" }, "history"), userClient, new Date("2026-10-10T00:00:00Z"));
        expect(result.rows.map(row => row.id)).toEqual(order.slice((page - 1) * 20, page * 20).map(row => row.id));
        expect(result.hasNext).toBe(order.length > page * 20);
        for (const row of result.rows) if (row.kind === "reservation") expect(row.updated_at).toBe(stamp);
      }
    }
  } finally { resolver.mockRestore(); instant.mockRestore(); }
}, 30000);
