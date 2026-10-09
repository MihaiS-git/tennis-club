import { createClient } from "@supabase/supabase-js";
import { beforeEach, expect, test, vi } from "vitest";
import type { CurrentAccount } from "@/lib/auth/account";
import { parseActivityQuery } from "@/lib/bookings/activity-query";

const { account, dataSource, queryRead } = vi.hoisted(() => ({ account: vi.fn(), dataSource: vi.fn(), queryRead: vi.fn() }));
vi.mock("@/lib/auth/account", () => ({ readCurrentAccount: account }));
vi.mock("@/lib/db/data-source", () => ({ getDataSource: dataSource }));
import { listOwnCourtActivity } from "@/lib/bookings/activity-service";

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
  customer_name: "Snapshot", customer_email: "snapshot@example.test", customer_phone: "123",
  cancellation_notice_minutes: 120, total_amount_minor: 9000, currency: "RON",
  payment_method: "pay_at_club", payments: [], reservation: interval,
};
const reservation = {
  ...interval, id: id(5), updated_at: "2026-10-01T00:00:00Z", reason: "Practice", created_by_user_id: owner,
  cancelled_at: null, creator: { first_name: "Own", last_name: "Name" }, canceller: null,
};
// Existing service-policy fixtures use a low-level SQL transport stub; real
// authorization/query visibility is covered by the integration suites.
function serve(bookings: unknown[], reservations: unknown[] = []) {
  queryRead.mockImplementation(async (sql: string, args: unknown[]) => {
    const rows = args[1] === "cancelled" ? [] : sql.includes("public.bookings b") ? bookings : reservations;
    return rows.slice(Number(args[4]), Number(args[4]) + Number(args[3])).map((row) => ({ row }));
  });
}
beforeEach(() => {
  account.mockReset(); dataSource.mockReset(); queryRead.mockReset();
  account.mockResolvedValue({ state: "active", userId: owner, roles: [] });
  dataSource.mockResolvedValue({ manager: { query: queryRead } });
  serve([booking], [reservation]);
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
    customer_name: "Snapshot", customer_email: "snapshot@example.test", customer_phone: "123",
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

test("classifies exact ends using one instant across timezones and excludes unpaid online rows", async () => {
  serve([
    { ...booking, reservation: { ...interval, ends_at_minute: 900 } },
    { ...booking, id: id(6), reservation: { ...interval, court: { ...interval.court,
      location: { name: "New York", timezone: "America/New_York" } } } },
    { ...booking, id: id(7), payment_method: "online" },
    { ...booking, id: id(8), payment_method: "online", payments: [{ status: "succeeded" }] },
  ]);
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

test("regular users cannot request direct reservations; empty and high pages keep options", async () => {
  const result = await listOwnCourtActivity("upcoming", parseActivityQuery({ type: "reservation" }, "upcoming"), userClient, now);
  expect(result.rows.map((row) => row.kind)).toEqual(["booking"]);
  const empty = await listOwnCourtActivity("upcoming", parseActivityQuery({ page: "1000000" }, "upcoming"), userClient, now);
  expect(empty).toMatchObject({ rows: [], hasNext: false, locations: result.locations, courts: result.courts });

});
