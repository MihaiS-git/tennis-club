import { beforeEach, expect, test, vi } from "vitest";

const { authorize, query, clubs } = vi.hoisted(() => ({ authorize: vi.fn(), query: vi.fn(),
  clubs: { listAdminLocations: vi.fn(), listAdminCourts: vi.fn() } }));
vi.mock("@/lib/coaching/authorization", () => ({ requireActiveCoach: authorize }));
vi.mock("@/lib/admin/authorization", () => ({ requireActiveAdmin: vi.fn(() => { throw new Error("Admin only"); }) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({}) }));
vi.mock("@/lib/db/data-source", () => ({ getDataSource: async () => ({ manager: { query } }) }));
vi.mock("@/lib/db/repositories/clubs.repository", () => clubs);

import { coachBookingsHref, coachListStatusOptions, parseCoachBookingQuery, parseCoachBookingReturn } from "@/lib/bookings/admin-query";
import { getCoachDirectReservation, getCoachLesson, listCoachBookingFilterOptions, listCoachBookings } from "@/lib/bookings/coach-bookings";

const coachId = "cb000000-0000-4000-8000-0000000000c1", otherCoachId = "cb000000-0000-4000-8000-0000000000c2";
const locationId = "cb000000-0000-4000-8000-000000000001", courtId = "cb000000-0000-4000-8000-000000000002";
const lessonId = "cb000000-0000-4000-8000-000000000010", reservationId = "cb000000-0000-4000-8000-000000000020";
const listed = { id: lessonId, created_at: "2026-10-06T10:00:00+00:00", booking_date: "2099-01-01", starts_at_minute: 600,
  ends_at_minute: 660, location_id: locationId, location_name: "RIVUS", location_timezone: "UTC", court_id: courtId, court_name: "Court 1" };
const lessonRow = { ...listed, kind: "booking", status: "confirmed", account_user_id: "cb000000-0000-4000-8000-0000000000aa",
  includes_coaching: true, coach_name: "Coach A", coaching_program_name: "Juniors", customer_name: "Ana", customer_email: "ana@example.test",
  total_amount_minor: 9000, currency: "RON" };
const reservationRow = { ...listed, id: reservationId, kind: "reservation", status: "active", reason: "Clinic",
  creator_name: "Coach A", creator_email: "coach@example.test" };
const lessonDetails = { id: lessonId, status: "confirmed", booking_date: "2099-01-01", starts_at_minute: 600, ends_at_minute: 660,
  location_name: "RIVUS", location_timezone: "UTC", court_name: "Court 1", customer_name: "Ana", customer_email: "ana@example.test",
  customer_phone: "+40 700", cancellation_notice_minutes: 1440, total_amount_minor: 9000, currency: "RON", payment_method: "online",
  account_user_id: null, created_at: "2026-10-06T10:00:00+00:00", includes_coaching: true, coach_name: "Coach A",
  coaching_program_name: "Juniors", coaching: null, coach_user_id: coachId };
const reservationDetails = { id: reservationId, court_id: courtId, coach_user_id: null, booking_date: "2099-01-01", starts_at_minute: 600,
  ends_at_minute: 720, reason: "Clinic", created_by_user_id: coachId, status: "active", created_at: "2026-10-01T08:00:00+00:00",
  updated_at: "2026-10-01T08:00:00.123456+00:00", cancelled_at: null, cancelled_by_user_id: null, hold_expires_at: null,
  court_name: "Court 1", court_active: true, location_id: locationId, location_name: "RIVUS", location_timezone: "UTC",
  location_active: true, archived_at: null, creator_name: "Coach A", creator_email: "coach@example.test", creator_phone: null, canceller_name: null };

beforeEach(() => { vi.clearAllMocks(); authorize.mockResolvedValue({ state: "active", userId: coachId, roles: ["coach"] }); });

test("Coach list URLs offer only lessons and own reservations, with statuses that never expose checkout state", () => {
  expect(parseCoachBookingQuery({ type: "court", status: "pending_payment", coach: otherCoachId }))
    .toMatchObject({ type: "all", status: "all", coach: "" });
  expect(parseCoachBookingQuery({ type: "coaching", status: "failed" }).status).toBe("all");
  expect(parseCoachBookingQuery({ type: "reservation", status: "confirmed" }).status).toBe("all");
  expect(coachListStatusOptions("all").map(([value]) => value)).toEqual(["confirmed", "active", "cancelled"]);
  expect(coachListStatusOptions("coaching").map(([value]) => value)).toEqual(["confirmed", "cancelled"]);
  expect(coachListStatusOptions("reservation").map(([value]) => value)).toEqual(["active", "cancelled"]);
  const query = parseCoachBookingQuery({ type: "coaching", status: "cancelled", sort: "scheduled", page: "2" });
  expect(coachBookingsHref(query)).toBe("/coach/bookings?type=coaching&status=cancelled&sort=scheduled&page=2");
});

test("Coach details return only to the Coach Calendar or the Coach List", () => {
  expect(parseCoachBookingReturn({ back: `/coach/bookings?view=calendar&location=${locationId}&date=2099-01-01&x=1` }))
    .toEqual({ href: `/coach/bookings?view=calendar&location=${locationId}&date=2099-01-01`, label: "Back to Calendar" });
  for (const back of ["/admin/bookings?view=calendar", "https://evil.test/coach/bookings?view=calendar", "//evil.test"])
    expect(parseCoachBookingReturn({ back, type: "reservation" })).toEqual({ href: "/coach/bookings?type=reservation", label: "Back to Bookings" });
});

