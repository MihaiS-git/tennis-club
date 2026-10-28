import { beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({ authorize: vi.fn(), snapshot: vi.fn(), details: vi.fn(), revisions: vi.fn(), adjustments: vi.fn(),
  facts: vi.fn(), history: vi.fn(), pendingChange: vi.fn(), livePayment: vi.fn(), manager: { snapshot: true } }));
vi.mock("@/lib/admin/authorization", () => ({ requireActiveAdmin: mocks.authorize }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({}) }));
vi.mock("@/lib/db/data-source", () => ({ getDataSource: async () => ({ manager: {} }) }));
vi.mock("@/lib/db/transaction", () => ({ inReadSnapshot: mocks.snapshot }));
vi.mock("@/lib/db/repositories/bookings.repository", () => ({ findAdminBookingDetails: mocks.details }));
vi.mock("@/lib/db/repositories/booking-revisions.repository", () => ({ listBookingRevisions: mocks.revisions }));
vi.mock("@/lib/db/repositories/booking-adjustments.repository", () => ({ listBookingAdjustments: mocks.adjustments,
  listBookingsWithPendingChange: mocks.pendingChange, listBookingsWithLivePayment: mocks.livePayment }));
vi.mock("@/lib/db/repositories/payments.repository", () => ({ loadAdminTransactionContext: mocks.facts }));
vi.mock("@/lib/payments/financial-history", async (original) => ({
  ...await original<typeof import("@/lib/payments/financial-history")>(), readFinancialHistory: mocks.history }));
vi.mock("@/lib/payments/admin", () => ({ toAdminPaymentTransaction: (row: unknown) => row }));
vi.mock("@/lib/payments/hold-expiry", () => ({ expirePaymentHolds: async () => 0 }));

import { adminBookingEditable, adminCancellationAvailability, buildBookingHistory, hasRecordedChanges, summarizeBookingFinancials } from "@/lib/bookings/admin-history";
import { getAdminBookingRecords, type AdminBookingDetails } from "@/lib/bookings/admin-details";
import { summarizeReportedFinancials } from "@/lib/payments/financials";

