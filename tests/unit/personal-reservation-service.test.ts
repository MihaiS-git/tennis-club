import { createClient } from "@supabase/supabase-js";
import { beforeEach, expect, test, vi } from "vitest";
import type { CurrentAccount } from "@/lib/auth/account";

const { account, writer } = vi.hoisted(() => ({ account: vi.fn(), writer: vi.fn() }));
vi.mock("@/lib/auth/account", () => ({ readCurrentAccount: account }));
vi.mock("@/lib/supabase/booking-writer", () => ({ createBookingWriter: writer }));
import { getOwnReservationEditDay, listPersonalReservations } from "@/lib/reservations/personal-service";

const owner = "ca000000-0000-4000-8000-000000000001";
const other = "ca000000-0000-4000-8000-000000000002";
const now = new Date("2026-10-02T12:30:45Z");
const row = {
  id: "ca000000-0000-4000-8000-000000000010",
  court_id: "ca000000-0000-4000-8000-000000000011",
  updated_at: "2026-10-01T12:00:00Z", booking_date: "2026-10-02",
  starts_at_minute: 900, ends_at_minute: 960, reason: "Practice", status: "active",
  created_by_user_id: owner, cancelled_at: null,
  creator: { first_name: "Ana", last_name: "Pop" }, canceller: null,
  court: { name: "Court 1", location_id: "ca000000-0000-4000-8000-000000000020",
    location: { name: "Club", timezone: "Europe/Bucharest" } },
};
const fetchRead = vi.fn<typeof fetch>();
const userClient = createClient("http://localhost:54321", "user-key", { auth: { persistSession: false } });

beforeEach(() => {
  account.mockReset(); writer.mockReset(); fetchRead.mockReset();
  account.mockResolvedValue({ state: "active", userId: owner, email: "staff@example.test", roles: ["admin"] });
  fetchRead.mockResolvedValue(Response.json([row]));
  writer.mockReturnValue(createClient("http://localhost:54321", "server-key", {
    auth: { persistSession: false }, global: { fetch: fetchRead },
  }));
});

test.each(["admin", "coach"])("authorizes %s and queries only that owner's active reservations in DB order", async (role) => {
  account.mockResolvedValue({ state: "active", userId: owner, roles: [role] });
  const result = await listPersonalReservations(userClient, now);
  expect(account).toHaveBeenCalledWith(userClient);
  const url = new URL(String(fetchRead.mock.calls[0][0]));
  expect(url.pathname).toBe("/rest/v1/court_reservations");
  expect(url.searchParams.get("created_by_user_id")).toBe(`eq.${owner}`);
  expect(url.searchParams.get("status")).toBe("eq.active");
  expect(url.searchParams.get("order")).toBe("booking_date.asc,starts_at_minute.asc,id.asc");
  expect(url.searchParams.get("select")).toContain("creator:users!court_reservations_created_by_user_id_fkey(first_name,last_name)");
  expect(url.searchParams.get("select")).toContain("canceller:users!court_reservations_cancelled_by_user_id_fkey(first_name,last_name)");
  expect(result.upcoming).toEqual([{
    id: row.id, court_id: row.court_id, location_id: row.court.location_id, updated_at: row.updated_at,
    booking_date: row.booking_date, starts_at_minute: 900, ends_at_minute: 960,
    reason: "Practice", status: "active", created_by_user_id: owner, creator_name: "Ana Pop",
    cancelled_at: null, cancelled_by_name: null, location_name: "Club",
    location_timezone: "Europe/Bucharest", court_name: "Court 1",
  }]);
});

test.each<CurrentAccount>([
  { state: "active", userId: owner, email: "member@example.test", roles: [] },
  { state: "suspended", userId: owner, email: "staff@example.test", roles: ["coach"] },
  { state: "unauthenticated" }, { state: "missing-profile" }, { state: "load-error" },
])("rejects unauthorized accounts before privileged access: %j", async (state) => {
  account.mockResolvedValue(state);
  await expect(listPersonalReservations(userClient, now)).rejects.toThrow();
  expect(writer).not.toHaveBeenCalled();
  expect(fetchRead).not.toHaveBeenCalled();
});

test("filters finished intervals using each location clock and preserves the database ordering", async () => {
  const id = (suffix: string) => `ca000000-0000-4000-8000-0000000000${suffix}`;
  const rows = [
    { ...row, id: id("30"), booking_date: "2026-10-01" },
    { ...row, id: id("31"), ends_at_minute: 930 },
    { ...row, id: id("32"), starts_at_minute: 540, ends_at_minute: 600,
      court: { ...row.court, location: { ...row.court.location, timezone: "America/New_York" } } },
    { ...row, id: id("33") },
    { ...row, id: id("34") },
    { ...row, id: id("35"), booking_date: "2026-10-03" },
  ];
  // PostgREST returns rows sorted by stored date, start minute, then ID.
  fetchRead.mockResolvedValue(Response.json([rows[0], rows[2], rows[1], rows[3], rows[4], rows[5]]));
  expect((await listPersonalReservations(userClient, now)).upcoming.map((value) => value.id))
    .toEqual([id("32"), id("33"), id("34"), id("35")]);
});

