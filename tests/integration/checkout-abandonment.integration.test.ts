import { setPaymentAttemptExpiryFixture } from "../local/booking-fixtures";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { cancelBookingCommand } from "@/lib/bookings/cancellation-service";
import { getDataSource } from "@/lib/db/data-source";
import * as captures from "@/lib/db/repositories/payment-capture-receipts.repository";
import { abandonOnlineCheckout, startOnlineCheckout, checkOnlinePayment, resolveAuthorizedCheckoutPayment, resolveFailedCheckoutPayment } from "@/lib/payments/checkout";
import { finishBookingCancellation, processBookingRefund } from "@/lib/payments/refunds";
import { processOnlinePaymentEvent } from "@/lib/payments/service";
import { checkoutCaptureGraceSeconds } from "@/lib/payments/domain";
import { cleanupScheduledCheckouts } from "@/lib/payments/scheduled-checkout-cleanup";
import * as reservationReads from "@/lib/db/repositories/reservations.repository";
import { expirePaymentHolds } from "@/lib/payments/hold-expiry";
import { cleanupAuthFixtures, localFixtureClient } from "./auth-fixtures";
import { cleanupBookingFixtures, insertCheckoutFixture } from "./checkout-fixtures";
import { configureCheckoutPolicyFixture } from "./opening-hours-fixtures";