const bookingId = "b1000000-0000-4000-8000-0000000000b0";
const uuid = (n: number) => `b1000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
type Revision = Parameters<typeof buildBookingHistory>[0]["revisions"][number];
type Adjustment = Parameters<typeof buildBookingHistory>[0]["adjustments"][number];
const terms = { courtId: uuid(70), locationName: "Central", courtName: "Court 1", timezone: "Europe/Bucharest", bookingDate: "2026-11-02",
  startMinute: 600, endMinute: 660, totalAmountMinor: 5000, currency: "RON" as const, paymentMethod: "online" as const };
const revision = (n: number, overrides: Partial<Revision> = {}): Revision => ({ ...terms, id: uuid(n), revisionNumber: n,
  kind: n === 1 ? "created" : "rescheduled", bookingState: "confirmed", actorScope: "customer",
  recordedAt: new Date(`2026-10-0${n}T08:00:00Z`), adjustmentId: null, cancellationCause: null, ...overrides });
const adjustment = (overrides: Partial<Adjustment>): Adjustment => ({ id: uuid(90), baseRevisionId: uuid(1), kind: "reschedule",
  scope: "owner", status: "pending", newTotal: 7500, currency: "RON", createdAt: new Date("2026-10-05T09:00:00Z"),
  target: { courtId: uuid(70), date: "2026-11-03", startMinute: 600, endMinute: 690, expectedUpdatedAt: "x",
    courtName: "Court 2", locationName: "Central", timezone: "Europe/Bucharest" }, ...overrides });

test("timeline starts with the original snapshot and needs no changes to be complete", () => {
  const events = buildBookingHistory({ status: "confirmed", revisions: [revision(1, { actorScope: "guest" })], adjustments: [] });
  expect(events).toEqual([expect.objectContaining({ kind: "created", label: "Booking created", recorded: true,
    at: "2026-10-01T08:00:00.000Z", previous: null, detail: "Booked by guest · Online payment",
    next: expect.objectContaining({ date: "2026-11-02", startMinute: 600, endMinute: 660, total: 5000, currency: "RON" }),
    status: { label: "Confirmed", tone: "success" } })]);
  expect(hasRecordedChanges(events)).toBe(false);
});

test("multiple modifications use recorded predecessor snapshots and their own snapshotted totals", () => {
  const revisions = [
    revision(1, { bookingState: "pending_payment" }),
    revision(2, { kind: "confirmed", actorScope: "provider" }),
    revision(3, { endMinute: 720, totalAmountMinor: 9000, adjustmentId: uuid(91) }),
    revision(4, { startMinute: 630, endMinute: 690, totalAmountMinor: 4200 }),
    revision(5, { bookingDate: "2026-11-09", startMinute: 630, endMinute: 690, totalAmountMinor: 4200, courtName: "Renamed court" }),
    revision(6, { kind: "cancelled", bookingState: "cancelled", bookingDate: "2026-11-09", startMinute: 630, endMinute: 690,
      totalAmountMinor: 4200, cancellationCause: "admin_cancelled", actorScope: "admin" }),
  ];
  // Supplied out of order: the timeline still follows the recorded chain.
  const events = buildBookingHistory({ status: "cancelled", revisions: [...revisions].reverse(),
    adjustments: [adjustment({ id: uuid(91), status: "applied", createdAt: new Date("2026-10-02T20:00:00Z") })] });
  expect(events.map(event => event.label)).toEqual(["Booking created", "Booking confirmed", "Extended", "Reduced", "Rescheduled", "Cancelled"]);
  expect(events[0].status.label).toBe("Awaiting payment");
  expect(events[1]).toMatchObject({ detail: "Confirmed by verified payment", previous: null, next: null });
  expect(events[2]).toMatchObject({ requestedAt: "2026-10-02T20:00:00.000Z",
    previous: expect.objectContaining({ endMinute: 660, total: 5000 }), next: expect.objectContaining({ endMinute: 720, total: 9000 }) });
  expect(events[3]).toMatchObject({ previous: expect.objectContaining({ total: 9000 }), next: expect.objectContaining({ total: 4200 }) });
  expect(events[4].next).toMatchObject({ date: "2026-11-09", courtName: "Renamed court", total: 4200 });
  expect(events[5]).toMatchObject({ kind: "cancelled", detail: "Cancelled by an administrator",
    status: { label: "Cancelled" }, next: expect.objectContaining({ total: 4200 }) });
  expect(events.every(event => event.recorded)).toBe(true);
  expect(hasRecordedChanges(events)).toBe(true);
});

test("a move between two distinct courts with the same name is a reschedule; a renamed court is not", () => {
  const moved = buildBookingHistory({ status: "confirmed", adjustments: [],
    revisions: [revision(1), revision(2, { courtId: uuid(71) })] });
  expect(moved[1]).toMatchObject({ label: "Rescheduled", previous: { courtId: uuid(70), courtName: "Court 1" },
    next: { courtId: uuid(71), courtName: "Court 1" } });
  const renamed = buildBookingHistory({ status: "confirmed", adjustments: [],
    revisions: [revision(1), revision(2, { courtName: "Court A" })] });
  expect(renamed[1].label).toBe("Booking details updated");
  const longer = buildBookingHistory({ status: "confirmed", adjustments: [],
    revisions: [revision(1), revision(2, { courtId: uuid(71), endMinute: 720 }), revision(3, { courtId: uuid(71), endMinute: 690 }),
      revision(4, { courtId: uuid(71), endMinute: 690, totalAmountMinor: 6000 })] });
  expect(longer.map(event => event.label)).toEqual(["Booking created", "Extended", "Reduced", "Price updated"]);
});

test("unapplied change requests appear chronologically with their recorded proposal, not as accepted changes", () => {
  const events = buildBookingHistory({ status: "confirmed", revisions: [revision(1), revision(2, { totalAmountMinor: 5000, startMinute: 660, endMinute: 720,
    recordedAt: new Date("2026-10-08T08:00:00Z") })], adjustments: [
    adjustment({ id: uuid(92), status: "unsuccessful" }),
    adjustment({ id: uuid(93), kind: "cancellation", status: "pending", scope: "admin", baseRevisionId: uuid(2), createdAt: new Date("2026-10-09T09:00:00Z") }),
  ] });
  expect(events.map(event => [event.label, event.status.label])).toEqual([["Booking created", "Confirmed"],
    ["Modification requested", "Failed"], ["Rescheduled", "Confirmed"], ["Cancellation requested", "Pending"]]);
  expect(events[1]).toMatchObject({ kind: "request", previous: expect.objectContaining({ total: 5000 }),
    next: expect.objectContaining({ courtName: "Court 2", endMinute: 690, total: 7500 }) });
  expect(events[3]).toMatchObject({ next: null, previous: expect.objectContaining({ startMinute: 660 }),
    detail: "Requested by an administrator · not applied yet" });
});

test("a status changed without a revision is shown as inferred, without an invented time", () => {
  const events = buildBookingHistory({ status: "expired", revisions: [revision(1, { bookingState: "pending_payment" })], adjustments: [] });
  expect(events.at(-1)).toMatchObject({ kind: "status", label: "Checkout expired", recorded: false, at: null,
    status: { label: "Expired" } });
  expect(hasRecordedChanges(events)).toBe(false);
});

const facts = (input: Partial<Parameters<typeof summarizeReportedFinancials>[0]> = {}) => summarizeReportedFinancials({
  payments: [], captures: [], refunds: [], executions: [], ...input });
const attempt = (n: number, amountMinor: number, status: "succeeded" | "pending" | "failed" | "cancelled" | "expired" | "due") =>
  ({ id: uuid(n), provider: "stripe" as const, providerPaymentId: `pi_${n}`, amountMinor, currency: "RON" as const, status, adjustmentId: null });
const capture = (n: number, amountMinor: number) => ({ id: uuid(n + 100), paymentAttemptId: uuid(n), provider: "stripe" as const,
  providerPaymentId: `pi_${n}`, providerCaptureId: `ch_${n}`, amountMinor, currency: "RON" as const, firstObservedAt: new Date() });
const refund = (n: number, amountMinor: number, status: "pending" | "pending_retry" | "succeeded" | "failed" | "voided") =>
  ({ id: uuid(n), provider: "stripe" as const, providerPaymentId: "pi_1", amountMinor, currency: "RON" as const, status });
const execution = (n: number, amountMinor: number) => ({ refundId: uuid(n), provider: "stripe" as const, providerPaymentId: "pi_1",
  providerRefundId: `re_${n}`, amountMinor, currency: "RON" as const, status: "succeeded" as const, terminalResult: "succeeded" as const });
const summarize = (financials: ReturnType<typeof facts>, overrides: Partial<Parameters<typeof summarizeBookingFinancials>[0]> = {}) =>
  summarizeBookingFinancials({ status: "confirmed", total: 5000, currency: "RON", paymentMethod: "online", ended: false,
    financials, outstanding: 0, ...overrides });

test("multiple captures and partial refunds count only verified money; failed, cancelled and expired attempts collect nothing", () => {
  const financials = facts({
    payments: [attempt(1, 5000, "succeeded"), attempt(2, 2500, "succeeded"), attempt(3, 900, "failed"), attempt(4, 800, "cancelled"),
      attempt(5, 700, "expired"), attempt(6, 600, "pending")],
    captures: [capture(1, 5000), capture(2, 2500)],
    refunds: [refund(11, 1000, "succeeded"), refund(12, 500, "succeeded"), refund(13, 400, "succeeded"), refund(14, 300, "pending_retry"),
      refund(15, 200, "failed"), refund(16, 100, "voided")],
    // Refund 13 claims success without a verified execution, so it is not refunded.
    executions: [execution(11, 1000), execution(12, 500)],
  });
  expect(summarize(financials)).toMatchObject({ paid: 7500, refunded: 1500, net: 6000, pendingPayments: 600,
    pendingRefunds: 700, failedRefunds: 200, outstanding: 0, dueAtClub: 0 });
});

test("outstanding online debt is shown only for active bookings; club amounts are never received", () => {
  expect(summarize(facts(), { status: "pending_payment", outstanding: 5000 })).toMatchObject({ paid: 0, outstanding: 5000, activeBooking: true });
  const club = facts({ payments: [{ ...attempt(1, 5000, "due"), provider: null, providerPaymentId: null }] });
  expect(summarize(club, { paymentMethod: "pay_at_club", outstanding: 5000 })).toMatchObject({ paid: 0, pendingPayments: 0,
    outstanding: 0, dueAtClub: 5000, unrecordedAtClub: 0 });
  expect(summarize(club, { paymentMethod: "pay_at_club", outstanding: 5000, ended: true })).toMatchObject({ paid: 0, dueAtClub: 0, unrecordedAtClub: 5000 });
  expect(summarize(facts(), { status: "cancelled" })).toMatchObject({ activeBooking: false, outstanding: 0 });
});

const booking = { id: bookingId, status: "confirmed", booking_date: "2026-11-02", starts_at_minute: 600, ends_at_minute: 660,
  location_name: "Central", location_timezone: "Europe/Bucharest", court_name: "Court 1", customer_name: "Guest",
  customer_email: "guest@example.test", customer_phone: "1", cancellation_notice_minutes: 1440, total_amount_minor: 5000,
  currency: "RON", payment_method: "online", account_user_id: null, created_at: "2026-10-01T08:00:00+00:00",
  includes_coaching: false, coach_name: null, coaching_program_name: null, coaching: null, coach_user_id: null } satisfies AdminBookingDetails;
const row = (kind: "payment" | "refund" | "booking", n: number) => ({ transaction_kind: kind, transaction_id: uuid(n) });
// 1,001 operations: 1,000 failed attempts plus one captured payment, all for this booking.
const own = <T,>(attempt: T) => ({ ...attempt, bookingId });
const manyAttempts = [attempt(1, 5000, "succeeded"), ...Array.from({ length: 1000 }, (_, index) => attempt(1000 + index, 900, "failed"))].map(own);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authorize.mockResolvedValue({ userId: uuid(99), roles: ["admin"] });
  mocks.snapshot.mockImplementation(async (work: (manager: unknown) => unknown) => work(mocks.manager));
  mocks.details.mockResolvedValue(booking);
  mocks.revisions.mockResolvedValue([revision(1)]); mocks.adjustments.mockResolvedValue([]);
  mocks.pendingChange.mockResolvedValue(new Map()); mocks.livePayment.mockResolvedValue(new Set());
  mocks.facts.mockResolvedValue({ payments: [own(attempt(1, 5000, "succeeded"))], captures: [capture(1, 5000)], refunds: [], executions: [],
    revisions: [], adjustments: [] });
});

test("records authorize before opening the snapshot and propagate authorization failures", async () => {
  mocks.authorize.mockRejectedValue(new Error("Forbidden"));
  await expect(getAdminBookingRecords(bookingId)).rejects.toThrow("Forbidden");
  expect(mocks.snapshot).not.toHaveBeenCalled(); expect(mocks.details).not.toHaveBeenCalled();
  expect(mocks.facts).not.toHaveBeenCalled(); expect(mocks.history).not.toHaveBeenCalled();
  mocks.authorize.mockResolvedValue({ userId: uuid(99), roles: ["admin"] });
  expect(await getAdminBookingRecords("not-a-booking")).toBeNull();
  expect(mocks.snapshot).not.toHaveBeenCalled();
});

test("booking, revisions, requests, facts and the history page are all read in one snapshot", async () => {
  mocks.history.mockResolvedValue({ rows: [row("payment", 1)], page: 1, total: 1, totalPages: 1 });
  const records = await getAdminBookingRecords(bookingId, { now: new Date("2026-10-18T00:00:00Z") });
  expect(mocks.authorize.mock.invocationCallOrder[0]).toBeLessThan(mocks.snapshot.mock.invocationCallOrder[0]);
  expect(mocks.snapshot).toHaveBeenCalledOnce();
  for (const read of [mocks.details, mocks.revisions, mocks.adjustments, mocks.facts, mocks.history])
    expect(read.mock.calls[0][0]).toBe(mocks.manager);
  expect(records?.booking).toEqual(booking);
  expect(records?.history.map(event => event.label)).toEqual(["Booking created"]);
  mocks.details.mockResolvedValue(null);
  expect(await getAdminBookingRecords(bookingId)).toBeNull();
});

test("history beyond 1,000 operations is paged on the server while the summary covers every operation", async () => {
  mocks.facts.mockResolvedValue({ payments: manyAttempts, captures: [capture(1, 5000)], refunds: [], executions: [], revisions: [], adjustments: [] });
  mocks.history.mockResolvedValue({ rows: [row("payment", 1999)], page: 51, total: 1001, totalPages: 51 });
  const records = await getAdminBookingRecords(bookingId, { historyPage: 51 });
  expect(records?.operations).toEqual({ rows: [row("payment", 1999)], page: 51, total: 1001, totalPages: 51 });
  // Facts load once per request; the requested page reuses them and their summary instead of reloading.
  expect(mocks.facts).toHaveBeenCalledOnce();
  expect(mocks.facts).toHaveBeenCalledWith(mocks.manager, { bookingIds: [bookingId], revisionIds: [], adjustmentIds: [] });
  expect(mocks.history).toHaveBeenCalledOnce();
  const [, query, preloaded] = mocks.history.mock.calls[0];
  expect(query).toMatchObject({ page: 51, sort: "date", direction: "asc", status: "all", bookingId, search: "", attention: false });
  expect(preloaded.facts).toMatchObject({ payments: manyAttempts, revisions: [revision(1)], adjustments: [] });
  expect(preloaded.financials.get(bookingId).totals).toEqual([expect.objectContaining({ currency: "RON", captured: 5000 })]);
  expect(records?.summary).toMatchObject({ paid: 5000, net: 5000, pendingPayments: 0, outstanding: 0 });
});

test("invalid history pages fall back to the first page; a booking without attempts has no operations", async () => {
  mocks.history.mockResolvedValue({ rows: [row("booking", 4)], page: 1, total: 1, totalPages: 1 });
  const records = await getAdminBookingRecords(bookingId, { historyPage: -3 });
  expect(mocks.history.mock.calls[0][1].page).toBe(1);
  expect(records?.operations).toEqual({ rows: [], page: 1, total: 0, totalPages: 1 });
});

test("database failures surface a generic error", async () => {
  mocks.snapshot.mockRejectedValue(new Error("could not serialize access"));
  await expect(getAdminBookingRecords(bookingId)).rejects.toThrow("Unable to load booking history. Try again.");
});

test("Admin cancellation is offered only for confirmed bookings before start without a change in progress", () => {
  const base = { status: "confirmed" as const, startsAt: "2026-11-02T08:00:00.000Z", now: new Date("2026-11-02T07:59:59Z"),
    pendingChange: null, paymentPending: false };
  expect(adminCancellationAvailability(base)).toBe("eligible");
  expect(adminCancellationAvailability({ ...base, now: new Date("2026-11-02T08:00:00Z") })).toBe("started");
  for (const status of ["cancelled", "pending_payment", "failed", "expired"] as const)
    expect(adminCancellationAvailability({ ...base, status })).toBe("unavailable");
  expect(adminCancellationAvailability({ ...base, pendingChange: "cancellation" })).toBe("cancellation_pending");
  expect(adminCancellationAvailability({ ...base, pendingChange: "reschedule" })).toBe("change_pending");
  expect(adminCancellationAvailability({ ...base, paymentPending: true })).toBe("change_pending");
});

test("records derive cancellation availability and refund notice in the same snapshot", async () => {
  mocks.history.mockResolvedValue({ rows: [row("payment", 1)], page: 1, total: 1, totalPages: 1 });
  const before = new Date("2026-10-18T00:00:00Z");
  let records = await getAdminBookingRecords(bookingId, { now: before });
  expect(mocks.pendingChange).toHaveBeenCalledWith(mocks.manager, [bookingId]);
  expect(mocks.livePayment).toHaveBeenCalledWith(mocks.manager, [bookingId]);
  // 10:00 in Europe/Bucharest on 2 November is 08:00 UTC.
  expect(records?.cancellation).toEqual({ availability: "eligible", startsAt: "2026-11-02T08:00:00.000Z", refundAvailable: true });
  mocks.pendingChange.mockResolvedValue(new Map([[bookingId, "cancellation"]]));
  records = await getAdminBookingRecords(bookingId, { now: before });
  expect(records?.cancellation.availability).toBe("cancellation_pending");
  mocks.pendingChange.mockResolvedValue(new Map()); mocks.livePayment.mockResolvedValue(new Set([bookingId]));
  records = await getAdminBookingRecords(bookingId, { now: before });
  expect(records?.cancellation.availability).toBe("change_pending");
  mocks.livePayment.mockResolvedValue(new Set());
  records = await getAdminBookingRecords(bookingId, { now: new Date("2026-11-02T08:00:00Z") });
  expect(records?.cancellation.availability).toBe("started");
  mocks.details.mockResolvedValue({ ...booking, status: "cancelled" });
  records = await getAdminBookingRecords(bookingId, { now: before });
  expect(records?.cancellation.availability).toBe("unavailable");
  // Funds already owed back (or club payment) are not refunded again.
  mocks.details.mockResolvedValue(booking);
  mocks.facts.mockResolvedValue({ payments: [own(attempt(1, 5000, "succeeded"))], captures: [capture(1, 5000)],
    refunds: [{ id: uuid(80), bookingId, paymentAttemptId: uuid(1), amountMinor: 5000, currency: "RON", status: "pending" }],
    executions: [], revisions: [], adjustments: [] });
  records = await getAdminBookingRecords(bookingId, { now: before });
  expect(records?.cancellation.refundAvailable).toBe(false);
  mocks.details.mockResolvedValue({ ...booking, payment_method: "pay_at_club" });
  records = await getAdminBookingRecords(bookingId, { now: before });
  expect(records?.cancellation.refundAvailable).toBe(false);
});

test("Admin editing is limited to the existing owner rescheduling boundary", () => {
  const actor = "ad000000-0000-4000-8000-0000000000a1";
  const base = { availability: "eligible" as const, accountUserId: actor, actorUserId: actor, includesCoaching: false };
  expect(adminBookingEditable(base)).toBe(true);
  expect(adminBookingEditable({ ...base, accountUserId: "ad000000-0000-4000-8000-0000000000b2" })).toBe(false);
  expect(adminBookingEditable({ ...base, accountUserId: null })).toBe(false);
  expect(adminBookingEditable({ ...base, includesCoaching: true })).toBe(false);
  for (const availability of ["started", "cancellation_pending", "change_pending", "unavailable"] as const)
    expect(adminBookingEditable({ ...base, availability })).toBe(false);
});
