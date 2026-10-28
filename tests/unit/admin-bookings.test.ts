import { beforeEach, expect, test, vi } from "vitest";

const { authorize, query, expire, clubs } = vi.hoisted(() => ({ authorize: vi.fn(), query: vi.fn(), expire: vi.fn(),
  clubs: { listAdminLocations: vi.fn(), listAdminCourts: vi.fn() } }));
vi.mock("@/lib/admin/authorization", () => ({ requireActiveAdmin: authorize }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({}) }));
vi.mock("@/lib/db/data-source", () => ({ getDataSource: async () => ({ manager: { query } }) }));
vi.mock("@/lib/db/repositories/clubs.repository", () => clubs);
vi.mock("@/lib/payments/hold-expiry", () => ({ expirePaymentHolds: expire }));

import { listAdminBookingCoachFilterOptions, listAdminBookingFilterOptions, listAdminBookings } from "@/lib/bookings/admin-details";
import { adminBookingHref, adminBookingsHref, parseAdminBookingQuery } from "@/lib/bookings/admin-query";

const locationId = "ab000000-0000-4000-8000-000000000001", courtId = "ab000000-0000-4000-8000-000000000002";
const row = (index: number, accountUserId: string | null = null) => ({ kind: "booking",
  id: `ab000000-0000-4000-8000-${String(index).padStart(12, "0")}`, status: "cancelled", created_at: "2026-10-06T10:00:00.5+00:00",
  includes_coaching: false, coach_name: null, coaching_program_name: null,
  account_user_id: accountUserId, booking_date: "2024-01-01", starts_at_minute: 600, ends_at_minute: 660, location_id: locationId,
  location_name: "Historical club", location_timezone: "Europe/Bucharest", court_id: courtId, court_name: "Old court",
  customer_name: "Guest", customer_email: "guest@example.test", total_amount_minor: 5000, currency: "RON" });

beforeEach(() => { vi.clearAllMocks(); authorize.mockResolvedValue({ userId: "admin", roles: ["admin"] }); });

test("parses list URLs safely, drops a court without a location and preserves only meaningful parameters", () => {
  expect(parseAdminBookingQuery({})).toEqual({ q: "", type: "all", status: "all", location: "", court: "", coach: "", from: "", to: "", sort: "created", dir: "desc", page: 1 });
  expect(parseAdminBookingQuery({ status: "refunded", sort: "price", dir: "up", page: "0", from: "2026-02-31", location: "x" }))
    .toMatchObject({ status: "all", sort: "created", dir: "desc", page: 1, from: "", location: "" });
  expect(parseAdminBookingQuery({ court: courtId }).court).toBe("");
  const query = parseAdminBookingQuery({ q: " ab00 ", type: "coaching", status: "pending_payment", location: locationId.toUpperCase(), court: courtId,
    from: "2026-01-01", to: "2026-01-31", sort: "scheduled", dir: "asc", page: "3" });
  expect(query).toMatchObject({ q: "ab00", location: locationId, court: courtId, page: 3 });
  expect(parseAdminBookingQuery(Object.fromEntries(new URL(adminBookingsHref(query), "http://x").searchParams))).toEqual(query);
  expect(adminBookingsHref(query, 1)).not.toContain("page=");
  expect(adminBookingsHref(parseAdminBookingQuery({}))).toBe("/admin/bookings");
  expect(adminBookingHref(row(1).id, query)).toBe(`/admin/bookings/${row(1).id}?${new URL(adminBookingsHref(query), "http://x").searchParams}`);
});

test("authorizes before any read and propagates authorization failures", async () => {
  authorize.mockRejectedValue(new Error("Forbidden"));
  await expect(listAdminBookings(parseAdminBookingQuery({}))).rejects.toThrow("Forbidden");
  await expect(listAdminBookingCoachFilterOptions()).rejects.toThrow("Forbidden");
  await expect(listAdminBookingFilterOptions()).rejects.toThrow("Forbidden");
  expect(query).not.toHaveBeenCalled();
  expect(expire).not.toHaveBeenCalled();
  expect(clubs.listAdminLocations).not.toHaveBeenCalled();
});