test("uses the location date across midnight rather than the UTC date", async () => {
  fetchRead.mockImplementation(async () => Response.json([{ ...row, booking_date: "2026-10-03", starts_at_minute: 0, ends_at_minute: 60 }]));
  expect((await listPersonalReservations(userClient, new Date("2026-10-02T21:30:00Z"))).upcoming).toHaveLength(1);
  expect((await listPersonalReservations(userClient, new Date("2026-10-02T22:00:00Z"))).upcoming).toEqual([]);
});

test("composes nullable creator and canceller names like the previous SQL projection", async () => {
  fetchRead.mockResolvedValue(Response.json([{ ...row,
    creator: { first_name: null, last_name: "Pop" }, canceller: { first_name: null, last_name: null } }]));
  expect((await listPersonalReservations(userClient, now)).upcoming[0]).toMatchObject({ creator_name: "Pop", cancelled_by_name: null });
});

test.each([
  [{ ...row, created_by_user_id: other }], [{ ...row, status: "cancelled" }], [{ id: row.id }],
])("fails safely on unexpected owner, status or malformed SELECT data", async (data) => {
  fetchRead.mockResolvedValue(Response.json(data));
  await expect(listPersonalReservations(userClient, now)).rejects.toThrow("Unable to load your reservations.");
});

test("translates database failures into a safe application error", async () => {
  fetchRead.mockResolvedValue(Response.json({ code: "42501", message: "private database details" }, { status: 403 }));
  await expect(listPersonalReservations(userClient, now)).rejects.toThrow("Unable to load your reservations.");
});


test("reads beyond the PostgREST row cap when finished active rows fill the first page", async () => {
  fetchRead.mockResolvedValueOnce(Response.json(Array.from({ length: 1000 }, () => ({ ...row, booking_date: "2026-10-01" }))))
    .mockResolvedValueOnce(Response.json([{ ...row, booking_date: "2026-10-03" }]));
  expect((await listPersonalReservations(userClient, now)).upcoming.map((value) => value.id)).toEqual([row.id]);
  const urls = fetchRead.mock.calls.map(([input]) => new URL(String(input)));
  expect(urls.map((url) => [url.searchParams.get("offset"), url.searchParams.get("limit")]))
    .toEqual([["0", "1000"], ["1000", "1000"]]);
  expect(urls.every((url) => url.searchParams.get("created_by_user_id") === `eq.${owner}`
    && url.searchParams.get("status") === "eq.active"
    && url.searchParams.get("order") === "booking_date.asc,starts_at_minute.asc,id.asc")).toBe(true);
});

const editFetch = vi.fn<typeof fetch>();
const editClient = createClient("http://localhost:54321", "user-key", {
  auth: { persistSession: false }, global: { fetch: editFetch },
});
const editTarget = {
  id: row.id, created_by_user_id: owner, status: "active", booking_date: row.booking_date,
  starts_at_minute: 900, ends_at_minute: 960,
  court: { location_id: row.court.location_id, is_active: true,
    location: { timezone: "Europe/Bucharest", is_active: true, archived_at: null } },
};
const interval = { court_id: row.court_id, starts_at_minute: 960, ends_at_minute: 1020,
  status: "active", hold_expires_at: null,
  court: { is_active: true, location: { is_active: true, archived_at: null } } };

function prepareEdit(target: unknown = editTarget, occupancy: unknown = [interval]) {
  fetchRead.mockReset();
  fetchRead.mockResolvedValueOnce(Response.json(target)).mockResolvedValue(Response.json(occupancy));
  editFetch.mockReset();
  editFetch.mockImplementation(async (input) => Response.json(String(input).includes("location_opening_hours") ? [{
    id: other, location_id: row.court.location_id, weekday: 4, opens_at_minute: 900, closes_at_minute: 1200,
    created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z",
  }] : {
    id: row.court.location_id, name: "Club", timezone: "Europe/Bucharest", is_active: true, archived_at: null,
    courts: [{ id: row.court_id, name: "Court 1", is_active: true }],
  }));
}
const editInput = { reservationId: row.id, date: row.booking_date };

