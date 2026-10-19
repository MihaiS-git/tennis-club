import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { cancelBookingCommand } from "@/lib/bookings/cancellation-service";
import { getDataSource } from "@/lib/db/data-source";
import * as captures from "@/lib/db/repositories/payment-capture-receipts.repository";
import { abandonOnlineCheckout, startOnlineCheckout } from "@/lib/payments/checkout";
import { finishBookingCancellation, processBookingRefund } from "@/lib/payments/refunds";
import { processOnlinePaymentEvent } from "@/lib/payments/service";
import { cleanupAuthFixtures, localFixtureClient } from "./auth-fixtures";
import { cleanupBookingFixtures, insertCheckoutFixture } from "./checkout-fixtures";
import { configureCheckoutPolicyFixture } from "./opening-hours-fixtures";

const { createPayment, cancelPayment, readPayment, refundPayment } = vi.hoisted(() => ({
  createPayment: vi.fn(), cancelPayment: vi.fn(), readPayment: vi.fn(), refundPayment: vi.fn(),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/reservations/revalidation", () => ({ revalidateCourtActivity: vi.fn() }));
// Only provider I/O is simulated; booking/refund commands and database locks are real.
vi.mock("@/lib/payments/providers", () => ({ onlinePaymentAdapter: async () => ({
  createPayment, cancelPayment, readPayment, refundPayment,
}) }));

const locationId = randomUUID(), courtId = randomUUID(), users: string[] = [];
const bookingIds: string[] = [];
let nextMinute = 360;
type HeldBooking = Awaited<ReturnType<typeof hold>>;

beforeAll(async () => {
  const db = localFixtureClient();
  const user = await db.auth.admin.createUser({ email: `abandon-${randomUUID()}@example.test`,
    password: "checkout-abandonment-test-123", email_confirm: true });
  expect(user.error).toBeNull();
  users.push(user.data.user!.id);
  expect((await db.from("locations").insert({ id: locationId, name: "Checkout abandonment",
    slug: `abandon-${locationId}`, timezone: "UTC", currency: "RON", is_public: true })).error).toBeNull();
  expect((await db.from("courts").insert({ id: courtId, location_id: locationId, name: "Court",
    slug: "court", environment: "outdoor", surface: "clay" })).error).toBeNull();
  await configureCheckoutPolicyFixture(db, locationId, courtId);
});

beforeEach(() => {
  vi.clearAllMocks();
  createPayment.mockImplementation(async ({ id }: { id: string }) => ({ providerPaymentId: `pi_${id}`,
    presentation: { kind: "stripe", clientSecret: `secret_${id}`, publishableKey: "pk_test_Fixture" } }));
  cancelPayment.mockResolvedValue("cancelled");
  readPayment.mockResolvedValue({ status: "cancelled", amountMinor: 5000, currency: "RON", providerCaptureId: null, live: false });
  refundPayment.mockImplementation(async ({ id }: { id: string }) => ({ status: "succeeded", providerRefundId: `re_${id}` }));
});

afterAll(async () => {
  const db = localFixtureClient();
  await cleanupBookingFixtures({ bookingIds });
  expect((await db.from("court_reservations").delete().eq("court_id", courtId)).error).toBeNull();
  await db.from("location_pricing_rules").delete().eq("location_id", locationId);
  await db.from("pricing_rule_sets").delete().eq("location_id", locationId);
  await db.from("location_opening_hours").delete().eq("location_id", locationId);
  await db.from("opening_hours_schedules").delete().eq("location_id", locationId);
  await db.from("courts").delete().eq("id", courtId);
  await db.from("locations").delete().eq("id", locationId);
  await cleanupAuthFixtures(db, users);
});

async function hold(owner: string | null = users[0]) {
  const start = nextMinute;
  nextMinute += 60;
  const held = await insertCheckoutFixture(localFixtureClient(), { p_court_id: courtId, p_booking_date: "2099-10-15",
    p_starts_at_minute: start, p_ends_at_minute: start + 60, p_account_user_id: owner,
    p_customer_name: "Checkout customer", p_customer_email: "checkout@example.test", p_customer_phone: "123",
    p_total_amount_minor: 5000, p_currency: "RON", p_payment_method: "online", p_provider: "stripe", p_hold_seconds: 600 });
  expect(held.error).toBeNull();
  const booking = held.data[0];
  bookingIds.push(booking.booking_id);
  const checkout = await startOnlineCheckout(booking.payment_attempt_id);
  return { ...booking, access: { attemptId: checkout.attemptId, token: checkout.token } };
}

function settle(booking: HeldBooking) {
  return processOnlinePaymentEvent({ provider: "stripe", attemptId: booking.payment_attempt_id,
    providerPaymentId: `pi_${booking.payment_attempt_id}`, providerCaptureId: `pi_${booking.payment_attempt_id}`,
    eventId: `evt_${booking.payment_attempt_id}`, outcome: "succeeded", amountMinor: 5000, currency: "RON" });
}

async function state(booking: HeldBooking) {
  const { manager } = await getDataSource();
  const [row] = await manager.query(`SELECT b.status,b.current_revision_id,r.status AS reservation_status,
    r.hold_expires_at,p.status AS payment_status,
    (SELECT count(*)::int FROM public.payment_refunds f WHERE f.booking_id=b.id) AS refunds,
    (SELECT count(*)::int FROM public.booking_revisions v WHERE v.booking_id=b.id AND v.kind='confirmed') AS confirmations
    FROM public.bookings b JOIN public.court_reservations r ON r.id=b.reservation_id
    JOIN public.payment_attempts p ON p.booking_id=b.id WHERE b.id=$1`, [booking.booking_id]);
  return row;
}

test("pending unpaid checkout abandonment still releases its hold without a refund", async () => {
  const booking = await hold();
  expect(await abandonOnlineCheckout(booking.access)).toMatchObject({ released: true, paymentStatus: "cancelled" });
  expect(await state(booking)).toMatchObject({ status: "cancelled", reservation_status: "released",
    payment_status: "cancelled", hold_expires_at: null, refunds: 0, confirmations: 0 });
  expect(cancelPayment).toHaveBeenCalledOnce();
  expect(refundPayment).not.toHaveBeenCalled();
});

test.each(["owner", "guest"])("a fresh confirmed %s checkout capability cannot cancel or request a refund", async owner => {
  const booking = await hold(owner === "guest" ? null : users[0]);
  expect(await settle(booking)).toBe("succeeded");
  const before = await state(booking);
  expect(before).toMatchObject({ status: "confirmed", reservation_status: "active", confirmations: 1, refunds: 0 });
  // The original ten-minute capability has not expired: confirmation alone revokes abandonment authority.
  expect(Date.parse(booking.hold_expires_at!)).toBeGreaterThan(Date.now());
  await expect(abandonOnlineCheckout(booking.access)).rejects.toThrow("already confirmed");
  expect(await state(booking)).toEqual(before);
  expect(cancelPayment).not.toHaveBeenCalled();
  expect(refundPayment).not.toHaveBeenCalled();
});

test("normal cancellation refund failure preserves the confirmed booking against its old checkout capability", async () => {
  const booking = await hold();
  await settle(booking);
  const request = await cancelBookingCommand(booking.booking_id, users[0], false);
  expect(request.outcome).toBe("cancellation_pending");
  refundPayment.mockResolvedValueOnce({ status: "failed", providerRefundId: "re_failed", retryable: false,
    failureReason: "declined" });
  expect(await finishBookingCancellation(request)).toMatchObject({ ok: false });
  const preserved = await state(booking);
  expect(preserved).toMatchObject({ status: "confirmed", reservation_status: "active", payment_status: "succeeded" });
  await expect(abandonOnlineCheckout(booking.access)).rejects.toThrow("already confirmed");
  expect(await state(booking)).toEqual(preserved);
  expect(cancelPayment).not.toHaveBeenCalled();
  expect(refundPayment).toHaveBeenCalledOnce();
});

test("normal cancellation preserves occupancy while refund is pending and cancels only after verified success", async () => {
  const booking = await hold();
  await settle(booking);
  const request = await cancelBookingCommand(booking.booking_id, users[0], false);
  if (request.outcome !== "cancellation_pending") throw new Error("Expected refund-backed cancellation");
  const providerRefundId = `re_${request.refundIds[0]}`;
  refundPayment.mockResolvedValueOnce({ status: "pending", providerRefundId });
  expect(await finishBookingCancellation(request)).toEqual({ ok: true, outcome: "cancellation_pending" });
  expect(await state(booking)).toMatchObject({ status: "confirmed", reservation_status: "active", refunds: 1 });
  await expect(abandonOnlineCheckout(booking.access)).rejects.toThrow("already confirmed");
  expect(await processBookingRefund(request.refundIds[0])).toBe("succeeded");
  expect(await state(booking)).toMatchObject({ status: "cancelled", reservation_status: "cancelled", refunds: 1 });
  await expect(abandonOnlineCheckout(booking.access)).rejects.toThrow("booking management");
  expect(await processBookingRefund(request.refundIds[0])).toBe("succeeded");
  expect(refundPayment).toHaveBeenCalledTimes(2);
  expect(cancelPayment).not.toHaveBeenCalled();
});

test("settlement holding aggregate locks wins over concurrent checkout abandonment", async () => {
  const booking = await hold();
  let entered!: () => void, release!: () => void;
  const captured = new Promise<void>(resolve => { entered = resolve; });
  const resume = new Promise<void>(resolve => { release = resolve; });
  const original = captures.recordCaptureReceipt;
  const spy = vi.spyOn(captures, "recordCaptureReceipt").mockImplementationOnce(async (...args) => {
    entered();
    await resume;
    return original(...args);
  });
  const settlement = settle(booking);
  try {
    await captured;
    const abandonment = expect(abandonOnlineCheckout(booking.access)).rejects.toThrow("already confirmed");
    release();
    await Promise.all([expect(settlement).resolves.toBe("succeeded"), abandonment]);
    expect(await state(booking)).toMatchObject({ status: "confirmed", reservation_status: "active", refunds: 0, confirmations: 1 });
    expect(cancelPayment).not.toHaveBeenCalled();
    expect(refundPayment).not.toHaveBeenCalled();
  } finally {
    release();
    await settlement;
    spy.mockRestore();
  }
});

test("pending abandonment winning before settlement retains late-capture compensation exactly once", async () => {
  const booking = await hold();
  let entered!: () => void, release!: () => void;
  const contacted = new Promise<void>(resolve => { entered = resolve; });
  const resume = new Promise<void>(resolve => { release = resolve; });
  cancelPayment.mockImplementationOnce(async () => { entered(); await resume; return "succeeded"; });
  readPayment.mockResolvedValue({ status: "succeeded", amountMinor: 5000, currency: "RON",
    providerCaptureId: `pi_${booking.payment_attempt_id}`, live: false });
  const abandonment = abandonOnlineCheckout(booking.access);
  try {
    await contacted;
    expect(await state(booking)).toMatchObject({ status: "cancelled", reservation_status: "released", refunds: 0 });
    await settle(booking);
    release();
    expect(await abandonment).toMatchObject({ released: true, paymentStatus: "refunded" });
    await settle(booking);
    expect(await state(booking)).toMatchObject({ status: "cancelled", reservation_status: "released", refunds: 1, confirmations: 0 });
    expect(refundPayment).toHaveBeenCalledOnce();
  } finally {
    release();
    await abandonment;
  }
});
