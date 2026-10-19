import { bookingNotifications } from "./booking-notification-fixtures";
import { configureCheckoutPolicyFixture } from "./opening-hours-fixtures";
import { listOwnCourtActivity } from "@/lib/bookings/activity-service";
import { parseActivityQuery, type ActivityScope } from "@/lib/bookings/activity-query";
import { listOwnCourtHistory } from "../helpers/current-activity";
import { listOwnUpcomingCustomerBookings } from "../helpers/current-activity";
import { cancelOwnCustomerBooking } from "@/lib/bookings/self-cancellation-service";
import { cleanupBookingFixtures, insertCheckoutFixture } from "./checkout-fixtures";
import { setPaymentAttemptExpiryFixture } from "../local/booking-fixtures";
import { randomUUID } from "node:crypto";
import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";
import { revalidatePath } from "next/cache";
import { revalidateCourtActivity } from "@/lib/reservations/revalidation";
import { expect, test, vi } from "vitest";
import { cleanupAuthFixtures, localFixtureClient } from "./auth-fixtures";
import { POST } from "@/app/api/payments/stripe/webhook/route";
import { POST as checkoutStatus } from "@/app/api/payments/checkout/status/route";
import { abandonOnlineCheckout, startOnlineCheckout, readOnlineCheckout } from "@/lib/payments/checkout";
import { paymentHoldDurationSeconds } from "@/lib/payments/domain";
import { getDataSource } from "@/lib/db/data-source";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/reservations/revalidation", () => ({ revalidateCourtActivity: vi.fn() }));
// Only the external creation call is simulated; signature verification and DB lifecycle are real.
const { create, retrieve, cancel, refundCreate, refundList, refundRetrieve } = vi.hoisted(() => ({ create: vi.fn(), retrieve: vi.fn(), cancel: vi.fn(), refundCreate: vi.fn(), refundList: vi.fn(), refundRetrieve: vi.fn() }));
vi.mock("@/lib/payments/providers/stripe/client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/payments/providers/stripe/client")>("@/lib/payments/providers/stripe/client");
  return { ...actual, stripeClient: () => ({ paymentIntents: { create, retrieve, cancel }, refunds: { create: refundCreate, list: refundList, retrieve: refundRetrieve }, webhooks: new Stripe("sk_test_Fixture").webhooks }) };
});