test("the List is scoped in the query to the Coach and drops prices, payments and customer accounts", async () => {
  query.mockResolvedValueOnce([{ total: 2 }]).mockResolvedValueOnce([lessonRow, reservationRow]);
  // A forged Coach filter or court-only type cannot widen the scope.
  const result = await listCoachBookings(parseCoachBookingQuery({ type: "court", coach: otherCoachId }));
  const [countSql, countArgs] = query.mock.calls[0], [pageSql, pageArgs] = query.mock.calls[1];
  expect(countArgs).toEqual([null, null, null, null, null, "", "all", null, coachId]);
  expect(pageArgs).toEqual([...countArgs, 0, 20]);
  for (const sql of [countSql, pageSql]) {
    expect(sql).toContain("($9::uuid IS NULL OR (v.coach_user_id=$9 AND b.status IN ('confirmed','cancelled')))");
    expect(sql).toContain("($9::uuid IS NULL OR r.created_by_user_id=$9)");
  }
  expect(result.rows[0]).not.toHaveProperty("total_amount_minor");
  expect(result.rows[0]).not.toHaveProperty("currency");
  expect(result.rows[0]).not.toHaveProperty("account_user_id");
  expect(result.rows[0]).toMatchObject({ kind: "booking", customer_name: "Ana", coaching_program_name: "Juniors" });
  expect(result.rows[1]).toMatchObject({ kind: "reservation", reason: "Clinic" });
});

test("every Coach read authorizes first and fails closed", async () => {
  authorize.mockRejectedValue(new Error("not found"));
  await expect(listCoachBookings(parseCoachBookingQuery({}))).rejects.toThrow("not found");
  await expect(listCoachBookingFilterOptions()).rejects.toThrow("not found");
  await expect(getCoachLesson(lessonId)).rejects.toThrow("not found");
  await expect(getCoachDirectReservation(reservationId)).rejects.toThrow("not found");
  expect(query).not.toHaveBeenCalled();
  expect(clubs.listAdminLocations).not.toHaveBeenCalled();
});

test("lesson details expose only the Coach's own confirmed or cancelled lessons, without financial fields", async () => {
  query.mockResolvedValueOnce([lessonDetails]);
  const lesson = await getCoachLesson(lessonId);
  expect(lesson).toEqual({ id: lessonId, status: "confirmed", booking_date: "2099-01-01", starts_at_minute: 600, ends_at_minute: 660,
    location_name: "RIVUS", location_timezone: "UTC", court_name: "Court 1", coach_name: "Coach A", coaching_program_name: "Juniors",
    customer_name: "Ana", customer_email: "ana@example.test", customer_phone: "+40 700", created_at: "2026-10-06T10:00:00+00:00" });
  for (const row of [{ ...lessonDetails, coach_user_id: otherCoachId }, { ...lessonDetails, coach_user_id: null, includes_coaching: false },
    { ...lessonDetails, status: "pending_payment" }, { ...lessonDetails, status: "failed" }]) {
    query.mockResolvedValueOnce([row]);
    expect(await getCoachLesson(lessonId)).toBeNull();
  }
  query.mockResolvedValueOnce([]);
  expect(await getCoachLesson(lessonId)).toBeNull();
  query.mockClear();
  expect(await getCoachLesson("not-a-uuid")).toBeNull();
  expect(query).not.toHaveBeenCalled();
});

test("reservation details expose only the Coach's own reservations, with the owner action windows", async () => {
  const at = (iso: string) => new Date(iso);
  query.mockResolvedValueOnce([reservationDetails]);
  expect(await getCoachDirectReservation(reservationId, undefined, at("2098-12-31T00:00:00Z")))
    .toMatchObject({ started: false, editable: true, cancellable: true });
  // Owners may still cancel an in-progress reservation, as in the Coach Calendar and My Activity.
  query.mockResolvedValueOnce([reservationDetails]);
  expect(await getCoachDirectReservation(reservationId, undefined, at("2099-01-01T11:00:00Z")))
    .toMatchObject({ started: true, editable: true, cancellable: true });
  query.mockResolvedValueOnce([reservationDetails]);
  expect(await getCoachDirectReservation(reservationId, undefined, at("2099-01-01T12:00:00Z")))
    .toMatchObject({ editable: false, cancellable: false });
  query.mockResolvedValueOnce([{ ...reservationDetails, court_active: false }]);
  expect(await getCoachDirectReservation(reservationId, undefined, at("2098-12-31T00:00:00Z")))
    .toMatchObject({ editable: true, cancellable: false });
  query.mockResolvedValueOnce([{ ...reservationDetails, status: "cancelled" }]);
  expect(await getCoachDirectReservation(reservationId, undefined, at("2098-12-31T00:00:00Z")))
    .toMatchObject({ editable: false, cancellable: false });
  query.mockResolvedValueOnce([{ ...reservationDetails, created_by_user_id: otherCoachId }]);
  expect(await getCoachDirectReservation(reservationId)).toBeNull();
  query.mockResolvedValueOnce([]);
  expect(await getCoachDirectReservation(reservationId)).toBeNull();
});
