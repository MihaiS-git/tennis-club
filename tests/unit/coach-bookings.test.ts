import { beforeEach, expect, test, vi } from "vitest";

const { authorize, query, expire, clubs, lessonFacts } = vi.hoisted(() => ({ authorize: vi.fn(), query: vi.fn(), expire: vi.fn(),
  clubs: { listAdminLocations: vi.fn(), listAdminCourts: vi.fn() },
  lessonFacts: { pendingChange: vi.fn(), livePayment: vi.fn(), financials: vi.fn() } }));
vi.mock("@/lib/coaching/authorization", () => ({ requireActiveCoach: authorize }));
vi.mock("@/lib/admin/authorization", () => ({ requireActiveAdmin: vi.fn(() => { throw new Error("Admin only"); }) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({}) }));
vi.mock("@/lib/db/data-source", () => ({ getDataSource: async () => ({ manager: { query } }) }));
vi.mock("@/lib/db/repositories/clubs.repository", () => clubs);
vi.mock("@/lib/payments/hold-expiry", () => ({ expirePaymentHolds: expire }));
// Lesson details read in one snapshot over the same mocked manager.
vi.mock("@/lib/db/transaction", async (original) => ({ ...await original<typeof import("@/lib/db/transaction")>(),
  inReadSnapshot: (work: (manager: unknown) => unknown) => work({ query }) }));
vi.mock("@/lib/db/repositories/booking-adjustments.repository", async (original) => ({
  ...await original<typeof import("@/lib/db/repositories/booking-adjustments.repository")>(),
  listBookingsWithPendingChange: lessonFacts.pendingChange, listBookingsWithLivePayment: lessonFacts.livePayment }));
vi.mock("@/lib/payments/financials", async (original) => ({ ...await original<typeof import("@/lib/payments/financials")>(),
  bookingFinancials: lessonFacts.financials }));

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

beforeEach(() => {
  vi.clearAllMocks();
  query.mockReset();
  expire.mockReset().mockResolvedValue(0);
  authorize.mockResolvedValue({ state: "active", userId: coachId, roles: ["coach"] });
});

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
  lessonFacts.pendingChange.mockResolvedValue(new Map()); lessonFacts.livePayment.mockResolvedValue(new Set());
  lessonFacts.financials.mockResolvedValue({ refundable: 9000 });
  query.mockResolvedValueOnce([{ total: 2 }]).mockResolvedValueOnce([lessonRow, reservationRow]);
  // A forged Coach filter or court-only type cannot widen the scope.
  const result = await listCoachBookings(parseCoachBookingQuery({ type: "court", coach: otherCoachId }), undefined, new Date("2098-12-31T00:00:00Z"));
  expect(expire).toHaveBeenCalledExactlyOnceWith();
  expect(authorize.mock.invocationCallOrder[0]).toBeLessThan(expire.mock.invocationCallOrder[0]);
  expect(expire.mock.invocationCallOrder[0]).toBeLessThan(query.mock.invocationCallOrder[0]);
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
  // Cancel lesson state, as Lesson details decides it, never an amount.
  expect(result.rows[0]).toMatchObject({ cancellation: { availability: "eligible", startsAt: expect.stringMatching(/^2099-01-01T10:00:00/),
    refundAvailable: true } });
  expect(result.rows[1]).not.toHaveProperty("cancellation");
});

test("List lessons read their Cancel lesson state in one batch, and refund facts only for eligible lessons", async () => {
  const ids = [lessonId, "cb000000-0000-4000-8000-000000000011", "cb000000-0000-4000-8000-000000000012", "cb000000-0000-4000-8000-000000000013"];
  const rows = [{ ...lessonRow, id: ids[0] }, { ...lessonRow, id: ids[1] }, { ...lessonRow, id: ids[2], status: "cancelled" },
    { ...lessonRow, id: ids[3], booking_date: "2098-01-01" }];
  lessonFacts.pendingChange.mockResolvedValue(new Map([[ids[1], "cancellation"]])); lessonFacts.livePayment.mockResolvedValue(new Set());
  lessonFacts.financials.mockResolvedValue({ refundable: 0 });
  query.mockResolvedValueOnce([{ total: 4 }]).mockResolvedValueOnce(rows);
  const result = await listCoachBookings(parseCoachBookingQuery({}), undefined, new Date("2098-12-31T00:00:00Z"));
  expect(result.rows.map((row) => "cancellation" in row && row.cancellation.availability))
    .toEqual(["eligible", "cancellation_pending", "unavailable", "started"]);
  expect(result.rows.every((row) => "cancellation" in row && row.cancellation.refundAvailable === false)).toBe(true);
  expect(lessonFacts.pendingChange).toHaveBeenCalledExactlyOnceWith({ query }, ids);
  expect(lessonFacts.livePayment).toHaveBeenCalledExactlyOnceWith({ query }, ids);
  expect(lessonFacts.financials).toHaveBeenCalledExactlyOnceWith({ query }, ids[0]);
});

test("every Coach read authorizes first and fails closed", async () => {
  authorize.mockRejectedValue(new Error("not found"));
  await expect(listCoachBookings(parseCoachBookingQuery({}))).rejects.toThrow("not found");
  await expect(listCoachBookingFilterOptions()).rejects.toThrow("not found");
  await expect(getCoachLesson(lessonId)).rejects.toThrow("not found");
  await expect(getCoachDirectReservation(reservationId)).rejects.toThrow("not found");
  expect(query).not.toHaveBeenCalled();
  expect(expire).not.toHaveBeenCalled();
  expect(clubs.listAdminLocations).not.toHaveBeenCalled();
});

test("lesson details expose only the Coach's own confirmed or cancelled lessons, without financial fields", async () => {
  lessonFacts.pendingChange.mockResolvedValue(new Map()); lessonFacts.livePayment.mockResolvedValue(new Set());
  lessonFacts.financials.mockResolvedValue({ refundable: 9000 });
  query.mockResolvedValueOnce([lessonDetails]);
  const lesson = await getCoachLesson(lessonId, undefined, new Date("2098-12-31T00:00:00Z"));
  // Cancellation availability, never an amount.
  expect(lesson).toEqual({ id: lessonId, status: "confirmed", booking_date: "2099-01-01", starts_at_minute: 600, ends_at_minute: 660,
    location_name: "RIVUS", location_timezone: "UTC", court_name: "Court 1", coach_name: "Coach A", coaching_program_name: "Juniors",
    customer_name: "Ana", customer_email: "ana@example.test", customer_phone: "+40 700", created_at: "2026-10-06T10:00:00+00:00",
    cancellation: { availability: "eligible", startsAt: expect.stringMatching(/^2099-01-01T10:00:00/), refundAvailable: true } });
  query.mockResolvedValueOnce([lessonDetails]);
  expect((await getCoachLesson(lessonId, undefined, new Date("2099-01-01T10:00:00Z")))?.cancellation.availability).toBe("started");
  lessonFacts.pendingChange.mockResolvedValueOnce(new Map([[lessonId, "cancellation"]]));
  query.mockResolvedValueOnce([lessonDetails]);
  expect((await getCoachLesson(lessonId, undefined, new Date("2098-12-31T00:00:00Z")))?.cancellation.availability).toBe("cancellation_pending");
  lessonFacts.financials.mockResolvedValueOnce({ refundable: 0 });
  query.mockResolvedValueOnce([{ ...lessonDetails, status: "cancelled" }]);
  expect((await getCoachLesson(lessonId))?.cancellation).toMatchObject({ availability: "unavailable", refundAvailable: false });
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