const { createPayment, cancelPayment, readPayment, capturePayment, refundPayment } = vi.hoisted(() => ({
  createPayment: vi.fn(), cancelPayment: vi.fn(), readPayment: vi.fn(), capturePayment: vi.fn(), refundPayment: vi.fn(),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/reservations/revalidation", () => ({ revalidateCourtActivity: vi.fn() }));
// Only provider I/O is simulated; booking/refund commands and database locks are real.
vi.mock("@/lib/payments/providers", () => ({ onlinePaymentAdapter: async () => ({
  createPayment, capturePayment, cancelPayment, dismissPayment: cancelPayment, readPayment, refundPayment,
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
  expect((await db.from("location_pricing_rules").delete().eq("location_id", locationId)).error).toBeNull();
  expect((await db.from("pricing_rule_sets").delete().eq("location_id", locationId)).error).toBeNull();
  expect((await db.from("location_opening_hours").delete().eq("location_id", locationId)).error).toBeNull();
  expect((await db.from("opening_hours_schedules").delete().eq("location_id", locationId)).error).toBeNull();
  expect((await db.from("courts").delete().eq("id", courtId)).error).toBeNull();
  expect((await db.from("locations").delete().eq("id", locationId)).error).toBeNull();
  await cleanupAuthFixtures(db, users);
});

async function hold(owner: string | null = users[0]) {
  const start = nextMinute;
  nextMinute += 60;
  const booking = await insertCheckoutFixture({ courtId, bookingDate: "2099-10-15",
    startMinute: start, endMinute: start + 60, accountUserId: owner,
    customerName: "Checkout customer", customerEmail: "checkout@example.test", customerPhone: "123",
    totalAmountMinor: 5000, currency: "RON", paymentMethod: "online", provider: "stripe", holdSeconds: 600 });
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
    (SELECT count(*)::int FROM public.user_messages m JOIN public.booking_revisions v
      ON m.event_key='booking.'||v.kind||':'||v.id::text WHERE v.booking_id=b.id) AS booking_notifications,
    (SELECT count(*)::int FROM public.bookings actual WHERE actual.id=b.id) AS actual_bookings,
    (SELECT count(*)::int FROM public.booking_revisions v WHERE v.booking_id=b.id AND v.kind='cancelled') AS cancellations,
    (SELECT count(*)::int FROM public.payment_refunds f WHERE f.booking_id=b.id) AS refunds,
    (SELECT count(*)::int FROM public.booking_revisions v WHERE v.booking_id=b.id AND v.kind='confirmed') AS confirmations
    FROM public.checkout_records b JOIN public.court_reservations r ON r.id=b.reservation_id
    JOIN public.payment_attempts p ON p.booking_id=b.id WHERE b.id=$1`, [booking.booking_id]);
  return row;
}

test.each(["guest", "owner"])("%s unpaid checkout releases its hold without creating a booking or cancellation revision", async owner => {
  const booking = await hold(owner === "guest" ? null : users[0]);
  expect(await abandonOnlineCheckout(booking.access)).toMatchObject({ released: true, paymentStatus: "cancelled" });
  expect(await state(booking)).toMatchObject({ status: "cancelled", reservation_status: "released",
    payment_status: "cancelled", hold_expires_at: null, refunds: 0, confirmations: 0, actual_bookings: 0, cancellations: 0, booking_notifications: 0 });
  expect(cancelPayment).toHaveBeenCalledOnce();
  expect(refundPayment).not.toHaveBeenCalled();
});

test("uncertain explicit cancellation retains occupancy past the deadline until definitive provider cancellation", async () => {
  const booking = await hold();
  cancelPayment.mockRejectedValueOnce(new Error("Provider unavailable"));
  await expect(abandonOnlineCheckout(booking.access)).rejects.toThrow("Provider unavailable");
  expect(await state(booking)).toMatchObject({ status: "cancelled", reservation_status: "held", payment_status: "pending" });
  const { manager } = await getDataSource();
  await manager.query("UPDATE public.court_reservations SET hold_expires_at=clock_timestamp()-interval '1 minute' WHERE id=$1", [booking.reservation_id]);
  await expirePaymentHolds({ locationId });
  expect(await state(booking)).toMatchObject({ status: "cancelled", reservation_status: "held", payment_status: "pending" });
  await checkOnlinePayment(booking.payment_attempt_id);
  expect(await state(booking)).toMatchObject({ status: "cancelled", reservation_status: "released", payment_status: "cancelled" });
});

test("checkout abandonment cannot release an accepted capture and expiry also preserves it", async () => {
  const booking = await hold();
  const { manager } = await getDataSource();
  await manager.query(`UPDATE public.court_reservations SET hold_expires_at=(SELECT expires_at+make_interval(secs => $2)
    FROM public.payment_attempts WHERE id=$1) WHERE id=$3`, [booking.payment_attempt_id, checkoutCaptureGraceSeconds, booking.reservation_id]);
  await expect(abandonOnlineCheckout(booking.access)).rejects.toThrow("being confirmed");
  await expirePaymentHolds({ locationId });
  expect(await state(booking)).toMatchObject({ status: "pending_payment", reservation_status: "held", payment_status: "pending" });
  expect(cancelPayment).not.toHaveBeenCalled();
});

test.each(["owner", "guest"])("a fresh confirmed %s checkout capability cannot cancel or request a refund", async owner => {
  const booking = await hold(owner === "guest" ? null : users[0]);
  expect(await settle(booking)).toBe("succeeded");
  const before = await state(booking);
  expect(before).toMatchObject({ status: "confirmed", reservation_status: "active", confirmations: 1, refunds: 0, actual_bookings: 1 });
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
  expect(await state(booking)).toMatchObject({ status: "cancelled", reservation_status: "cancelled", refunds: 1, actual_bookings: 1, cancellations: 1 });
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
    expect(await state(booking)).toMatchObject({ status: "cancelled", reservation_status: "held", refunds: 0 });
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


test("a definitive card failure cancels the exact Stripe attempt and releases an unconfirmed checkout", async () => {
  const checkout = await hold(null);
  readPayment.mockResolvedValue({ status: "pending", amountMinor: 5000, currency: "RON", providerCaptureId: null, live: false });
  await resolveFailedCheckoutPayment({ attemptId: checkout.payment_attempt_id, providerPaymentId: `pi_${checkout.payment_attempt_id}` });
  expect(await state(checkout)).toMatchObject({ status: "failed", reservation_status: "released", actual_bookings: 0, cancellations: 0, booking_notifications: 0 });
  expect(cancelPayment).toHaveBeenCalledOnce();
});

test("failure cleanup with an ambiguous Stripe outcome preserves protection and creates no booking", async () => {
  const checkout = await hold(null);
  readPayment.mockResolvedValue({ status: "pending", amountMinor: 5000, currency: "RON", providerCaptureId: null, live: false });
  cancelPayment.mockRejectedValueOnce(new Error("timeout"));
  await expect(resolveFailedCheckoutPayment({ attemptId: checkout.payment_attempt_id, providerPaymentId: `pi_${checkout.payment_attempt_id}` })).rejects.toThrow("timeout");
  expect(await state(checkout)).toMatchObject({ status: "failed", reservation_status: "held", actual_bookings: 0, cancellations: 0, booking_notifications: 0 });
});

async function passDeadline(booking: HeldBooking) {
  const { manager } = await getDataSource();
  await (await getDataSource()).transaction(m => setPaymentAttemptExpiryFixture(m, booking.payment_attempt_id, "2020-01-01T00:00:00Z"));
  await manager.query("UPDATE public.court_reservations SET hold_expires_at=(SELECT expires_at FROM public.payment_attempts WHERE id=$1) WHERE id=$2", [booking.payment_attempt_id, booking.reservation_id]);
}

test("browser abandonment keeps a valid hold then server reconciliation cancels unpaid Stripe and releases GiST occupancy", async () => {
  const booking = await hold();
  readPayment.mockResolvedValue({ status: "pending", amountMinor: 5000, currency: "RON", providerCaptureId: null, live: false });
  const { manager } = await getDataSource();
  await cleanupScheduledCheckouts();
  expect(cancelPayment).not.toHaveBeenCalled();
  expect(await state(booking)).toMatchObject({ reservation_status: "held", payment_status: "pending", actual_bookings: 0 });
  expect(await reservationReads.listAdminOperationalProjection(manager, [courtId], "2099-10-15"))
    .toEqual(expect.arrayContaining([expect.objectContaining({ id: booking.booking_id, kind: "hold", customer_name: "Checkout customer" })]));
  await passDeadline(booking);
  cancelPayment.mockRejectedValueOnce(new Error("ambiguous cancellation"));
  await expect(checkOnlinePayment(booking.payment_attempt_id)).rejects.toThrow("ambiguous cancellation");
  await expirePaymentHolds({ locationId });
  expect(await state(booking)).toMatchObject({ reservation_status: "held", payment_status: "pending", actual_bookings: 0 });
  expect(await reservationReads.listPublicDayOccupancy(manager, locationId, [courtId], "2099-10-15"))
    .toEqual(expect.arrayContaining([expect.objectContaining({ starts_at_minute: (await manager.query("SELECT starts_at_minute FROM court_reservations WHERE id=$1", [booking.reservation_id]))[0].starts_at_minute })]));
  await checkOnlinePayment(booking.payment_attempt_id);
  expect(await state(booking)).toMatchObject({ status: "expired", reservation_status: "released", payment_status: "cancelled", actual_bookings: 0, cancellations: 0 });
  const [row] = await manager.query("SELECT starts_at_minute,ends_at_minute FROM public.court_reservations WHERE id=$1", [booking.reservation_id]);
  expect(await reservationReads.listPublicDayOccupancy(manager, locationId, [courtId], "2099-10-15"))
    .not.toEqual(expect.arrayContaining([expect.objectContaining({ starts_at_minute: row.starts_at_minute })]));
  // A new active row at the same interval proves the physical GiST entry was released.
  await manager.query("INSERT INTO public.court_reservations(court_id,booking_date,starts_at_minute,ends_at_minute,status,reason) VALUES($1,'2099-10-15',$2,$3,'active','replacement')", [courtId,row.starts_at_minute,row.ends_at_minute]);
  await checkOnlinePayment(booking.payment_attempt_id);
  expect(await state(booking)).toMatchObject({ actual_bookings: 0, confirmations: 0, refunds: 0 });
});


test("authorization arriving after expiry is cancelled without capture and duplicate cancellation webhooks are harmless", async () => {
  const booking = await hold();
  await passDeadline(booking);
  readPayment.mockResolvedValue({ status: "authorized", amountMinor: 5000, currency: "RON", providerCaptureId: null, live: false });
  expect(await resolveAuthorizedCheckoutPayment({ attemptId: booking.payment_attempt_id, providerPaymentId: `pi_${booking.payment_attempt_id}` })).toBe("cancelled");
  const event: Parameters<typeof processOnlinePaymentEvent>[0] = { provider: "stripe", attemptId: booking.payment_attempt_id, providerPaymentId: `pi_${booking.payment_attempt_id}`,
    eventId: `cancelled_${booking.payment_attempt_id}`, outcome: "cancelled", amountMinor: 5000, currency: "RON" };
  await processOnlinePaymentEvent(event);
  await processOnlinePaymentEvent(event);
  expect(capturePayment).not.toHaveBeenCalled();
  expect(await state(booking)).toMatchObject({ status: "expired", reservation_status: "released", payment_status: "cancelled", actual_bookings: 0, refunds: 0 });
});

test("capture accepted before expiry wins the race and confirms exactly one booking after the browser disappears", async () => {
  const booking = await hold();
  readPayment.mockResolvedValue({ status: "authorized", amountMinor: 5000, currency: "RON", providerCaptureId: null, live: false });
  let entered!: () => void, resume!: () => void;
  const capturing = new Promise<void>(r => { entered = r; }), continueCapture = new Promise<void>(r => { resume = r; });
  capturePayment.mockImplementationOnce(async () => {
    entered(); await continueCapture;
    return { status: "succeeded", amountMinor: 5000, currency: "RON", providerCaptureId: `pi_${booking.payment_attempt_id}` };
  });
  const operation = resolveAuthorizedCheckoutPayment({ attemptId: booking.payment_attempt_id, providerPaymentId: `pi_${booking.payment_attempt_id}` });
  try {
    await capturing;
    await passDeadline(booking);
    const { manager } = await getDataSource();
    await manager.query(`UPDATE court_reservations SET hold_expires_at=(SELECT expires_at+make_interval(secs => $2) FROM payment_attempts WHERE id=$1) WHERE id=$3`,
      [booking.payment_attempt_id, checkoutCaptureGraceSeconds, booking.reservation_id]);
    await expirePaymentHolds({ locationId });
    expect(await state(booking)).toMatchObject({ reservation_status: "held", payment_status: "pending", actual_bookings: 0 });
    resume();
    expect(await operation).toBe("succeeded");
    await settle(booking);
    await settle(booking);
    expect(await state(booking)).toMatchObject({ status: "confirmed", reservation_status: "active", payment_status: "succeeded", actual_bookings: 1, confirmations: 1, refunds: 0 });
    expect(capturePayment).toHaveBeenCalledOnce();
  } finally { resume(); await operation; }
});
