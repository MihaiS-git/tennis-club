import { DataSource, EntityManager } from "typeorm";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { inTransaction } from "@/lib/db/transaction";
import { LocationEntity } from "@/lib/db/entities/location.entity";
import * as payments from "@/lib/db/repositories/payments.repository";
import * as bookings from "@/lib/db/repositories/bookings.repository";
import * as reservations from "@/lib/db/repositories/reservations.repository";
import { lockReservationActorFacts } from "@/lib/db/repositories/accounts.repository";
import { cancelCustomerBookingCommand, rescheduleCustomerBookingCommand } from "@/lib/bookings/commands";
import { expirePaymentHoldsAtLocation } from "@/lib/payments/hold-expiry";
import { CourtEntity } from "@/lib/db/entities/court.entity";
import { LocationPricingRuleEntity } from "@/lib/db/entities/location-pricing-rule.entity";
import { listCheckoutPricing } from "@/lib/db/repositories/pricing.repository";
import { listCheckoutLocationCourts, listCheckoutCourtCoverage, lockLocations } from "@/lib/db/repositories/clubs.repository";
import { hasOccupancyConflict } from "@/lib/reservations/occupancy";
import { processOnlinePaymentEvent } from "@/lib/payments/service";

vi.mock("@/lib/db/transaction");
vi.mock("@/lib/db/repositories/accounts.repository");
vi.mock("@/lib/db/repositories/pricing.repository");
vi.mock("@/lib/payments/hold-expiry");
vi.mock("@/lib/db/repositories/payments.repository");
vi.mock("@/lib/db/repositories/bookings.repository");
vi.mock("@/lib/db/repositories/reservations.repository");
vi.mock("@/lib/db/repositories/clubs.repository");
vi.mock("@/lib/reservations/occupancy");
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn() } }));

const id = "00000000-0000-4000-8000-000000000001";
const event = { attemptId: id, provider: "stripe" as const, providerPaymentId: "pi_test", eventId: "evt_test",
  amountMinor: 5000, currency: "RON", outcome: "succeeded" as const };
