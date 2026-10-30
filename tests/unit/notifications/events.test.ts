import type { EntityManager } from "typeorm";
import { expect, test, vi } from "vitest";
import type { RevisionSnapshot } from "@/lib/bookings/revision";

const { notify, message, messages, exception, activeRole, activeRoleIds } = vi.hoisted(() => ({ notify: vi.fn(), message: vi.fn(),
  messages: vi.fn(), exception: vi.fn(), activeRole: vi.fn(), activeRoleIds: vi.fn() }));
vi.mock("@/lib/notifications/record", () => ({ recordNotification: notify }));
// Financial fact projections run for real against each test's manager.query rows.
vi.mock("@/lib/db/repositories/notifications.repository", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/db/repositories/notifications.repository")>(),
  insertUserMessage: message, insertUserMessages: messages, hasActiveUserRole: activeRole, listActiveUserIdsWithRole: activeRoleIds }));
vi.mock("@/lib/db/repositories/booking-financial-exceptions.repository", () => ({ recordBookingFinancialException: exception }));

import { recordBookingTransition, recordBookingFinancialException, recordSuccessfulRefund } from "@/lib/notifications/events";

const id = "00000000-0000-4000-8000-000000000001";
const revision = {
  id, bookingId: id, kind: "created", bookingState: "pending_payment", customerEmail: "player@example.com",
  courtName: "Court 1", locationName: "Club", bookingDate: "2026-10-23", startMinute: 600, endMinute: 660,
  timezone: "Europe/Bucharest", recordedAt: new Date("2026-10-22T10:00:00Z"), coachUserId: null,
  coachingProgramName: null, coachName: null, totalAmountMinor: 2500, currency: "RON",
} as RevisionSnapshot;
const contextRow = { location_name: "Club", court_name: "Court 1", booking_date: "2026-10-23",
  starts_at_minute: 600, ends_at_minute: 660, timezone: "Europe/Bucharest",
  coaching_program_name: null, coach_name: null };
function expectReadable(content: { subject: string; bodyText: string; bodyHtml?: string }) {
  expect(`${content.subject}\n${content.bodyText}`).not.toContain(id);
  expect(content.bodyText).toContain("Club");
  expect(content.bodyText).toContain("Court 1");
  expect(content.bodyText).toContain("23 Oct 2026");
  expect(content.bodyText).toContain("10:00–11:00 (Europe/Bucharest)");
  if (content.bodyHtml) expect(content.bodyHtml).not.toContain(id);
}
const manager = (query = vi.fn().mockResolvedValue([])) => ({ query,
  queryRunner: { isTransactionActive: true } }) as unknown as EntityManager;

test("pending booking has no notification; confirmed court booking uses persisted revision identity", async () => {
  notify.mockClear(); message.mockClear();
  const db = manager();
  await recordBookingTransition(db, revision);
  expect(notify).not.toHaveBeenCalled();
  await recordBookingTransition(db, { ...revision, bookingState: "confirmed" });
  expect(notify).toHaveBeenCalledWith(db, expect.objectContaining({ eventKey: `booking.confirmed:${id}`,
    recipientEmail: "player@example.com" }));
  expect(notify.mock.calls[0][1].subject).toBe("Court booking confirmed");
  expect(notify.mock.calls[0][1].href).toBe(`/my-activity/bookings?booking=${id}`);
  expect(notify.mock.calls[0][1].bodyText).toContain("25.00");
  expectReadable(notify.mock.calls[0][1]);
  expect(message).not.toHaveBeenCalled();
  expect(activeRole).not.toHaveBeenCalled();
});

test("coaching confirmation and cancellation notify customer and assigned active Coach", async () => {
  notify.mockClear(); message.mockClear(); activeRole.mockReset().mockResolvedValue(true);
  const db = manager();
  for (const kind of ["confirmed", "cancelled"] as const)
    await recordBookingTransition(db, { ...revision, kind, bookingState: kind === "cancelled" ? "cancelled" : "confirmed",
      coachUserId: id, coachingProgramName: "Private lesson", coachName: "Coach" });
  expect(notify).toHaveBeenCalledTimes(2);
  expect(notify.mock.calls[0][1].subject).toBe("Coaching lesson confirmed");
  expect(notify.mock.calls[0][1].bodyText).toContain("Program: Private lesson");
  expect(notify.mock.calls[0][1].bodyText).toContain("Coach: Coach");
  expect(notify.mock.calls[1][1].bodyText).toContain("was cancelled");
  for (const [, content] of notify.mock.calls) expectReadable(content);
  expect(message).toHaveBeenCalledTimes(2);
  for (const [, content] of message.mock.calls) expectReadable(content);
  expect(message.mock.calls.map(call => call[1].eventKey)).toEqual([`coaching.confirmed:${id}`, `coaching.cancelled:${id}`]);
  expect(message.mock.calls[0][1].href).toBe(`/coach/bookings/lessons/${id}`);
  expect(notify.mock.calls[1][1].href).toBe(`/my-activity/history?booking=${id}`);
  expect(activeRole).toHaveBeenCalledWith(db, id, "coach");
});