test("verified webhook settles original hold once, keeps retryable failure, releases terminal cancellation, and records late success without reclaiming occupancy", async () => {
  const db = localFixtureClient();
  const previous = (await db.from("payment_provider_settings").select("active_provider").single()).data!.active_provider;
  const locationId = randomUUID(), courtId = randomUUID();
  const stripe = new Stripe("sk_test_Fixture");
  const userIds: string[] = [];
  const member = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_PUBLISHABLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const activity = async (scope: ActivityScope, now?: string) =>
    (await listOwnCourtActivity(scope, parseActivityQuery({}, scope), member, now ? new Date(now) : new Date())).rows;
  const invisible = async (id: string) => {
    for (const scope of ["upcoming", "history"] as const) expect((await activity(scope)).map((r: { id: string }) => r.id)).not.toContain(id);
    expect((await listOwnUpcomingCustomerBookings(member)).map((r) => r.id)).not.toContain(id);
    expect((await listOwnCourtHistory(1, member)).rows.map((r) => r.id)).not.toContain(id);
  };
  const params = (start: number) => ({ p_court_id: courtId, p_booking_date: "2099-10-15", p_starts_at_minute: start,
    p_ends_at_minute: start + 60, p_account_user_id: userIds[0], p_customer_name: "Stripe guest",
    p_customer_email: "stripe@example.test", p_customer_phone: "123", p_total_amount_minor: 5000,
    p_currency: "RON", p_payment_method: "online", p_provider: "stripe", p_hold_seconds: paymentHoldDurationSeconds });
  async function hold(start: number, owner: string | null = userIds[0]) {
    const held = await insertCheckoutFixture(db, { ...params(start), p_account_user_id: owner });
    expect(held.error).toBeNull();
    return held.data[0];
  }
  async function begin(attemptId: string) {
    create.mockResolvedValueOnce({ id: `pi_${attemptId}`, client_secret: `pi_${attemptId}_secret` });
    return startOnlineCheckout(attemptId);
  }
  function webhook(attemptId: string, type: string, eventId = `evt_${randomUUID()}`, amount = 5000) {
    const payload = JSON.stringify({ id: eventId, type, data: { object: { id: `pi_${attemptId}`, amount,
      amount_received: amount, currency: "ron", metadata: { payment_attempt_id: attemptId } } } });
    return new Request("http://localhost/api/payments/stripe/webhook", { method: "POST", body: payload,
      headers: { "stripe-signature": stripe.webhooks.generateTestHeaderString({ payload, secret: "whsec_Fixture" }) } });
  }
  const email = async (id: string) => (await bookingNotifications((await getDataSource()).manager, id)).map(({ subject }) => ({ subject }));
  async function evidence(booking: Awaited<ReturnType<typeof hold>>, status: string, kinds: string[], attemptStatus: string, amount: number) {
    const identity = await db.from("bookings").select("status,current_revision_id").eq("id", booking.booking_id).single();
    const revisions = await db.from("booking_revisions").select("id,kind,booking_state").eq("booking_id", booking.booking_id).order("revision_number");
    expect(identity.error).toBeNull(); expect(revisions.error).toBeNull();
    expect(identity.data?.status).toBe(status);
    expect(revisions.data?.map(r => r.kind)).toEqual(kinds);
    expect(identity.data?.current_revision_id).toBe(revisions.data?.at(-1)?.id);
    expect(revisions.data?.at(-1)?.booking_state).toBe(status === "expired" ? "pending_payment" : status);
    const reservation = await db.from("court_reservations").select("status,hold_expires_at").eq("id", booking.reservation_id).single();
    expect(reservation.error).toBeNull();
    expect(reservation.data?.status).toBe(status === "pending_payment" ? "held" : "released");
    if (status === "pending_payment") expect(Date.parse(reservation.data!.hold_expires_at)).toBe(Date.parse(booking.hold_expires_at!));
    else expect(reservation.data?.hold_expires_at).toBeNull();
    const attempt = await db.from("payment_attempts").select("id,status,provider_payment_id,amount_minor,currency").eq("id", booking.payment_attempt_id).single();
    expect(attempt.error).toBeNull();
    expect(attempt.data).toEqual({ id: booking.payment_attempt_id, status: attemptStatus,
      provider_payment_id: `pi_${booking.payment_attempt_id}`, amount_minor: 5000, currency: "RON" });
    const refunds = await db.from("payment_refunds").select("payment_attempt_id,amount_minor").eq("booking_id", booking.booking_id);
    expect(refunds.error).toBeNull();
    expect(refunds.data).toEqual(amount ? [{ payment_attempt_id: booking.payment_attempt_id, amount_minor: amount }] : []);
    if (amount && attemptStatus !== "succeeded") {
      const captures = await db.from("payment_provider_events").select("attempt_id,provider_payment_id,amount_minor,currency")
        .eq("attempt_id", booking.payment_attempt_id).eq("outcome", "succeeded");
      expect(captures.error).toBeNull();
      expect(captures.data).toContainEqual({ attempt_id: booking.payment_attempt_id,
        provider_payment_id: `pi_${booking.payment_attempt_id}`, amount_minor: amount, currency: "RON" });
    }
  }
  try {
    const emailAddress = `stripe-${randomUUID()}@example.test`;
    const account = await db.auth.admin.createUser({ email: emailAddress, password: "stripe-test-password-123", email_confirm: true });
    expect(account.error).toBeNull(); userIds.push(account.data.user!.id);
    expect((await member.auth.signInWithPassword({ email: emailAddress, password: "stripe-test-password-123" })).error).toBeNull();
    retrieve.mockImplementation(async (id: string) => ({ id, status: "requires_payment_method", amount: 5000, amount_received: 0,
      currency: "ron", metadata: { payment_attempt_id: id.slice(3) } }));
    refundList.mockReturnValue([]);
    refundCreate.mockImplementation(async (input: { amount: number; payment_intent: string; metadata: { payment_refund_id: string; refund_execution_id: string } }, options: { idempotencyKey: string }) => ({
      id: `re_${options.idempotencyKey}`, status: "succeeded", amount: input.amount, currency: "ron", payment_intent: input.payment_intent, metadata: input.metadata,
    }));
    refundRetrieve.mockImplementation(async (id: string) => ({ id, status: "succeeded", amount: 5000, currency: "ron" }));
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_Fixture"); vi.stubEnv("STRIPE_PUBLISHABLE_KEY", "pk_test_Fixture"); vi.stubEnv("STRIPE_WEBHOOK_SECRET", "whsec_Fixture");
    expect((await db.from("payment_provider_settings").update({ active_provider: "stripe" }).eq("id", true)).error).toBeNull();
    expect((await db.from("locations").insert({ id: locationId, name: "Stripe test", slug: `stripe-${locationId}`, timezone: "UTC", currency: "RON", is_public: true })).error).toBeNull();
    expect((await db.from("courts").insert({ id: courtId, location_id: locationId, name: "Court", slug: "court", environment: "outdoor", surface: "clay" })).error).toBeNull();
    await configureCheckoutPolicyFixture(db,locationId,courtId);
    const held = await hold(600), checkout = await begin(held.payment_attempt_id);
    expect(create).toHaveBeenCalledWith({ amount: 5000, currency: "ron", allowed_payment_method_types: ["card"],
      capture_method: "manual", metadata: { payment_attempt_id: held.payment_attempt_id } }, { idempotencyKey: `court-payment-${held.payment_attempt_id}` });
    expect((await insertCheckoutFixture(db, params(600))).error?.code).toBe("23P01");
    expect(await email(held.booking_id)).toEqual([]);
    expect(await readOnlineCheckout({ attemptId: checkout.attemptId, token: checkout.token })).toMatchObject({ status: "pending_payment" });
    await invisible(held.booking_id);
    expect(await cancelOwnCustomerBooking(held.booking_id, member)).toMatchObject({ ok: false });
    await expect(readOnlineCheckout({ attemptId: checkout.attemptId, token: "a".repeat(64) })).rejects.toThrow();
    expect((await POST(new Request("http://localhost", { method: "POST", body: "{}", headers: { "stripe-signature": "invalid" } }))).status).toBe(400);
    expect(await email(held.booking_id)).toEqual([]);
    const eventId = `evt_${randomUUID()}`;
    expect((await Promise.all([POST(webhook(checkout.attemptId, "payment_intent.succeeded", eventId)),
      POST(webhook(checkout.attemptId, "payment_intent.succeeded", eventId))])).map(r => r.status)).toEqual([200,200]);
    // A second distinct success event is also harmless.
    expect((await POST(webhook(checkout.attemptId, "payment_intent.succeeded"))).status).toBe(200);
    expect(await readOnlineCheckout({ attemptId: checkout.attemptId, token: checkout.token })).toMatchObject({ status: "confirmed", cancellationPolicy: { noticeMinutes: 1440 } });
    expect((await db.from("bookings").select("reservation_id,status").eq("id", held.booking_id).single()).data)
      .toEqual({ reservation_id: held.reservation_id, status: "confirmed" });
    expect((await db.from("court_reservations").select("status,hold_expires_at").eq("id", held.reservation_id).single()).data)
      .toEqual({ status: "active", hold_expires_at: null });
    expect(await email(held.booking_id)).toEqual([{ subject: "Booking confirmed" }]);
    expect((await activity("upcoming")).map((r: { id: string }) => r.id)).toEqual([held.booking_id]);
    expect((await activity("history", "2099-10-16T00:00:00Z")).map((r: { id: string }) => r.id)).toEqual([held.booking_id]);
    expect((await cancelOwnCustomerBooking(held.booking_id, member)).ok).toBe(true);
    expect(await activity("upcoming")).toEqual([]);
    expect(await activity("history")).toMatchObject([{ id: held.booking_id, status: "cancelled" }]);
    expect((await email(held.booking_id))?.map(event => event.subject).sort())
      .toEqual(["Booking cancelled", "Booking confirmed"]);
    const failed = await hold(660), failureCheckout = await begin(failed.payment_attempt_id);
    expect((await POST(webhook(failureCheckout.attemptId, "payment_intent.payment_failed"))).status).toBe(200);
    expect(await readOnlineCheckout({ attemptId: failureCheckout.attemptId, token: failureCheckout.token })).toMatchObject({ status: "pending_payment" });
    const failedReservation = (await db.from("court_reservations").select("status,hold_expires_at").eq("id", failed.reservation_id).single()).data!;
    expect(failedReservation.status).toBe("held");
    expect(Date.parse(failedReservation.hold_expires_at)).toBe(Date.parse(failed.hold_expires_at!));
    expect((await db.from("payment_attempts").select("status,provider_payment_id").eq("id", failed.payment_attempt_id).single()).data)
      .toEqual({ status: "pending", provider_payment_id: `pi_${failed.payment_attempt_id}` });
    await invisible(failed.booking_id);
    expect((await insertCheckoutFixture(db, params(660))).error?.code).toBe("23P01");
    // A different card succeeds on the original pending attempt and reservation.
    expect((await POST(webhook(failureCheckout.attemptId, "payment_intent.succeeded"))).status).toBe(200);
    expect(await readOnlineCheckout({ attemptId: failureCheckout.attemptId, token: failureCheckout.token })).toMatchObject({ status: "confirmed" });
    expect(await email(failed.booking_id)).toEqual([{ subject: "Booking confirmed" }]);
    // A delayed decline must not downgrade success.
    expect((await POST(webhook(failureCheckout.attemptId, "payment_intent.payment_failed"))).status).toBe(200);
    expect(await readOnlineCheckout({ attemptId: failureCheckout.attemptId, token: failureCheckout.token })).toMatchObject({ status: "confirmed" });
    await expect(abandonOnlineCheckout({ attemptId: failureCheckout.attemptId, token: failureCheckout.token })).rejects.toThrow("already confirmed");
    expect((await db.from("bookings").select("status").eq("id", failed.booking_id).single()).data?.status).toBe("confirmed");
    expect((await db.from("court_reservations").select("status").eq("id", failed.reservation_id).single()).data?.status).toBe("active");
    expect((await db.from("payment_attempts").select("status").eq("id", failed.payment_attempt_id).single()).data?.status).toBe("succeeded");
    expect((await db.from("payment_refunds").select("status,amount_minor").eq("booking_id", failed.booking_id)).data)
      .toEqual([]);
    const cancelled = await hold(780), cancelledCheckout = await begin(cancelled.payment_attempt_id);
    vi.mocked(revalidateCourtActivity).mockClear();
    retrieve.mockResolvedValue({ status: "requires_payment_method" }); cancel.mockResolvedValue({ status: "canceled" });
    await expect(abandonOnlineCheckout({ attemptId: cancelledCheckout.attemptId, token: "b".repeat(64) })).rejects.toThrow();
    expect(cancel).not.toHaveBeenCalled();
    expect(await abandonOnlineCheckout({ attemptId: cancelledCheckout.attemptId, token: cancelledCheckout.token })).toMatchObject({ released: true, paymentStatus: "cancelled" });
    expect(cancel).toHaveBeenCalledWith(`pi_${cancelledCheckout.attemptId}`, { cancellation_reason: "abandoned" },
      { idempotencyKey: `court-payment-abandon-${cancelledCheckout.attemptId}` });
    const cancellationId = `evt_${randomUUID()}`;
    expect((await POST(webhook(cancelledCheckout.attemptId, "payment_intent.canceled", cancellationId))).status).toBe(200);
    expect(revalidateCourtActivity).toHaveBeenCalledWith("create");
    expect((await POST(webhook(cancelledCheckout.attemptId, "payment_intent.canceled", cancellationId))).status).toBe(200);
    expect(await readOnlineCheckout({ attemptId: cancelledCheckout.attemptId, token: cancelledCheckout.token })).toMatchObject({ status: "cancelled" });
    expect((await db.from("payment_attempts").select("status").eq("id", cancelled.payment_attempt_id).single()).data?.status).toBe("cancelled");
    expect((await db.from("court_reservations").select("status,hold_expires_at").eq("id", cancelled.reservation_id).single()).data)
      .toEqual({ status: "released", hold_expires_at: null });
    await evidence(cancelled, "cancelled", ["created", "cancelled"], "cancelled", 0);
    // The owner boundary cannot replay a different capability operation.
    expect(await cancelOwnCustomerBooking(cancelled.booking_id, member)).toMatchObject({ ok: false });
    await invisible(cancelled.booking_id);
    expect(await email(cancelled.booking_id)).toEqual([]);
    expect((await hold(780)).reservation_id).not.toBe(cancelled.reservation_id);
    expect((await POST(webhook(cancelledCheckout.attemptId, "payment_intent.succeeded"))).status).toBe(200);
    await evidence(cancelled, "cancelled", ["created", "cancelled"], "cancelled", 5000);
    expect((await POST(webhook(cancelledCheckout.attemptId, "payment_intent.succeeded"))).status).toBe(200);
    expect((await POST(webhook(cancelledCheckout.attemptId, "payment_intent.canceled"))).status).toBe(200);
    await evidence(cancelled, "cancelled", ["created", "cancelled"], "cancelled", 5000);
    // One notice that the late payment is being refunded, even across duplicate deliveries.
    expect(await email(cancelled.booking_id)).toEqual([{ subject: "Payment received after checkout ended" }]);
    // A distinct late duplicate marks a new receipt; its settlement re-checks the
    // already verified refund and resolves it without another refund.
    expect((await db.from("payment_provider_events").select("reconciliation_required").eq("attempt_id", cancelledCheckout.attemptId)
      .eq("outcome", "succeeded")).data).toEqual([{ reconciliation_required: false }, { reconciliation_required: false }]);
    retrieve.mockImplementation(async (id: string) => ({ id, status: "requires_payment_method", amount: 5000, amount_received: 0,
      currency: "ron", metadata: { payment_attempt_id: id.slice(3) } }));
    const expired = await hold(840), expiredCheckout = await begin(expired.payment_attempt_id);
    expect((await db.from("court_reservations").update({ hold_expires_at: "2020-01-01T00:00:00Z" }).eq("id", expired.reservation_id)).error).toBeNull();
    vi.mocked(revalidatePath).mockClear();
    expect(await readOnlineCheckout({ attemptId: expiredCheckout.attemptId, token: expiredCheckout.token })).toMatchObject({ status: "expired" });
    expect(revalidatePath).toHaveBeenCalledWith("/book");
    await invisible(expired.booking_id);
    const replacement = await hold(840);
    expect((await POST(webhook(expiredCheckout.attemptId, "payment_intent.succeeded"))).status).toBe(200);
    expect(await readOnlineCheckout({ attemptId: expiredCheckout.attemptId, token: expiredCheckout.token })).toMatchObject({ status: "expired" });
    expect((await db.from("court_reservations").select("status").eq("id", replacement.reservation_id).single()).data?.status).toBe("held");
    // One notice that the late payment is being refunded, even across duplicate deliveries.
    expect(await email(expired.booking_id)).toEqual([{ subject: "Payment received after checkout ended" }]);
    // Polling confirmed Stripe cancellation; the booking remains locally expired.
    await evidence(expired, "expired", ["created"], "cancelled", 5000);
    expect((await db.from("payment_provider_events").select("settlement_result,reconciliation_required").eq("attempt_id", expiredCheckout.attemptId)).data)
      .toEqual([{ settlement_result: "cancelled", reconciliation_required: false }]);
    // Cancellation intent commits before a provider timeout. A capture racing
    // that request must release the original row and request exactly one refund.
    const racing = await hold(900, null), racingCheckout = await begin(racing.payment_attempt_id);
    const racingAccess = { attemptId: racingCheckout.attemptId, token: racingCheckout.token };
    let releaseCancel!: () => void;
    const providerBlocked = new Promise<void>(resolve => { releaseCancel = resolve; });
    let contacted!: () => void;
    const providerContacted = new Promise<void>(resolve => { contacted = resolve; });
    retrieve.mockImplementation(async (id: string) => ({ id, status: "processing", amount: 5000, amount_received: 0,
      currency: "ron", metadata: { payment_attempt_id: id.slice(3) } }));
    cancel.mockImplementationOnce(async () => { contacted(); await providerBlocked; throw new Error("Network timeout"); });
    const cancellation = abandonOnlineCheckout(racingAccess);
    await providerContacted;
    expect((await db.from("bookings").select("status").eq("id", racing.booking_id).single()).data?.status).toBe("cancelled");
    expect((await db.from("court_reservations").select("status").eq("id", racing.reservation_id).single()).data?.status).toBe("released");
    const raceReplacement = await hold(900);
    await evidence(racing, "cancelled", ["created", "cancelled"], "pending", 0);
    const racingEvent = `evt_${randomUUID()}`, createsBeforeRace = refundCreate.mock.calls.length;
    refundCreate.mockImplementationOnce(async (input, options) => {
      // Stripe accepted the operation but its HTTP response was lost. Recovery
      // rediscovers this same execution; it must not issue another creation.
      refundList.mockReturnValueOnce([{ id: `re_${options.idempotencyKey}`, status: "succeeded",
        amount: input.amount, currency: "ron", payment_intent: input.payment_intent, metadata: input.metadata }]);
      throw new Error("Refund response uncertain");
    });
    expect((await POST(webhook(racingCheckout.attemptId, "payment_intent.succeeded", racingEvent))).status).toBe(200);
    // The webhook does not acknowledge an unconfirmed compensation refund: it
    // re-checks it under the same idempotency key before answering 200.
    expect((await db.from("payment_refunds").select("status").eq("booking_id", racing.booking_id)).data)
      .toEqual([{ status: "succeeded" }]);
    expect(refundCreate.mock.calls.length).toBe(createsBeforeRace + 1);
    const creationCallsBeforeRecovery=refundCreate.mock.calls.length;
    releaseCancel();
    await cancellation;
    expect(refundCreate.mock.calls.length).toBe(creationCallsBeforeRecovery);
    expect(await readOnlineCheckout(racingAccess)).toMatchObject({ status: "cancelled", paymentStatus: "refunded" });
    expect((await db.from("payment_refunds").select("id,status,amount_minor").eq("booking_id", racing.booking_id)).data)
      .toMatchObject([{ status: "succeeded", amount_minor: 5000 }]);
    expect((await db.from("payment_refunds").select("id").eq("booking_id", racing.booking_id)).data).toHaveLength(1);
    expect((await db.from("court_reservations").select("status").eq("id", racing.reservation_id).single()).data?.status).toBe("released");
    // Money moved after the customer cancelled: one notice that it is being refunded.
    expect(await email(racing.booking_id)).toEqual([{ subject: "Payment received after checkout ended" }]);
    await evidence(racing, "cancelled", ["created", "cancelled"], "succeeded", 5000);
    expect((await db.from("court_reservations").select("status").eq("id", raceReplacement.reservation_id).single()).data?.status).toBe("held");
    expect((await Promise.all([POST(webhook(racingCheckout.attemptId, "payment_intent.succeeded", racingEvent)),
      POST(webhook(racingCheckout.attemptId, "payment_intent.payment_failed"))])).map(r => r.status)).toEqual([200, 200]);
    const refundCalls = refundCreate.mock.calls.length;
    await Promise.all([abandonOnlineCheckout(racingAccess), abandonOnlineCheckout(racingAccess)]);
    expect(refundCreate.mock.calls.length).toBe(refundCalls);
    await expect(startOnlineCheckout(racingCheckout.attemptId)).rejects.toThrow("Payment hold expired");
    // No local webhook listener: provider retrieval settles the original intent,
    // with delayed/reordered webhook delivery adding receipts only.
    const noWebhook = await hold(960), noWebhookCheckout = await begin(noWebhook.payment_attempt_id);
    retrieve.mockImplementation(async (id: string) => ({ id, status: "succeeded", amount: 5000, amount_received: 5000,
      currency: "ron", metadata: { payment_attempt_id: id.slice(3) } }));
    const noWebhookAccess = { attemptId: noWebhookCheckout.attemptId, token: noWebhookCheckout.token };
    const statusResponse = await checkoutStatus(new Request("http://localhost/api/payments/checkout/status", {
      method: "POST", body: JSON.stringify(noWebhookAccess),
    }));
    expect(statusResponse.headers.get("cache-control")).toBe("no-store");
    expect(await statusResponse.json()).toMatchObject({ ok: true, status: "confirmed", paymentStatus: "succeeded" });
    expect((await checkoutStatus(new Request("http://localhost/api/payments/checkout/status", {
      method: "POST", body: JSON.stringify({ ...noWebhookAccess, token: "0".repeat(64) }),
    }))).status).toBe(503);
    expect((await POST(webhook(noWebhookCheckout.attemptId, "payment_intent.succeeded"))).status).toBe(200);
    expect((await POST(webhook(noWebhookCheckout.attemptId, "payment_intent.payment_failed"))).status).toBe(200);
    const noWebhookCaptures = await db.from("payment_capture_receipts")
      .select("payment_attempt_id,provider_payment_id,provider_capture_id,amount_minor,currency,first_observed_at,last_observed_at")
      .eq("payment_attempt_id",noWebhookCheckout.attemptId);
    expect(noWebhookCaptures.error).toBeNull();
    expect(noWebhookCaptures.data).toEqual([expect.objectContaining({ payment_attempt_id:noWebhookCheckout.attemptId,
      provider_payment_id:`pi_${noWebhookCheckout.attemptId}`,provider_capture_id:`pi_${noWebhookCheckout.attemptId}`,
      amount_minor:5000,currency:"RON" })]);
    expect(Date.parse(noWebhookCaptures.data![0].last_observed_at)).toBeGreaterThanOrEqual(
      Date.parse(noWebhookCaptures.data![0].first_observed_at));
    expect(await email(noWebhook.booking_id)).toEqual([{ subject: "Booking confirmed" }]);
    expect((await db.from("bookings").select("id").eq("reservation_id", noWebhook.reservation_id)).data).toHaveLength(1);
    // An old confirmed capability cannot bypass normal booking cancellation policy.
    await (await getDataSource()).transaction(manager => setPaymentAttemptExpiryFixture(manager, noWebhookCheckout.attemptId, "2020-01-01T00:00:00Z"));
    await expect(abandonOnlineCheckout(noWebhookAccess)).rejects.toThrow("already confirmed");
    expect(await readOnlineCheckout(noWebhookAccess)).toMatchObject({ status: "confirmed" });
    retrieve.mockImplementation(async (id: string) => ({ id, status: "requires_payment_method", amount: 5000, amount_received: 0,
      currency: "ron", metadata: { payment_attempt_id: id.slice(3) } }));
    // Expiry during an unknown processing outcome ends the checkout, retaining
    // captured evidence for the existing Admin refund/reconciliation workflow.
    const uncertainExpiry = await hold(1020), uncertainCheckout = await begin(uncertainExpiry.payment_attempt_id);
    expect((await db.from("court_reservations").update({ hold_expires_at: "2020-01-01T00:00:00Z" }).eq("id", uncertainExpiry.reservation_id)).error).toBeNull();
    retrieve.mockRejectedValue(new Error("Stripe unavailable"));
    const uncertainAccess = { attemptId: uncertainCheckout.attemptId, token: uncertainCheckout.token };
    expect(await readOnlineCheckout(uncertainAccess)).toMatchObject({ status: "expired", paymentStatus: "expired", paymentUncertain: true });
    expect((await db.from("payment_attempts").select("status").eq("id", uncertainCheckout.attemptId).single()).data?.status).toBe("expired");
    await expect(startOnlineCheckout(uncertainCheckout.attemptId)).rejects.toThrow("Payment hold expired");
    const nextOccupant = await hold(1020);
    expect((await POST(webhook(uncertainCheckout.attemptId, "payment_intent.succeeded"))).status).toBe(200);
    expect(await readOnlineCheckout(uncertainAccess)).toMatchObject({ status: "expired", paymentStatus: "refunded" });
    await evidence(uncertainExpiry, "expired", ["created"], "expired", 5000);
    expect((await db.from("court_reservations").select("status").eq("id", nextOccupant.reservation_id).single()).data?.status).toBe("held");
    expect(await email(uncertainExpiry.booking_id)).toEqual([{ subject: "Payment received after checkout ended" }]);
    // A capture with no webhook racing the cancellation request is refunded,
    // preserving the guest capability and original financial snapshots.
    const capturedCancel = await hold(1080), capturedCheckout = await begin(capturedCancel.payment_attempt_id);
    retrieve.mockImplementation(async (id: string) => ({ id, status: "succeeded", amount: 5000, amount_received: 5000,
      currency: "ron", metadata: { payment_attempt_id: id.slice(3) } }));
    expect(await abandonOnlineCheckout({ attemptId: capturedCheckout.attemptId, token: capturedCheckout.token }))
      .toMatchObject({ released: true, paymentStatus: "refunded" });
    expect(await email(capturedCancel.booking_id)).toEqual([{ subject: "Payment received after checkout ended" }]);
    await evidence(capturedCancel, "cancelled", ["created", "cancelled"], "succeeded", 5000);
    expect((await db.from("payment_attempts").select("status,amount_minor").eq("id", capturedCheckout.attemptId).single()).data)
      .toEqual({ status: "succeeded", amount_minor: 5000 });
    retrieve.mockImplementation(async (id: string) => ({ id, status: "requires_payment_method", amount: 5000, amount_received: 0,
      currency: "ron", metadata: { payment_attempt_id: id.slice(3) } }));
    const uncertainCancel = await hold(1140), uncertainCancelCheckout = await begin(uncertainCancel.payment_attempt_id);
    const uncertainCancelAccess = { attemptId: uncertainCancelCheckout.attemptId, token: uncertainCancelCheckout.token };
    retrieve.mockRejectedValue(new Error("Provider cancellation outcome unknown"));
    await expect(abandonOnlineCheckout(uncertainCancelAccess)).rejects.toThrow();
    await evidence(uncertainCancel, "cancelled", ["created", "cancelled"], "pending", 0);
    expect((await db.from("payment_provider_events").select("event_id").eq("attempt_id", uncertainCancelCheckout.attemptId)).data).toEqual([]);
    const uncertainReplacement = await hold(1140);
    const lateEvent = `evt_${randomUUID()}`;
    expect((await POST(webhook(uncertainCancelCheckout.attemptId, "payment_intent.succeeded", lateEvent))).status).toBe(200);
    expect((await POST(webhook(uncertainCancelCheckout.attemptId, "payment_intent.succeeded", lateEvent))).status).toBe(200);
    await evidence(uncertainCancel, "cancelled", ["created", "cancelled"], "succeeded", 5000);
    expect((await db.from("court_reservations").select("status").eq("id", uncertainReplacement.reservation_id).single()).data?.status).toBe("held");
    expect(await email(uncertainCancel.booking_id)).toEqual([{ subject: "Payment received after checkout ended" }]);
    const mismatch = await hold(720), mismatchCheckout = await begin(mismatch.payment_attempt_id);
    expect((await POST(webhook(mismatchCheckout.attemptId, "payment_intent.succeeded", undefined, 1))).status).toBe(200);
    expect(await email(mismatch.booking_id)).toEqual([]);
    expect((await db.from("payment_provider_events").select("settlement_result,reconciliation_required").eq("attempt_id", mismatchCheckout.attemptId)).data)
      .toEqual([{ settlement_result: "amount_mismatch", reconciliation_required: true }]);
    await evidence(mismatch, "pending_payment", ["created"], "pending", 0);
    expect((await db.from("payment_provider_events").select("amount_minor,currency").eq("attempt_id", mismatchCheckout.attemptId)).data)
      .toEqual([{ amount_minor: 1, currency: "RON" }]);
    expect((await db.from("bookings").select("id").in("reservation_id", [held.reservation_id, failed.reservation_id, expired.reservation_id, replacement.reservation_id, mismatch.reservation_id])).data).toHaveLength(5);
  } finally {
    vi.unstubAllEnvs(); create.mockReset(); retrieve.mockReset(); cancel.mockReset(); refundCreate.mockReset(); refundList.mockReset(); refundRetrieve.mockReset();
    await db.from("payment_provider_settings").update({ active_provider: previous }).eq("id", true);
    const reservations = (await db.from("court_reservations").select("id").eq("court_id", courtId)).data?.map(r => r.id) ?? [];
    const bookings = (await db.from("bookings").select("id").in("reservation_id", reservations)).data?.map(b => b.id) ?? [];
    await cleanupBookingFixtures({ bookingIds: bookings });
    await db.from("court_reservations").delete().eq("court_id", courtId);
    await db.from("pricing_rule_sets").delete().eq("location_id",locationId);
    await db.from("location_opening_hours").delete().eq("location_id",locationId);
    await db.from("courts").delete().eq("id", courtId); await db.from("locations").delete().eq("id", locationId);
    await cleanupAuthFixtures(db, userIds);
  }
}, 30000);
