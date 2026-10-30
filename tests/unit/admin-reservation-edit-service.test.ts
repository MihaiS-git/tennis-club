import { createClient } from "@supabase/supabase-js";
import { QueryFailedError } from "typeorm";
import { beforeEach, expect, expectTypeOf, test, vi } from "vitest";
import type { AdminBooking, AdminReservation } from "@/lib/reservations/service";
import type { BookingEditContext } from "@/lib/bookings/reschedule";
import type { CurrentAccount } from "@/lib/auth/account";

const { account, query, command } = vi.hoisted(() => ({ account: vi.fn(), query: vi.fn(), command: vi.fn() }));
vi.mock("@/lib/auth/account", () => ({ readCurrentAccount: account }));
vi.mock("@/lib/db/data-source", () => ({ getDataSource: async () => ({ manager: { query } }) }));
vi.mock("@/lib/reservations/commands", () => ({ editDirectReservationCommand: command }));
import { getAdminReservationEditDay, getReservationDay } from "@/lib/reservations/service";
import { logger } from "@/lib/logger";
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn() } }));

const id = (n: number) => `ca000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const now = new Date("2026-10-15T09:00:00Z"), date = "2026-10-15";
const token = "2026-10-01T12:00:00.123456+00:00";
const location = { id: id(1), name: "Club", timezone: "UTC", is_active: true, archived_at: null,
  courts: [{ id: id(3), name: "Court B", is_active: true }, { id: id(2), name: "Court A", is_active: true }] };
const target = { coach_user_id: null, id: id(5), court_id: id(2), booking_date: date, starts_at_minute: 600, ends_at_minute: 660,
  reason: "Practice", status: "active", updated_at: token, created_at: token, created_by_user_id: id(6),
  cancelled_at: null, cancelled_by_user_id: null, hold_expires_at: null,
  court_name: "Court A", court_active: true, location_id: id(1), location_name: "Club",
  location_timezone: "UTC", location_active: true, archived_at: null };
const row = { court_id: id(3), starts_at_minute: 600, ends_at_minute: 660, status: "active", hold_expires_at: null, capture_accepted: false };
const hours = { id: id(4), location_id: id(1), weekday: 3, opens_at_minute: 600, closes_at_minute: 840, created_at: token, updated_at: token };
const client = createClient("http://localhost:54321", "user-key", { auth: { persistSession: false } });
const load = (requestedDate = date) => getAdminReservationEditDay({ reservationId: target.id, date: requestedDate }, client, now);

beforeEach(() => {
  vi.clearAllMocks(); query.mockReset(); command.mockReset();
  account.mockResolvedValue({ state: "active", userId: id(6), roles: ["admin"] });
  query.mockImplementation(async (sql: string) => {
    if (sql.includes("r.id = $1")) return [target];
    if (sql.includes("court_reservations")) return [row];
    if (sql.includes("location_opening_hours")) return [hours];
    return [location];
  });
});

test.each<CurrentAccount>([
  { state: "unauthenticated" },
  { state: "active", userId: id(6), email: "member@example.test", roles: [] },
  { state: "suspended", userId: id(6), email: "admin@example.test", roles: ["admin"] },
])("rejects non-Admins before persistence: %j", async (state) => {
  account.mockResolvedValue(state);
  await expect(load()).rejects.toThrow();
  expect(query).not.toHaveBeenCalled(); expect(command).not.toHaveBeenCalled();
});

test("preserves current values, microsecond token, fixed location and court/occupancy order", async () => {
  const result = await load("2026-10-16");
  expect(account.mock.invocationCallOrder[0]).toBeLessThan(query.mock.invocationCallOrder[0]);
  expect(result.reservation).toEqual({ location_id: id(1), location_timezone: "UTC", court_id: id(2), booking_date: date,
    starts_at_minute: 600, ends_at_minute: 660, reason: "Practice", updated_at: token,
    occupancy: [{ court_id: id(3), starts_at_minute: 600, ends_at_minute: 660 }] });
  expect(result.day.courts.map((court) => court.court.id)).toEqual([id(3), id(2)]);
  expect(query.mock.calls[0][1]).toEqual([target.id, null]);
  expect(query.mock.calls[0][0]).toContain("NOT EXISTS(SELECT 1 FROM public.checkout_records");
  expect(query.mock.calls[0][0]).toContain("AND c.is_active");
  expect(query.mock.calls[1][1]).toEqual(["2026-10-16", id(1), target.id, 0, 1000]);
  expect(query.mock.calls.every(([sql]) => !/INSERT|UPDATE|DELETE/.test(sql))).toBe(true);
});

test("active/live held intervals block; equal and expired deadlines do not", async () => {
  query.mockImplementation(async (sql: string) => {
    if (sql.includes("r.id = $1")) return [target];
    if (sql.includes("court_reservations")) return [row,
      { ...row, starts_at_minute: 660, ends_at_minute: 720, status: "held", hold_expires_at: "2026-10-15T09:00:00.000001Z" },
      { ...row, status: "held", hold_expires_at: now.toISOString() },
      { ...row, status: "held", hold_expires_at: "2026-10-15T08:59:59Z" }];
    if (sql.includes("location_opening_hours")) return [hours];
    return [location];
  });
  const result = await load();
  expect(result.reservation.occupancy).toEqual([
    { court_id: id(3), starts_at_minute: 600, ends_at_minute: 660 },
    { court_id: id(3), starts_at_minute: 660, ends_at_minute: 720 },
  ]);
  expect(result.day.courts[0].cells).toEqual(["booked", "booked", "booked", "booked", "available", "available", "available", "available"]);
  expect(result.day.courts[1].cells.every((cell) => cell === "available")).toBe(true);
});

test.each([{ rows: [] }])("unavailable targets fail before occupancy: %j", async ({ rows }) => {
  query.mockResolvedValueOnce(rows);
  await expect(load()).rejects.toThrow("This reservation is no longer available to edit.");
  expect(query).toHaveBeenCalledTimes(1);
  expect(logger.error).not.toHaveBeenCalled();
});

test.each(["08006", "42P01", "23P01"])("SQLSTATE %s during an edit read is an operational failure, not unavailable occupancy", async code => {
  query.mockRejectedValueOnce(new QueryFailedError("private SQL", ["private parameter"],
    Object.assign(new Error("sensitive database detail"), { code, constraint: "court_reservation_no_overlap" })));
  await expect(load()).rejects.toThrow(/^Unable to load reservation edit details\.$/);
  expect(logger.error).toHaveBeenCalledWith({ event: "reservations.admin_edit_availability_failed", code }, "Failed to load Admin edit context");
  expect(query).toHaveBeenCalledTimes(1);
});

test("malformed persistence results are operational failures", async () => {
  query.mockResolvedValueOnce([{ ...target, court_id: "invalid" }]);
  await expect(load()).rejects.toThrow(/^Unable to load reservation edit details\.$/);
  expect(query).toHaveBeenCalledTimes(1);
});

test("occupancy read failures retain their safe operational error", async () => {
  query.mockResolvedValueOnce([target]).mockRejectedValueOnce(new Error("private connection details"));
  await expect(load()).rejects.toThrow(/^Unable to load court availability\.$/);
  expect(query).toHaveBeenCalledTimes(2);
});

test("invalid input is rejected before persistence", async () => {
  await expect(load("invalid")).rejects.toThrow(/^Choose a valid date\.$/);
  expect(query).not.toHaveBeenCalled();
});

test.each(["online", "pay_at_club", null])("staff projection requires a contractual payment method for bookings: %j", async paymentMethod => {
  const direct = { ...target, includes_coaching: false, coach_name: null, coaching_program_name: null, coaching: null, location_name: null, court_name: null, location_timezone: null, kind: "reservation", creator_name: null, creator_email: null, creator_phone: null,
    account_user_id: null, payment_method: null, customer_name: null, customer_email: null, customer_phone: null,
    cancellation_notice_minutes: null, total_amount_minor: null, currency: null, payment_facts: [], refund_facts: [] };
  const booking = { ...direct, id: id(7), kind: "booking", payment_method: paymentMethod,
    customer_name: "Customer", customer_email: "snapshot@example.test", customer_phone: "123",
    cancellation_notice_minutes: 120, total_amount_minor: 5000, currency: "RON" };
  query.mockImplementation(async (sql: string) => {
    if (sql.includes("payment_facts")) return [direct, booking];
    if (sql.includes("court_reservations")) return [row];
    return [hours];
  });
  const result = getReservationDay(location, date, now, client);
  if (paymentMethod === null) await expect(result).rejects.toThrow(/^Unable to load reservation details\.$/);
  else expect((await result).adminOccupancy).toMatchObject([
    { kind: "reservation", id: target.id }, { kind: "booking", payment_method: paymentMethod },
  ]);
});

// Compile-time contract, enforced by `npm run typecheck` rather than registered as a runtime case:
// staff DTOs require identity, contacts, payments and refund state.
expectTypeOf<Omit<AdminReservation, "creator_email">>().not.toExtend<AdminReservation>();
expectTypeOf<Omit<AdminReservation, "creator_phone">>().not.toExtend<AdminReservation>();
expectTypeOf<Omit<AdminReservation, "payment_method">>().not.toExtend<AdminReservation>();
expectTypeOf<Omit<AdminBooking, "account_user_id">>().not.toExtend<AdminBooking>();
expectTypeOf<Omit<AdminBooking, "payment_status">>().not.toExtend<AdminBooking>();
expectTypeOf<Omit<AdminBooking, "stripe_refund_available">>().not.toExtend<AdminBooking>();
expectTypeOf<Omit<BookingEditContext, "refunds">>().not.toExtend<BookingEditContext>();

test.each([false, true])("projects complete nullable staff details (captured Stripe payment=%s)", async captured => {
  const direct = { ...target, includes_coaching: false, coach_name: null, coaching_program_name: null, coaching: null, location_name: null, court_name: null, location_timezone: null, kind: "reservation", creator_name: captured ? "Coach" : null,
    creator_email: captured ? "coach@example.test" : null, creator_phone: captured ? "123" : null,
    account_user_id: null, payment_method: null, customer_name: null, customer_email: null, customer_phone: null,
    cancellation_notice_minutes: null, total_amount_minor: null, currency: null, payment_facts: [], refund_facts: [] };
  const payment = { id: id(8), booking_id: id(7), method: "online", provider: "stripe", provider_payment_id: "pi_test",
    amount_minor: 5000, currency: "RON", status: "succeeded", expires_at: null, created_at: token };
  const booking = { ...direct, id: id(7), kind: "booking", account_user_id: captured ? id(6) : null,
    payment_method: captured ? "online" : "pay_at_club", payment_facts: captured ? [payment] : [],
    customer_name: "Customer", customer_email: "snapshot@example.test", customer_phone: "123",
    cancellation_notice_minutes: 120, total_amount_minor: 5000, currency: "RON" };
  query.mockImplementation(async (sql: string) => {
    if (sql.includes("payment_facts")) return [direct, booking];
    if (sql.includes("court_reservations")) return [row];
    return [hours];
  });
  const result = await getReservationDay(location, date, now, client);
  expect(query.mock.calls.find(([sql]) => sql.includes("payment_facts"))?.[1]).toEqual([[id(3), id(2)], date]);
  expect(result.adminOccupancy).toEqual([
    { kind: "reservation", id: target.id, court_id: target.court_id, booking_date: date,
      starts_at_minute: 600, ends_at_minute: 660, reason: target.reason, created_by_user_id: target.created_by_user_id,
      creator_name: direct.creator_name, creator_email: direct.creator_email, creator_phone: direct.creator_phone, payment_method: null },
    { kind: "booking", includes_coaching: false, coach_user_id: null, coach_name: null, coaching_program_name: null, coaching: null, location_name: null, court_name: null, location_timezone: null, id: booking.id, court_id: booking.court_id, booking_date: date,
      starts_at_minute: 600, ends_at_minute: 660, account_user_id: booking.account_user_id, payment_method: booking.payment_method,
      payment_status: captured ? { operation: "payment", status: "succeeded", provider: "stripe" } : null,
      stripe_refund_available: captured, customer_name: booking.customer_name, customer_email: booking.customer_email,
      customer_phone: booking.customer_phone, cancellation_notice_minutes: 120, total_amount_minor: 5000, currency: "RON" },
  ]);
});

test("a dual-role account receives Coach occupancy and actions in the Coach calendar", async () => {
  account.mockResolvedValue({ state: "active", userId: id(6), roles: ["admin", "coach"] });
  query.mockImplementation(async (sql: string) => {
    if (sql.includes("payment_facts")) return [];
    if (sql.includes("court_reservations")) return [row];
    return [hours];
  });
  expect(await getReservationDay(location, date, now, client, "coach")).toMatchObject({ canManage: false, actorUserId: id(6) });
  expect(await getReservationDay(location, date, now, client, "admin")).toMatchObject({ canManage: true, actorUserId: id(6) });
});

const at = (minute: number) => new Date(Date.UTC(2026, 9, 1, 12, minute));
const succeededPayment = (n: number, minute: number) => ({ id: id(n), booking_id: id(7), method: "online",
  provider: "stripe", provider_payment_id: "pi_test", amount_minor: 5000, currency: "RON", status: "succeeded",
  expires_at: null, created_at: at(minute).toISOString() });
const refund = (n: number, minute: number, status: string) => ({ id: id(n), provider: "stripe", status, created_at: at(minute).toISOString() });
test.each([
  ["one successful payment", [succeededPayment(20, 0)], [], { operation: "payment", status: "succeeded", provider: "stripe" }],
  ["multiple successful payments", [succeededPayment(21, 0), succeededPayment(20, 5)], [], { operation: "payment", status: "succeeded", provider: "stripe" }],
  ["payment followed by refund", [succeededPayment(20, 0)], [refund(30, 10, "succeeded")], { operation: "refund", status: "succeeded", provider: "stripe" }],
  ["refund retry pending", [succeededPayment(20, 0)], [refund(30, 10, "pending_retry")], { operation: "refund", status: "pending", provider: "stripe" }],
  ["refund failed", [succeededPayment(20, 0)], [refund(30, 10, "failed")], { operation: "refund", status: "failed", provider: "stripe" }],
  ["later payment pending", [succeededPayment(20, 0), { ...succeededPayment(21, 10), status: "pending" }], [refund(30, 5, "succeeded")],
    { operation: "payment", status: "pending", provider: "stripe" }],
  ["later payment failed", [succeededPayment(20, 0), { ...succeededPayment(21, 10), status: "failed" }], [],
    { operation: "payment", status: "failed", provider: "stripe" }],
  ["abandoned checkout and voided refund ignored", [succeededPayment(20, 0), { ...succeededPayment(21, 10), status: "expired" }],
    [refund(30, 15, "voided")], { operation: "payment", status: "succeeded", provider: "stripe" }],
  ["same-time tie broken by ID", [succeededPayment(20, 0)], [refund(30, 0, "pending")], { operation: "refund", status: "pending", provider: "stripe" }],
  ["pay at club due", [{ ...succeededPayment(20, 0), method: "pay_at_club", provider: null, provider_payment_id: null, status: "due" }], [],
    { operation: "payment", status: "due", provider: null }],
] as const)("dialog payment status is the latest financial operation: %s", async (_name, payments, refunds, expected) => {
  const booking = { ...target, includes_coaching: false, coach_name: null, coaching_program_name: null, coaching: null,
    location_name: null, court_name: null, location_timezone: null, creator_name: null, creator_email: null, creator_phone: null,
    id: id(7), kind: "booking", account_user_id: null, payment_method: expected.status === "due" ? "pay_at_club" : "online",
    payment_facts: payments, refund_facts: refunds,
    customer_name: "Customer", customer_email: "snapshot@example.test", customer_phone: "123",
    cancellation_notice_minutes: 120, total_amount_minor: 5000, currency: "RON" };
  query.mockImplementation(async (sql: string) => {
    if (sql.includes("payment_facts")) return [booking];
    if (sql.includes("court_reservations")) return [row];
    return [hours];
  });
  const [result] = (await getReservationDay(location, date, now, client)).adminOccupancy;
  expect(result).toMatchObject({ kind: "booking", payment_status: expected });
});