test("assigned Coach without an active Coach role receives no message", async () => {
  notify.mockClear(); message.mockClear(); activeRole.mockReset().mockResolvedValue(false);
  const db = manager();
  await recordBookingTransition(db, { ...revision, kind: "confirmed", bookingState: "confirmed", coachUserId: id });
  expect(activeRole).toHaveBeenCalledWith(db, id, "coach");
  expect(notify).toHaveBeenCalledOnce();
  expect(message).not.toHaveBeenCalled();
});

test("final reschedule uses the same revision key on replay; completed refund is in its message", async () => {
  notify.mockClear();
  const db = manager();
  const changed = { ...revision, kind: "rescheduled" as const, bookingState: "confirmed" as const };
  await recordBookingTransition(db, changed, "The price reduction refund completed.");
  await recordBookingTransition(db, changed, "The price reduction refund completed.");
  expect(notify.mock.calls.map(call => call[1].eventKey)).toEqual([
    `booking.rescheduled:${id}`, `booking.rescheduled:${id}`]);
  expect(notify.mock.calls[0][1].bodyText).toContain("refund completed");
  expect(notify.mock.calls[0][1].bodyText).toContain("New total:");
  expectReadable(notify.mock.calls[0][1]);
});

test("financial exception records active Admin messages with stable key and suppresses unresolved customer outcome", async () => {
  notify.mockClear(); message.mockClear(); messages.mockClear(); exception.mockClear(); activeRoleIds.mockReset().mockResolvedValue([id]);
  const query = vi.fn().mockResolvedValueOnce([{ event_key: "refund:1:exception", kind: "refund_unresolved", booking_id: id,
    customer_email: "player@example.com", currency: "RON", amount_minor: 1500,
    occurred_at: new Date("2026-10-22T10:00:00Z"), confirmed: true, payment_attempt_id: null, refund_id: id, ...contextRow }]);
  const db = manager(query);
  await recordBookingFinancialException(db, { key: "refund:1:exception", bookingId: id,
    revisionId: id, refundId: id, kind: "refund_unresolved" });
  expect(exception).toHaveBeenCalledOnce();
  expect(query).toHaveBeenCalledWith(expect.stringContaining("FROM public.booking_financial_exceptions"), ["refund:1:exception"]);
  expect(activeRoleIds).toHaveBeenCalledWith(db, "admin");
  expect(message).not.toHaveBeenCalled();
  expect(messages).toHaveBeenCalledExactlyOnceWith(db, [expect.objectContaining({ eventKey: "financial.exception:refund:1:exception", userId: id })]);
  const [admin] = messages.mock.calls[0][1];
  expect(admin.subject).toBe("Booking refund outcome needs review");
  expect(admin.bodyText).toContain("Check the provider");
  expect(admin.bodyText).toContain("15.00");
  expect(admin.href).toBe(`/admin/bookings/${id}#financial-history`);
  expect(admin).not.toHaveProperty("bodyHtml");
  expectReadable(admin);
  expect(notify).not.toHaveBeenCalled();
});

