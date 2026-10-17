import { beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({ account: vi.fn(), owned: vi.fn(), context: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => ({})) }));
vi.mock("@/lib/auth/account", () => ({ readCurrentAccount: mocks.account }));
vi.mock("@/lib/db/data-source", () => ({ getDataSource: async () => ({ manager: {} }) }));
vi.mock("@/lib/db/repositories/bookings.repository", () => ({ findOwnedBookingRevision: mocks.owned }));
vi.mock("@/lib/db/repositories/payments.repository", () => ({ loadAdminTransactionContext: mocks.context }));
import { getOwnBookingPayment } from "@/lib/bookings/own-payment";

const bookingId = "11111111-1111-4111-8111-111111111111";
const owner = "22222222-2222-4222-8222-222222222222";
const revision = { currency: "RON", timezone: "UTC", totalAmountMinor: 0, paymentMethod: "online", bookingDate: "2099-10-15", endMinute: 660 };
const at = (minute: number) => new Date(Date.UTC(2026, 9, 1, 10, minute));
const attempt = (id: string, adjustmentId: string | null, status: string, minute: number) => ({ id, bookingId, method: "online", provider: "stripe",
  providerPaymentId: `pi_${id}`, amountMinor: 6000, currency: "RON", status, adjustmentId, createdAt: at(minute) });
const capture = (attemptId: string, minute: number) => ({ id: `cap_${attemptId}`, paymentAttemptId: attemptId, provider: "stripe",
  providerPaymentId: `pi_${attemptId}`, providerCaptureId: `ch_${attemptId}`, amountMinor: 6000, currency: "RON", firstObservedAt: at(minute) });
const refund = (id: string, attemptId: string, amountMinor: number, reason: string, status: string, minute: number) => ({ id, bookingId,
  provider: "stripe", providerPaymentId: `pi_${attemptId}`, amountMinor, currency: "RON", status, reason, createdAt: at(minute) });
const execution = (refundId: string, attemptId: string, amountMinor: number, minute: number) => ({ refundId, provider: "stripe",
  providerPaymentId: `pi_${attemptId}`, providerRefundId: `re_${refundId}`, amountMinor, currency: "RON", status: "succeeded",
  terminalResult: "succeeded", completedAt: at(minute) });

beforeEach(() => {
  mocks.account.mockReset().mockResolvedValue({ state: "active", userId: owner, roles: [] });
  mocks.owned.mockReset(); mocks.context.mockReset();
});

test("explains extension, reduction and split cancellation refunds without provider identifiers", async () => {
  mocks.owned.mockResolvedValue({ status: "cancelled", revision: { ...revision, totalAmountMinor: 9000 } });
  mocks.context.mockResolvedValue({ revisions: [], adjustments: [],
    payments: [attempt("a1", null, "succeeded", 0), attempt("a2", "adj", "succeeded", 10), attempt("a3", "adj2", "expired", 15)],
    captures: [capture("a1", 1), capture("a2", 11)],
    refunds: [refund("r1", "a2", 3000, "booking_price_reduction", "succeeded", 20),
      refund("r2", "a2", 3000, "booking_cancellation", "succeeded", 30), refund("r3", "a1", 6000, "booking_cancellation", "pending", 30),
      refund("r4", "a1", 1000, "booking_price_reduction", "voided", 25)],
    executions: [execution("r1", "a2", 3000, 21), execution("r2", "a2", 3000, 31)] });
  const result = await getOwnBookingPayment(bookingId);
  expect(mocks.owned).toHaveBeenCalledWith({}, bookingId, owner);
  expect(result).toEqual({ ok: true, payment: { method: "online", currency: "RON", timezone: "UTC", total: 9000,
    paid: 12000, refunded: 6000, refundPending: 6000, outstanding: 0, dueAtClub: 0, operations: [
      { kind: "payment", label: "Booking payment", amount: 6000, state: "completed", at: at(1).toISOString() },
      { kind: "payment", label: "Booking change payment", amount: 6000, state: "completed", at: at(11).toISOString() },
      { kind: "refund", label: "Booking change refund", amount: 3000, state: "completed", at: at(21).toISOString() },
      { kind: "refund", label: "Cancellation refund", amount: 6000, state: "pending", at: at(30).toISOString() },
      { kind: "refund", label: "Cancellation refund", amount: 3000, state: "completed", at: at(31).toISOString() },
    ] } });
  expect(JSON.stringify(result)).not.toMatch(/pi_|ch_|re_|a1|r1|adj/);
});

test("never reads financial facts for another account's booking", async () => {
  mocks.owned.mockResolvedValue(null);
  expect(await getOwnBookingPayment(bookingId)).toEqual({ ok: false, message: "Payment details are unavailable. Try again." });
  expect(mocks.context).not.toHaveBeenCalled();
  mocks.account.mockResolvedValue({ state: "suspended" });
  expect((await getOwnBookingPayment(bookingId)).ok).toBe(false);
  expect(mocks.owned).toHaveBeenCalledTimes(1);
});

test("shows an upcoming pay-at-club balance as due at the club, never as paid", async () => {
  mocks.owned.mockResolvedValue({ status: "confirmed", revision: { ...revision, paymentMethod: "pay_at_club", totalAmountMinor: 5000 } });
  mocks.context.mockResolvedValue({ revisions: [], adjustments: [], captures: [], refunds: [], executions: [],
    payments: [{ ...attempt("club", null, "due", 0), method: "pay_at_club", provider: null, providerPaymentId: null, amountMinor: 5000 }] });
  expect(await getOwnBookingPayment(bookingId, undefined, new Date("2026-10-17T00:00:00Z"))).toMatchObject({ ok: true,
    payment: { method: "pay_at_club", paid: 0, dueAtClub: 5000, outstanding: 0, operations: [] } });
  expect(await getOwnBookingPayment(bookingId, undefined, new Date("2099-10-16T00:00:00Z"))).toMatchObject({ payment: { dueAtClub: 0 } });
});