const manager = new EntityManager(new DataSource({ type: "postgres" })); // No connection.
let committed: boolean;
const request = vi.fn();
beforeEach(() => {
  vi.resetAllMocks(); committed = false;
  vi.stubEnv("BREVO_API_KEY", "private-key"); vi.stubEnv("BOOKING_MAIL_FROM", "bookings@example.test");
  vi.stubGlobal("fetch", request);
  request.mockImplementation(async () => {
    expect(committed).toBe(true);
    return new Response(null, { status: 201 });
  });
  vi.mocked(inTransaction).mockImplementation(async work => {
    const result = await work(manager); committed = true; return result;
  });
  vi.mocked(payments.discoverSettlementParent).mockResolvedValue({ booking_id: id, reservation_id: id, location_id: id });
  vi.mocked(lockLocations).mockResolvedValue([Object.assign(new LocationEntity(), { id })]);
  vi.mocked(bookings.lockSettlementBooking).mockResolvedValue({ id, reservation_id: id, status: "pending_payment",
    customer_name: "Customer", customer_email: "snapshot@example.test", total_amount_minor: 5000, currency: "RON" });
  vi.mocked(reservations.findReservationForUpdate).mockResolvedValue({ id, court_id: id, booking_date: "2099-10-15",
    starts_at_minute: 600, ends_at_minute: 660, reason: null, created_by_user_id: null, status: "held",
    created_at: "2099-10-14T10:00:00Z", updated_at: "2099-10-14T10:00:00Z", cancelled_at: null,
    cancelled_by_user_id: null, hold_expires_at: "2099-10-14T10:10:00Z", token_matches: null });
  vi.mocked(payments.lockSettlementAttempt).mockResolvedValue({ id, booking_id: id, method: "online", provider: "stripe",
    provider_payment_id: "pi_test", amount_minor: 5000, currency: "RON", status: "pending", expires_at: "2099-10-14T10:10:00Z" });
  vi.mocked(reservations.findReservationResourceFacts).mockResolvedValue({ court_id: id, court_name: "Court", court_active: true,
    location_id: id, location_name: "Club", location_timezone: "UTC", location_active: true, archived_at: null });
  vi.mocked(reservations.readReservationClockTime).mockResolvedValue("2099-10-14T10:00:00Z");
  vi.mocked(hasOccupancyConflict).mockResolvedValue(false);
  vi.mocked(reservations.findSettlementNotificationResource).mockResolvedValue({ court_name: "Court", location_name: "Club", timezone: "UTC" });
  vi.mocked(payments.updateSettlementAttempt).mockResolvedValue(true);
  vi.mocked(payments.insertProviderEventReceipt).mockResolvedValue(true);
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

test("first payment confirmation sends the snapshot only after commit", async () => {
  expect(await processOnlinePaymentEvent(event)).toBe("succeeded");
  expect(request).toHaveBeenCalledTimes(1);
  const message = JSON.parse(request.mock.calls[0][1].body);
  expect(message.to).toEqual([{ email: "snapshot@example.test" }]);
  expect(message.textContent).toContain("Your court booking is confirmed.");
});
test("no HTTP request while the successful transaction awaits commit", async () => {
  let release!: () => void;
  let ready!: () => void;
  const waiting = new Promise<void>(resolve => { ready = resolve; });
  const commit = new Promise<void>(resolve => { release = resolve; });
  vi.mocked(inTransaction).mockImplementation(async work => {
    const result = await work(manager); ready(); await commit; committed = true; return result;
  });
  const operation = processOnlinePaymentEvent(event);
  await waiting;
  expect(request).not.toHaveBeenCalled();
  release(); expect(await operation).toBe("succeeded"); expect(request).toHaveBeenCalledTimes(1);
});
test("failed commit sends no confirmation", async () => {
  vi.mocked(inTransaction).mockImplementation(async work => { await work(manager); throw new Error("Commit failed"); });
  await expect(processOnlinePaymentEvent(event)).rejects.toThrow("Commit failed");
  expect(request).not.toHaveBeenCalled();
});
test.each(["failed", "cancelled", "retryable_failed"] as const)("%s payment does not send confirmation", async outcome => {
  await processOnlinePaymentEvent({ ...event, outcome });
  expect(request).not.toHaveBeenCalled();
});
test("duplicate webhook receipt returns success without another notification", async () => {
  await processOnlinePaymentEvent(event);
  vi.mocked(payments.findProviderEventReceipt).mockResolvedValue({ provider: "stripe", event_id: event.eventId,
    attempt_id: id, provider_payment_id: "pi_test", outcome: "succeeded", amount_minor: 5000, currency: "RON",
    settlement_result: "succeeded", reconciliation_required: false });
  expect(await processOnlinePaymentEvent(event)).toBe("succeeded");
  expect(request).toHaveBeenCalledTimes(1);
});
test.each(["rejection", "timeout"])("email %s preserves committed payment success without another transaction", async failure => {
  request.mockImplementation(async () => {
    expect(committed).toBe(true);
    if (failure === "timeout") throw new DOMException("Timed out", "TimeoutError");
    return new Response(null, { status: 503 });
  });
  expect(await processOnlinePaymentEvent(event)).toBe("succeeded");
  expect(bookings.updateSettlementBookingStatus).toHaveBeenCalledWith(manager, id, "confirmed");
  expect(inTransaction).toHaveBeenCalledTimes(1);
  expect(request).toHaveBeenCalledTimes(1);
});

async function confirmedBooking() {
  vi.mocked(bookings.discoverBookingLocation).mockResolvedValue({ location_id: id });
  vi.mocked(lockLocations).mockResolvedValue([Object.assign(new LocationEntity(), {
    id, name: "Club", timezone: "UTC", currency: "RON", isActive: true, archivedAt: null,
  })]);
  vi.mocked(bookings.findBookingForUpdate).mockResolvedValue({ id, reservation_id: id, account_user_id: id,
    status: "confirmed", customer_name: "Customer", customer_email: "snapshot@example.test", customer_phone: "123",
    total_amount_minor: 5000, currency: "RON", cancellation_notice_minutes: 0, updated_at: "2099-10-14T10:00:00Z", token_matches: true });
  const reservation = await reservations.findReservationForUpdate(manager, id);
  if (!reservation) throw new Error("Missing test reservation");
  vi.mocked(reservations.findReservationForUpdate).mockResolvedValue({ ...reservation, status: "active", hold_expires_at: null, token_matches: true });
  vi.mocked(lockReservationActorFacts).mockResolvedValue({ status: "active", roles: ["admin"] });
}
test.each(["owner", "admin"] as const)("%s cancellation preserves the recipient and sends after commit", async scope => {
  await confirmedBooking();
  expect(await cancelCustomerBookingCommand(id, id, scope, false)).toEqual({ outcome: "cancelled", refund_id: null });
  expect(committed).toBe(true);
  const message = JSON.parse(request.mock.calls[0][1].body);
  expect(message.subject).toBe("Booking cancelled");
  expect(message.to).toEqual([{ email: "snapshot@example.test" }]);
  expect(message.textContent).toContain(scope === "admin" ? "administrator has cancelled" : "You have cancelled");
});
test("booking commit failure sends no cancellation email", async () => {
  await confirmedBooking();
  vi.mocked(inTransaction).mockImplementation(async work => { await work(manager); throw new Error("Commit failed"); });
  await expect(cancelCustomerBookingCommand(id, id, "owner", false)).rejects.toThrow("Commit failed");
  expect(request).not.toHaveBeenCalled();
});
test("email failure preserves committed cancellation and does not start another transaction", async () => {
  await confirmedBooking();
  request.mockResolvedValue(new Response(null, { status: 503 }));
  expect(await cancelCustomerBookingCommand(id, id, "owner", false)).toEqual({ outcome: "cancelled", refund_id: null });
  expect(committed).toBe(true); expect(inTransaction).toHaveBeenCalledTimes(1);
  expect(bookings.updateBookingCancellationStatus).toHaveBeenCalledWith(manager, id);
});
test.each(["owner", "admin"] as const)("%s rescheduling sends old/new schedules after commit; quotes and unchanged saves send nothing", async scope => {
  await confirmedBooking();
  vi.mocked(expirePaymentHoldsAtLocation).mockResolvedValue(0);
  vi.mocked(listCheckoutLocationCourts).mockResolvedValue([Object.assign(new CourtEntity(), { id, name: "Court", environment: "outdoor" })]);
  vi.mocked(reservations.listReservationOpeningHours).mockResolvedValue([{ id, location_id: id, weekday: 3,
    opens_at_minute: 0, closes_at_minute: 1440, created_at: "2099-10-14T10:00:00Z", updated_at: "2099-10-14T10:00:00Z" }]);
  vi.mocked(listCheckoutCourtCoverage).mockResolvedValue([]);
  vi.mocked(listCheckoutPricing).mockResolvedValue([Object.assign(new LocationPricingRuleEntity(), {
    id, ruleSetId: id, locationId: id, courtId: id, courtState: "outdoor", weekday: 3,
    startsAtMinute: 0, endsAtMinute: 1440, startsOn: null, endsOn: null, pricePerHourMinor: 5000,
    createdAt: new Date("2099-10-14T10:00:00Z"), updatedAt: new Date("2099-10-14T10:00:00Z"),
  })]);
  const edit = { id, expectedUpdatedAt: "2099-10-14T10:00:00Z", expectedBookingUpdatedAt: "2099-10-14T10:00:00Z",
    courtId: id, date: "2099-10-15", startMinute: 720, endMinute: 780, save: false, expectedTotal: 5000, priceAcknowledged: true };
  expect(await rescheduleCustomerBookingCommand(edit, id, scope)).toEqual({ ok: true, totalAmountMinor: 5000 });
  expect(request).not.toHaveBeenCalled();
  expect(await rescheduleCustomerBookingCommand({ ...edit, save: true, startMinute: 600, endMinute: 660 }, id, scope))
    .toEqual({ ok: true, totalAmountMinor: 5000 });
  expect(request).not.toHaveBeenCalled();
  expect(await rescheduleCustomerBookingCommand({ ...edit, save: true }, id, scope)).toEqual({ ok: true, totalAmountMinor: 5000 });
  expect(request).toHaveBeenCalledTimes(1);
  const message = JSON.parse(request.mock.calls[0][1].body);
  expect(message.textContent).toContain("Previous: 2099-10-15, 10:00–11:00, Court");
  expect(message.textContent).toContain("New schedule: 2099-10-15, 12:00–13:00, Court");
});