test("financial customer and Admin messages explain a pending compensation refund without claiming success", async () => {
  notify.mockClear(); messages.mockClear(); exception.mockClear(); activeRoleIds.mockReset().mockResolvedValue([id]);
  const db = manager(vi.fn()
    .mockResolvedValueOnce([{ event_key: "capture:1", kind: "late_capture", booking_id: id,
      customer_email: "player@example.com", currency: "RON", amount_minor: 2500,
      occurred_at: revision.recordedAt, confirmed: true, payment_attempt_id: id, refund_id: null, ...contextRow }]));
  await recordBookingFinancialException(db, { key: "capture:1", bookingId: id,
    revisionId: id, paymentAttemptId: id, kind: "late_capture" });
  const customer = notify.mock.calls[0][1];
  const [admin] = messages.mock.calls[0][1];
  expect(customer.bodyText).toContain("outcome is not yet confirmed");
  expect(customer.bodyText).toContain("25.00");
  expect(customer.href).toBe(`/my-activity/history?booking=${id}`);
  expect(customer.eventKey).toBe("financial.customer:capture:1");
  expect(admin.eventKey).toBe("financial.exception:capture:1");
  expect(admin.bodyText).toContain("Check the compensation refund outcome");
  expectReadable(customer);
  expectReadable(admin);
});

const lateCapture = { event_key: "capture:2", kind: "late_capture", booking_id: id, customer_email: "player@example.com",
  currency: "RON", amount_minor: 2500, occurred_at: revision.recordedAt, confirmed: false,
  payment_attempt_id: "00000000-0000-4000-8000-000000000009", refund_id: id, ...contextRow };
const lateCaptureInput = { key: "capture:2", bookingId: id, revisionId: id, paymentAttemptId: id, kind: "late_capture" as const };

test("financial exception for a checkout that never confirmed links to payment evidence, not a booking page", async () => {
  notify.mockClear(); messages.mockClear(); activeRoleIds.mockReset().mockResolvedValue([id]);
  await recordBookingFinancialException(manager(vi.fn().mockResolvedValue([lateCapture])), lateCaptureInput);
  const [admin] = messages.mock.calls[0][1];
  expect(admin.href).toBe("/admin/payments/transactions/payment/00000000-0000-4000-8000-000000000009");
  // No booking-history entry exists for the customer, so the link carries no booking deep link.
  expect(notify.mock.calls[0][1].href).toBe("/my-activity/history");
  messages.mockClear();
  await recordBookingFinancialException(manager(vi.fn().mockResolvedValue([{ ...lateCapture, payment_attempt_id: null }])),
    lateCaptureInput);
  expect(messages.mock.calls[0][1][0].href).toBe(`/admin/payments/transactions/refund/${id}`);
});

test("financial exception writes every active Admin in one batch with shared event identity", async () => {
  notify.mockClear(); message.mockClear(); messages.mockClear();
  const admins = [id, "00000000-0000-4000-8000-000000000002", "00000000-0000-4000-8000-000000000003"];
  activeRoleIds.mockReset().mockResolvedValue(admins);
  const db = manager(vi.fn().mockResolvedValue([lateCapture]));
  await recordBookingFinancialException(db, lateCaptureInput);
  expect(message).not.toHaveBeenCalled();
  expect(messages).toHaveBeenCalledOnce();
  const rows = messages.mock.calls[0][1] as { id: string; userId: string; eventKey: string; kind: string; createdAt: Date }[];
  expect(rows.map(row => row.userId)).toEqual(admins);
  expect(new Set(rows.map(row => row.id)).size).toBe(admins.length);
  for (const row of rows) expect(row).toMatchObject({ eventKey: "financial.exception:capture:2", kind: "financial.late_capture",
    createdAt: revision.recordedAt });
  // The customer outcome stays on the customer channel policy; Admin rows never become email.
  expect(notify).toHaveBeenCalledExactlyOnceWith(db, expect.objectContaining({ purpose: "customer",
    eventKey: "financial.customer:capture:2", recipientEmail: "player@example.com" }));
});

test("financial exception without active Admins still records evidence and the customer notification", async () => {
  notify.mockClear(); messages.mockClear(); exception.mockClear(); activeRoleIds.mockReset().mockResolvedValue([]);
  const db = manager(vi.fn().mockResolvedValue([lateCapture]));
  await recordBookingFinancialException(db, lateCaptureInput);
  expect(exception).toHaveBeenCalledOnce();
  expect(messages).toHaveBeenCalledExactlyOnceWith(db, []);
  expect(notify).toHaveBeenCalledOnce();
});

