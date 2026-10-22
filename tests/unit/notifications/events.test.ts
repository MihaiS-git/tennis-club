import type { EntityManager } from "typeorm";
import { expect, test, vi } from "vitest";
import type { RevisionSnapshot } from "@/lib/bookings/revision";

const { notify, message, exception } = vi.hoisted(() => ({ notify: vi.fn(), message: vi.fn(), exception: vi.fn() }));
vi.mock("@/lib/notifications/record", () => ({ recordNotification: notify }));
vi.mock("@/lib/db/repositories/notifications.repository", () => ({ insertUserMessage: message }));
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
});

test("coaching confirmation and cancellation notify customer and assigned active Coach", async () => {
  notify.mockClear(); message.mockClear();
  const db = manager(vi.fn().mockResolvedValue([{ id }]));
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
  notify.mockClear(); message.mockClear(); exception.mockClear();
  const db = manager(vi.fn()
    .mockResolvedValueOnce([{ event_key: "refund:1:exception", kind: "refund_unresolved", booking_id: id,
      customer_email: "player@example.com", currency: "RON", amount_minor: 1500,
      occurred_at: new Date("2026-10-22T10:00:00Z"), ...contextRow }])
    .mockResolvedValueOnce([{ id }]));
  await recordBookingFinancialException(db, { key: "refund:1:exception", bookingId: id,
    revisionId: id, refundId: id, kind: "refund_unresolved" });
  expect(exception).toHaveBeenCalledOnce();
  expect(message).toHaveBeenCalledWith(db, expect.objectContaining({ eventKey: "financial.exception:refund:1:exception", userId: id }));
  expect(message.mock.calls[0][1].subject).toBe("Booking refund outcome needs review");
  expect(message.mock.calls[0][1].bodyText).toContain("Check the provider");
  expect(message.mock.calls[0][1].bodyText).toContain("15.00");
  expect(message.mock.calls[0][1].href).toBe(`/admin/bookings/${id}#financial-history`);
  expectReadable(message.mock.calls[0][1]);
  expect(notify).not.toHaveBeenCalled();
});

test("financial customer and Admin messages explain a pending compensation refund without claiming success", async () => {
  notify.mockClear(); message.mockClear(); exception.mockClear();
  const db = manager(vi.fn()
    .mockResolvedValueOnce([{ event_key: "capture:1", kind: "late_capture", booking_id: id,
      customer_email: "player@example.com", currency: "RON", amount_minor: 2500,
      occurred_at: revision.recordedAt, ...contextRow }])
    .mockResolvedValueOnce([{ id }]));
  await recordBookingFinancialException(db, { key: "capture:1", bookingId: id,
    revisionId: id, paymentAttemptId: id, kind: "late_capture" });
  const customer = notify.mock.calls[0][1];
  const admin = message.mock.calls[0][1];
  expect(customer.bodyText).toContain("outcome is not yet confirmed");
  expect(customer.bodyText).toContain("25.00");
  expect(customer.href).toBe(`/my-activity/history?booking=${id}`);
  expect(admin.bodyText).toContain("Check the compensation refund outcome");
  expectReadable(customer);
  expectReadable(admin);
});

test("independent successful refund uses persisted execution ID; cancellation refund is covered by its revision", async () => {
  notify.mockClear();
  const fact = { id, booking_id: id, reason: "late_capture_compensation", amount_minor: 1500,
    currency: "RON", customer_email: "player@example.com", ...contextRow };
  const db = manager(vi.fn().mockResolvedValueOnce([fact]).mockResolvedValueOnce([{ ...fact, reason: "booking_cancellation" }]));
  await recordSuccessfulRefund(db, id, id, revision.recordedAt);
  await recordSuccessfulRefund(db, id, id, revision.recordedAt);
  expect(notify).toHaveBeenCalledOnce();
  expect(notify).toHaveBeenCalledWith(db, expect.objectContaining({ eventKey: `financial.refund:${id}` }));
  expect(notify.mock.calls[0][1].subject).toBe("Booking refund completed");
  expect(notify.mock.calls[0][1].bodyText).toContain("15.00");
  expectReadable(notify.mock.calls[0][1]);
});