test("filters, searches and paginates in the database on the current booking snapshot", async () => {
  expire.mockImplementationOnce(async () => { expect(query).not.toHaveBeenCalled(); return 1; });
  query.mockResolvedValueOnce([{ total: 45 }]).mockResolvedValueOnce([row(1), row(2, "ab000000-0000-4000-8000-0000000000aa")]);
  const result = await listAdminBookings(parseAdminBookingQuery({ q: "Ana", status: "cancelled", location: locationId, court: courtId,
    from: "2024-01-01", to: "2024-12-31", page: "2" }));
  expect(result).toMatchObject({ page: 2, total: 45, totalPages: 3 });
  expect(result.rows.map((item) => item.kind === "booking" && item.account_user_id)).toEqual([null, "ab000000-0000-4000-8000-0000000000aa"]);
  const [countSql, countArgs] = query.mock.calls[0], [pageSql, pageArgs] = query.mock.calls[1];
  expect(countArgs).toEqual(["cancelled", locationId, courtId, "2024-01-01", "2024-12-31", "Ana", "all", null, null]);
  expect(pageArgs).toEqual([...countArgs, 20, 20]);
  for (const sql of [countSql, pageSql]) {
    expect(sql).toContain("v.id=b.current_revision_id AND v.booking_id=b.id");
    expect(sql).toContain("strpos(b.id::text,lower($6))>0");
    expect(sql).toMatch(/v\.location_id=\$2[\s\S]*v\.court_id=\$3/);
    // Historical, archived and inactive resources stay visible; reads never write.
    expect(sql).not.toMatch(/is_active|archived_at|is_public|UPDATE|INSERT|DELETE/);
    // Staff reservations are a separate table read alongside, never a booking row.
    expect(sql).toContain("FROM public.court_reservations r");
    expect(sql).toContain("NOT EXISTS(SELECT 1 FROM public.bookings db WHERE db.reservation_id=r.id)");
    expect(sql).toMatch(/r\.created_by_user_id IS NOT NULL AND r\.adjustment_id IS NULL\s+AND r\.coach_user_id IS NULL/);
  }
  expect(pageSql).toContain("UNION ALL");
  expect(pageSql).toContain("ORDER BY x.created_sort DESC,x.id DESC OFFSET $10 LIMIT $11");
});

test.each([
  [{ sort: "scheduled", dir: "asc" }, "ORDER BY x.booking_date ASC,x.starts_at_minute ASC,x.created_sort DESC,x.id"],
  [{ sort: "scheduled" }, "ORDER BY x.booking_date DESC,x.starts_at_minute DESC,x.created_sort DESC,x.id"],
  [{ dir: "asc" }, "ORDER BY x.created_sort ASC,x.id ASC"],
])("orders by %o", async (params, order) => {
  query.mockResolvedValueOnce([{ total: 1 }]).mockResolvedValueOnce([row(1)]);
  await listAdminBookings(parseAdminBookingQuery(params));
  expect(query.mock.calls[1][0]).toContain(order);
  expect(query.mock.calls[0][1]).toEqual([null, null, null, null, null, "", "all", null, null]);
});

test("clamps out-of-range pages and skips the page read when nothing matches", async () => {
  query.mockResolvedValueOnce([{ total: 21 }]).mockResolvedValueOnce([row(21)]);
  expect(await listAdminBookings(parseAdminBookingQuery({ page: "99" }))).toMatchObject({ page: 2, totalPages: 2 });
  expect(query.mock.calls[1][1].slice(-2)).toEqual([20, 20]);
  query.mockReset().mockResolvedValueOnce([{ total: 0 }]);
  expect(await listAdminBookings(parseAdminBookingQuery({ page: "5" }))).toEqual({ rows: [], page: 1, total: 0, totalPages: 1 });
  expect(query).toHaveBeenCalledOnce();
});

test("hides database details behind a generic error", async () => {
  query.mockRejectedValueOnce(Object.assign(new Error("relation secret_table"), { code: "42P01" }));
  await expect(listAdminBookings(parseAdminBookingQuery({}))).rejects.toThrow("Unable to load bookings. Try again.");
});

test("filter options include current and archived locations with only their own courts", async () => {
  const archivedId = "ab000000-0000-4000-8000-000000000003";
  clubs.listAdminLocations.mockImplementation(async (_manager, view) => view === "archived"
    ? [{ id: archivedId, name: "Old", archivedAt: new Date() }] : [{ id: locationId, name: "Central", archivedAt: null }]);
  clubs.listAdminCourts.mockResolvedValue([{ id: courtId, locationId, name: "Court 1" },
    { id: "ab000000-0000-4000-8000-000000000004", locationId: archivedId, name: "Old court" }]);
  expect(await listAdminBookingFilterOptions()).toEqual([
    { id: locationId, name: "Central", archived: false, courts: [{ id: courtId, name: "Court 1" }] },
    { id: archivedId, name: "Old", archived: true, courts: [{ id: "ab000000-0000-4000-8000-000000000004", name: "Old court" }] },
  ]);
});


test.each(["court", "coaching"])("applies %s to both database count and paginated reads", async (type) => {
  query.mockResolvedValueOnce([{ total: 21 }]).mockResolvedValueOnce([row(21)]);
  const result = await listAdminBookings(parseAdminBookingQuery({ type, q: "Ana", page: "2", sort: "scheduled", dir: "asc" }));
  expect(result).toMatchObject({ total: 21, totalPages: 2, page: 2 });
  for (const [sql, args] of query.mock.calls) {
    expect(sql).toContain("$7='court' AND v.coach_user_id IS NULL");
    expect(sql).toContain("$7='coaching' AND v.coach_user_id IS NOT NULL");
    expect(args[6]).toBe(type);
  }
  expect(query.mock.calls[1][1].slice(-2)).toEqual([20, 20]);
});