test("financial exception replay reuses event keys and requires the caller transaction", async () => {
  notify.mockClear(); messages.mockClear(); activeRoleIds.mockReset().mockResolvedValue([id]);
  const db = manager(vi.fn().mockResolvedValue([lateCapture]));
  await recordBookingFinancialException(db, lateCaptureInput);
  await recordBookingFinancialException(db, lateCaptureInput);
  expect(messages.mock.calls.map(call => call[1].map((row: { eventKey: string; userId: string }) => [row.userId, row.eventKey])))
    .toEqual([[[id, "financial.exception:capture:2"]], [[id, "financial.exception:capture:2"]]]);
  messages.mockClear();
  const outside = { query: vi.fn(), queryRunner: { isTransactionActive: false } } as unknown as EntityManager;
  await expect(recordBookingFinancialException(outside, lateCaptureInput)).rejects.toThrow("caller-owned transaction");
  expect(messages).not.toHaveBeenCalled();
});

test("independent successful refund uses persisted execution ID; cancellation refund is covered by its revision", async () => {
  notify.mockClear();
  const fact = { id, booking_id: id, reason: "late_capture_compensation", amount_minor: 1500,
    currency: "RON", customer_email: "player@example.com", confirmed: false, ...contextRow };
  const query = vi.fn().mockResolvedValueOnce([fact]).mockResolvedValueOnce([{ ...fact, reason: "booking_cancellation" }]);
  const db = manager(query);
  await recordSuccessfulRefund(db, id, id, revision.recordedAt);
  await recordSuccessfulRefund(db, id, id, revision.recordedAt);
  expect(query).toHaveBeenCalledWith(expect.stringContaining("FROM public.payment_refunds"), [id, id]);
  expect(notify).toHaveBeenCalledOnce();
  expect(notify).toHaveBeenCalledWith(db, expect.objectContaining({ eventKey: `financial.refund:${id}` }));
  expect(notify.mock.calls[0][1].subject).toBe("Booking refund completed");
  expect(notify.mock.calls[0][1].href).toBe("/my-activity/history");
  expect(notify.mock.calls[0][1].bodyText).toContain("15.00");
  expectReadable(notify.mock.calls[0][1]);
});

test("a Coach-initiated reschedule tells the customer the previous and new date and time with the unchanged price", async () => {
  notify.mockClear(); message.mockClear(); activeRole.mockReset().mockResolvedValue(true);
  const db = manager();
  const lesson = { ...revision, kind: "rescheduled" as const, bookingState: "confirmed" as const, coachUserId: id,
    coachingProgramName: "Private lesson", coachName: "Coach", bookingDate: "2026-10-23", startMinute: 600, endMinute: 660 };
  await recordBookingTransition(db, lesson, undefined, { ...lesson, bookingDate: "2026-10-22", startMinute: 480, endMinute: 540 });
  const [, customer] = notify.mock.calls[0];
  expect(customer).toMatchObject({ eventKey: `booking.rescheduled:${id}`, recipientEmail: "player@example.com",
    subject: "Coaching lesson rescheduled" });
  for (const line of ["Program: Private lesson", "Coach: Coach", "Previous date: 22 Oct 2026",
    "Previous time: 08:00–09:00 (Europe/Bucharest)", "Total price (unchanged): "]) expect(customer.bodyText).toContain(line);
  expect(customer.bodyText).not.toContain("New total");
  expectReadable(customer);
  // The assigned Coach keeps the existing in-app operational message.
  expect(message.mock.calls.map(call => call[1].eventKey)).toEqual([`coaching.rescheduled:${id}`]);
});