test.each(["admin", "coach"])("own edit authorizes %s then reads a narrow target before location/date occupancy", async (role) => {
  account.mockResolvedValue({ state: "active", userId: owner, roles: [role] });
  prepareEdit();
  const result = await getOwnReservationEditDay(editInput, editClient, now);
  expect(account.mock.invocationCallOrder[0]).toBeLessThan(writer.mock.invocationCallOrder[0]);
  const [targetUrl, occupancyUrl] = fetchRead.mock.calls.map(([input]) => new URL(String(input)));
  expect(Object.fromEntries(targetUrl.searchParams)).toMatchObject({
    id: `eq.${row.id}`, created_by_user_id: `eq.${owner}`, status: "eq.active",
    "court.is_active": "eq.true", "court.location.is_active": "eq.true", "court.location.archived_at": "is.null",
  });
  expect(targetUrl.searchParams.get("select")).toBe("id,created_by_user_id,status,booking_date,starts_at_minute,ends_at_minute,court:courts!inner(location_id,is_active,location:locations!inner(timezone,is_active,archived_at))");
  expect(Object.fromEntries(occupancyUrl.searchParams)).toMatchObject({
    id: `neq.${row.id}`, booking_date: `eq.${row.booking_date}`, "court.location_id": `eq.${row.court.location_id}`,
    status: "in.(active,held)", "court.is_active": "eq.true", "court.location.is_active": "eq.true",
    "court.location.archived_at": "is.null", order: "court_id.asc,starts_at_minute.asc,id.asc", offset: "0", limit: "1000",
  });
  expect(result).toMatchObject({ date: row.booking_date,
    location: { id: row.court.location_id, name: "Club", timezone: "Europe/Bucharest" } });
  expect(result.day.courts[0].cells.slice(0, 4)).toEqual(["past", "available", "booked", "booked"]);
  expect(fetchRead.mock.calls.every(([, init]) => init?.method === "GET")).toBe(true);
  expect(editFetch.mock.calls.every(([input]) => !String(input).includes("/rpc/"))).toBe(true);
});

test.each([null, { ...editTarget, created_by_user_id: other }, { ...editTarget, id: other },
  { ...editTarget, booking_date: "2026-10-01" }])("rejects missing/non-owned/finished edit targets before occupancy: %j", async (target) => {
  prepareEdit(target);
  await expect(getOwnReservationEditDay(editInput, editClient, now)).rejects.toThrow("This reservation is no longer available to edit.");
  expect(fetchRead).toHaveBeenCalledTimes(1);
  expect(editFetch).not.toHaveBeenCalled();
});

test.each<CurrentAccount>([
  { state: "unauthenticated" }, { state: "active", userId: owner, email: "member@example.test", roles: [] },
  { state: "suspended", userId: owner, email: "coach@example.test", roles: ["coach"] },
])("rejects unauthorized edit accounts before privileged target read: %j", async (state) => {
  prepareEdit(); account.mockResolvedValue(state);
  await expect(getOwnReservationEditDay(editInput, editClient, now)).rejects.toThrow();
  expect(writer).not.toHaveBeenCalled();
  expect(fetchRead).not.toHaveBeenCalled();
});

test("own edit uses one now for live holds, excludes expired/equal/null holds and returns generic intervals in order", async () => {
  prepareEdit(editTarget, [
    interval,
    { ...interval, status: "held", starts_at_minute: 1020, ends_at_minute: 1080, hold_expires_at: "2026-10-02T12:30:45.000001Z" },
    { ...interval, status: "held", starts_at_minute: 1080, ends_at_minute: 1140, hold_expires_at: now.toISOString() },
    { ...interval, status: "held", starts_at_minute: 1140, ends_at_minute: 1200, hold_expires_at: "2026-10-02T12:30:44Z" },
    { ...interval, status: "held", starts_at_minute: 1140, ends_at_minute: 1200 },
  ]);
  const result = await getOwnReservationEditDay(editInput, editClient, now);
  expect(result.day.courts[0].cells).toEqual([
    "past", "available", "booked", "booked", "booked", "booked", "available", "available", "available", "available",
  ]);
  const url = new URL(String(fetchRead.mock.calls[1][0]));
  expect(url.searchParams.get("select")).toBe("court_id,starts_at_minute,ends_at_minute,status,hold_expires_at,court:courts!inner(is_active,location:locations!inner(is_active,archived_at))");
  expect(JSON.stringify(result)).not.toMatch(/created_by_user_id|hold_expires_at|reason|customer/);
});

test("own edit rejects invalid/past dates before occupancy and bounds a changed date to the same location", async () => {
  prepareEdit();
  await expect(getOwnReservationEditDay({ ...editInput, date: "invalid" }, editClient, now)).rejects.toThrow("Choose a valid date.");
  expect(fetchRead).not.toHaveBeenCalled();
  await expect(getOwnReservationEditDay({ ...editInput, date: "2026-10-01" }, editClient, now)).rejects.toThrow("Choose a future date");
  expect(fetchRead).toHaveBeenCalledTimes(1);
  prepareEdit();
  await getOwnReservationEditDay({ ...editInput, date: "2026-10-03" }, editClient, now);
  const url = new URL(String(fetchRead.mock.calls[1][0]));
  expect(url.searchParams.get("booking_date")).toBe("eq.2026-10-03");
  expect(url.searchParams.get("court.location_id")).toBe(`eq.${row.court.location_id}`);
});
