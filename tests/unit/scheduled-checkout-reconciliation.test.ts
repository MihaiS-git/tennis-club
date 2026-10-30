import { beforeEach, expect, test, vi } from "vitest";

const m = vi.hoisted(() => ({ find: vi.fn(), booking: vi.fn(), reservation: vi.fn(), attempt: vi.fn(),
  read: vi.fn(), dismiss: vi.fn(), cancel: vi.fn(), capture: vi.fn(), settle: vi.fn(), event: vi.fn() }));
vi.mock("@/lib/db/data-source", () => ({ getDataSource: async () => ({ manager: {} }) }));
vi.mock("@/lib/db/transaction", () => ({ inTransaction: async (run: (manager: object) => unknown) => run({}) }));
vi.mock("@/lib/db/repositories/payments.repository", () => ({ findCheckoutAttempt: m.find,
  discoverSettlementParent: async () => ({ booking_id: "booking", reservation_id: "reservation", location_id: "location", coach_user_id: null }),
  lockSettlementAttempt: m.attempt }));
vi.mock("@/lib/db/repositories/bookings.repository", () => ({ findBookingForUpdate: m.booking }));
vi.mock("@/lib/db/repositories/reservations.repository", () => ({ findReservationForUpdate: m.reservation,
  findReservationResourceFacts: async () => ({ location_id: "location" }),
  readReservationClockTime: async () => "2026-10-26T10:00:00.000000Z" }));
vi.mock("@/lib/db/repositories/clubs.repository", () => ({ lockLocations: vi.fn() }));
vi.mock("@/lib/payments/providers", () => ({ onlinePaymentAdapter: async () => ({
  readPayment: m.read, dismissPayment: m.dismiss, cancelPayment: m.cancel, capturePayment: m.capture }) }));
vi.mock("@/lib/payments/service", () => ({ settleOnlinePayment: m.settle, processOnlinePaymentEvent: m.event }));
vi.mock("@/lib/reservations/revalidation", () => ({ revalidateCourtActivity: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
import { checkOnlinePayment } from "@/lib/payments/checkout";

const id = "c9000000-0000-4000-8000-000000000011";
const evidence = { amountMinor: 5000, currency: "RON", providerCaptureId: null, live: false };
beforeEach(() => {
  vi.resetAllMocks();
  m.find.mockResolvedValue({ id, bookingId: "c9000000-0000-4000-8000-000000000012", method: "online",
    provider: "stripe", providerPaymentId: "pi_fixture", amountMinor: 5000, currency: "RON",
    status: "expired", expiresAt: new Date("2026-10-26T09:59:00Z") });
  m.booking.mockResolvedValue({ id: "booking", reservation_id: "reservation", status: "expired" });
  m.reservation.mockResolvedValue({ id: "reservation", court_id: "court", status: "released" });
  m.attempt.mockResolvedValue({ id, booking_id: "booking", method: "online", provider: "stripe",
    provider_payment_id: "pi_fixture", status: "expired" });
  m.read.mockResolvedValue({ ...evidence, status: "pending" });
  m.dismiss.mockResolvedValue("cancelled");
});

test.each(["pending", "authorized"])("overdue %s intent uses dismissal and existing settlement, never capture", async status => {
  m.read.mockResolvedValue({ ...evidence, status });
  expect(await checkOnlinePayment(id, true)).toBe("cancelled");
  expect(m.dismiss).toHaveBeenCalledExactlyOnceWith({ id, provider: "stripe", providerPaymentId: "pi_fixture",
    bookingId: "c9000000-0000-4000-8000-000000000012", method: "online", amountMinor: 5000,
    currency: "RON", status: "expired", expiresAt: new Date("2026-10-26T09:59:00Z") });
  expect(m.settle).toHaveBeenCalledWith({ attemptId: id, provider: "stripe", providerPaymentId: "pi_fixture", outcome: "cancelled" });
  expect(m.capture).not.toHaveBeenCalled();
  expect(m.cancel).not.toHaveBeenCalled();
});

test("processing remains unresolved, without recording cancellation", async () => {
  m.read.mockResolvedValue({ ...evidence, status: "processing", live: true });
  m.dismiss.mockResolvedValue("live");
  expect(await checkOnlinePayment(id, true)).toBe("processing");
  expect(m.cancel).not.toHaveBeenCalled();
  expect(m.settle).not.toHaveBeenCalled();
});

test.each([false, true])("capture observed directly or winning dismissal race uses durable settlement evidence (race=%s)", async race => {
  const captured = { ...evidence, status: "succeeded", providerCaptureId: "pi_fixture" };
  if (race) {
    m.read.mockResolvedValueOnce({ ...evidence, status: "pending" }).mockResolvedValueOnce(captured);
    m.dismiss.mockResolvedValue("succeeded");
  } else m.read.mockResolvedValue(captured);
  expect(await checkOnlinePayment(id, true)).toBe("succeeded");
  expect(m.event).toHaveBeenCalledExactlyOnceWith({ attemptId: id, provider: "stripe", providerPaymentId: "pi_fixture",
    eventId: `checkout-observation-${id}-succeeded`, outcome: "succeeded", amountMinor: 5000,
    currency: "RON", providerCaptureId: "pi_fixture" });
  expect(m.settle).not.toHaveBeenCalled();
  expect(m.capture).not.toHaveBeenCalled();
});

test.each([false, true])("accepted capture preserves occupancy without verified cancellation (past grace=%s)", async pastGrace => {
  m.booking.mockResolvedValue({ id: "booking", reservation_id: "reservation", status: "pending_payment" });
  m.reservation.mockResolvedValue({ id: "reservation", court_id: "court", status: "held",
    hold_expires_at: pastGrace ? "2026-10-26T09:59:00.000000Z" : "2026-10-26T10:01:00.000000Z" });
  m.attempt.mockResolvedValue({ id, booking_id: "booking", method: "online", provider: "stripe",
    provider_payment_id: "pi_fixture", status: "pending",
    expires_at: pastGrace ? "2026-10-26T09:57:00.000000Z" : "2026-10-26T09:59:00.000000Z" });
  m.read.mockResolvedValue({ ...evidence, status: "authorized" });
  m.dismiss.mockResolvedValue("live");
  expect(await checkOnlinePayment(id, true)).toBe("processing");
  expect(m.dismiss).toHaveBeenCalledTimes(pastGrace ? 1 : 0);
  expect(m.cancel).not.toHaveBeenCalled();
  expect(m.capture).not.toHaveBeenCalled();
  expect(m.settle).not.toHaveBeenCalled();
});