test("staff reservations are listed with their own lifecycle and no customer or financial fields", async () => {
  const reservation = { kind: "reservation", id: "ab000000-0000-4000-8000-0000000000f1", status: "active",
    created_at: "2026-10-06T10:00:00+00:00", booking_date: "2099-01-01", starts_at_minute: 600, ends_at_minute: 720,
    location_id: locationId, location_name: "Central", location_timezone: "UTC", court_id: courtId, court_name: "Court 1",
    reason: "Maintenance", creator_name: "Staff Member", creator_email: "staff@example.test",
    account_user_id: null, customer_name: null, customer_email: null, total_amount_minor: null, currency: null,
    includes_coaching: false, coach_name: null, coaching_program_name: null };
  query.mockResolvedValueOnce([{ total: 2 }]).mockResolvedValueOnce([row(1), reservation]);
  const result = await listAdminBookings(parseAdminBookingQuery({ type: "reservation", status: "active" }));
  expect(result.rows[1]).toEqual({ kind: "reservation", id: reservation.id, status: "active", created_at: reservation.created_at,
    booking_date: "2099-01-01", starts_at_minute: 600, ends_at_minute: 720, location_id: locationId, location_name: "Central",
    location_timezone: "UTC", court_id: courtId, court_name: "Court 1", reason: "Maintenance", creator_name: "Staff Member",
    creator_email: "staff@example.test" });
  for (const [sql, args] of query.mock.calls) {
    // Reservations join only for "all"/"reservation"; coach filtering never matches them.
    expect(sql).toContain("$7::text IN ('all','reservation') AND $8::uuid IS NULL");
    expect(sql).toContain("strpos(lower(coalesce(r.reason,'')),lower($6))>0");
    expect(args.slice(0, 8)).toEqual(["active", null, null, null, null, "", "reservation", null]);
  }
});

test("status filters stay within the selected Type's lifecycle", () => {
  expect(parseAdminBookingQuery({ type: "reservation", status: "active" }).status).toBe("active");
  expect(parseAdminBookingQuery({ type: "reservation", status: "cancelled" }).status).toBe("cancelled");
  expect(parseAdminBookingQuery({ type: "reservation", status: "confirmed" }).status).toBe("all");
  expect(parseAdminBookingQuery({ type: "court", status: "active" }).status).toBe("all");
  expect(parseAdminBookingQuery({ status: "active" }).status).toBe("active");
  expect(parseAdminBookingQuery({ status: "pending_payment" }).status).toBe("pending_payment");
  const query = parseAdminBookingQuery({ type: "reservation", status: "cancelled", q: "court", page: "2" });
  expect(parseAdminBookingQuery(Object.fromEntries(new URL(adminBookingsHref(query), "http://x").searchParams))).toEqual(query);
});

test("invalid and duplicated booking types safely select all", () => {
  for (const type of ["price", ["court", "coaching"]]) expect(parseAdminBookingQuery({ type }).type).toBe("all");
});


test("coach IDs survive URL serialization only for coaching, with all list state intact", () => {
  const query = parseAdminBookingQuery({ type: "coaching", coach: courtId.toUpperCase(), q: "Ana", status: "cancelled", page: "3", sort: "scheduled", dir: "asc" });
  expect(query.coach).toBe(courtId);
  expect(parseAdminBookingQuery(Object.fromEntries(new URL(adminBookingsHref(query), "http://x").searchParams))).toEqual(query);
  for (const type of ["all", "court"]) expect(parseAdminBookingQuery({ type, coach: courtId }).coach).toBe("");
  for (const coach of ["invalid", [courtId, locationId]]) expect(parseAdminBookingQuery({ type: "coaching", coach }).coach).toBe("");
});

test("coach filtering reaches both count and page SQL before offset and limit", async () => {
  query.mockResolvedValueOnce([{ total: 21 }]).mockResolvedValueOnce([row(21)]);
  await listAdminBookings(parseAdminBookingQuery({ type: "coaching", coach: courtId, page: "2" }));
  for (const [sql, args] of query.mock.calls) {
    expect(sql).toContain("AND ($8::uuid IS NULL OR v.coach_user_id=$8)");
    expect(args[7]).toBe(courtId);
  }
  expect(query.mock.calls[1][1].slice(-2)).toEqual([20, 20]);
});

test("coach options come only from stored booking references and names, including archived coaches", async () => {
  query.mockResolvedValueOnce([{ id: courtId, name: "Historical coach" }]);
  expect(await listAdminBookingCoachFilterOptions()).toEqual([{ id: courtId, name: "Historical coach" }]);
  const sql = query.mock.calls[0][0];
  expect(sql).toContain("DISTINCT ON (v.coach_user_id)");
  expect(sql).toContain("v.coach_name AS name");
  expect(sql).toContain("v.recorded_at DESC,v.id DESC");
  expect(sql).not.toMatch(/coach_profiles|public.users|archived_at|is_public|UPDATE|DELETE|INSERT/);
});