test("a same-coach lesson message gives the assigned Coach the schedule change but never the customer's financial outcome", async () => {
  notify.mockClear(); message.mockClear(); activeRole.mockReset().mockResolvedValue(true);
  const db = manager();
  const lesson = { ...revision, kind: "rescheduled" as const, bookingState: "confirmed" as const, coachUserId: id,
    coachingProgramName: "Private lesson", coachName: "Coach", totalAmountMinor: 15000 };
  const previous = { ...lesson, bookingDate: "2026-10-22", startMinute: 480, endMinute: 540, totalAmountMinor: 17500 };
  for (const note of ["The price reduction refund of RON 25.00 completed.",
    "This booking time is priced at RON 180.00. The club covers the difference of RON 5.00; no additional payment is required.",
    "The booking price is reduced from RON 175.00 to RON 150.00."])
    await recordBookingTransition(db, lesson, note, previous);
  await recordBookingTransition(db, { ...lesson, kind: "confirmed" });
  await recordBookingTransition(db, { ...lesson, kind: "cancelled", bookingState: "cancelled" }, "The cancellation refund completed.");
  // Customers keep their financial details.
  expect(notify.mock.calls[0][1].bodyText).toContain("refund of RON 25.00 completed");
  expect(notify.mock.calls[0][1].bodyText).toContain("New total:");
  const coachMessages = message.mock.calls.map(call => call[1]);
  expect(coachMessages.map(content => content.kind)).toEqual(["coaching.rescheduled", "coaching.rescheduled", "coaching.rescheduled",
    "coaching.confirmed", "coaching.cancelled"]);
  expect(coachMessages[0].subject).toBe("Coaching lesson rescheduled");
  expect(coachMessages[0].bodyText).toMatch(/^Your assigned coaching lesson was rescheduled/);
  for (const line of ["Program: Private lesson", "Previous date: 22 Oct 2026", "Previous time: 08:00–09:00 (Europe/Bucharest)"])
    expect(coachMessages[0].bodyText).toContain(line);
  expect(coachMessages[3].bodyText).toMatch(/^Your assigned coaching lesson is confirmed/);
  expect(coachMessages[4].bodyText).toMatch(/^Your assigned coaching lesson was cancelled/);
  for (const content of coachMessages) {
    expectReadable(content);
    expect(content.bodyText).not.toMatch(/RON|refund|price|total|payment|covers|reduced/i);
    expect(content.bodyText).not.toContain("player@example.com");
  }
});

test("a completed reassignment tells the previous and replacement Coach in-app, without financial details", async () => {
  notify.mockClear(); message.mockClear(); activeRole.mockReset().mockResolvedValue(true);
  const db = manager(), previousCoach = "00000000-0000-4000-8000-000000000002", replacement = "00000000-0000-4000-8000-000000000003";
  const before = { ...revision, kind: "confirmed" as const, bookingState: "confirmed" as const, coachUserId: previousCoach,
    coachingProgramName: "Private lesson", coachName: "Previous Coach", totalAmountMinor: 17500 };
  const lesson = { ...before, kind: "rescheduled" as const, coachUserId: replacement, coachName: "Replacement Coach",
    startMinute: 630, endMinute: 690, totalAmountMinor: 15000 };
  await recordBookingTransition(db, lesson, "The price reduction refund of RON 25.00 completed.", before);
  // The customer receives the updated lesson, including its new coach and the refund outcome.
  const [, customer] = notify.mock.calls[0];
  expect(customer).toMatchObject({ eventKey: `booking.rescheduled:${id}`, purpose: "customer" });
  expect(customer.bodyText).toContain("Coach: Replacement Coach");
  expect(customer.bodyText).toContain("The price reduction refund of RON 25.00 completed.");
  expect(notify).toHaveBeenCalledOnce();
  const [unassigned, assigned] = message.mock.calls.map(call => call[1]);
  expect(message.mock.calls.map(call => call[1].userId)).toEqual([previousCoach, replacement]);
  expect(unassigned).toMatchObject({ eventKey: `coaching.unassigned:${id}`, kind: "coaching.unassigned", href: "/coach/bookings" });
  expect(unassigned.bodyText).toMatch(/^This coaching lesson is no longer assigned to you/);
  expect(unassigned.bodyText).toContain("10:00–11:00 (Europe/Bucharest)");
  expect(assigned).toMatchObject({ eventKey: `coaching.assigned:${id}`, kind: "coaching.assigned", href: `/coach/bookings/lessons/${id}` });
  expect(assigned.bodyText).toMatch(/^A coaching lesson is now assigned to you/);
  expect(assigned.bodyText).toContain("10:30–11:30 (Europe/Bucharest)");
  for (const content of [unassigned, assigned]) {
    expect(content.bodyText).not.toMatch(/RON|refund|price|total/i);
    expect(content.bodyText).not.toContain("player@example.com");
  }
  // A same-coach reschedule keeps the single existing Coach message; an inactive Coach gets none.
  message.mockClear();
  await recordBookingTransition(db, { ...lesson, coachUserId: previousCoach }, undefined, before);
  expect(message.mock.calls.map(call => call[1].eventKey)).toEqual([`coaching.rescheduled:${id}`]);
  message.mockClear(); activeRole.mockReset().mockImplementation(async (_db: unknown, userId: string) => userId === replacement);
  await recordBookingTransition(db, lesson, undefined, before);
  expect(message.mock.calls.map(call => call[1].eventKey)).toEqual([`coaching.assigned:${id}`]);
});
