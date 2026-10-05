import { randomUUID } from "node:crypto";
import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";
import { revalidatePath } from "next/cache";
import { revalidateCourtActivity } from "@/lib/reservations/revalidation";
import { expect, test, vi } from "vitest";
import { cleanupAuthFixtures, localFixtureClient } from "./auth-fixtures";
import { POST } from "@/app/api/payments/stripe/webhook/route";
import { abandonOnlineCheckout, startOnlineCheckout, readOnlineCheckout } from "@/lib/payments/checkout";
import { paymentHoldDurationSeconds } from "@/lib/payments/domain";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/reservations/revalidation", () => ({ revalidateCourtActivity: vi.fn() }));
// Only the external creation call is simulated; signature verification and DB lifecycle are real.
const { create, retrieve, cancel } = vi.hoisted(() => ({ create: vi.fn(), retrieve: vi.fn(), cancel: vi.fn() }));
vi.mock("@/lib/payments/providers/stripe/client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/payments/providers/stripe/client")>("@/lib/payments/providers/stripe/client");
  return { ...actual, stripeClient: () => ({ paymentIntents: { create, retrieve, cancel }, webhooks: new Stripe("sk_test_Fixture").webhooks }) };
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
  const activity = async (scope: string, now?: string) => {
    const result = await member.rpc("list_own_court_activity", { p_scope: scope, ...(now ? { p_now: now } : {}) });
    expect(result.error).toBeNull(); return result.data.rows;
  };
  const invisible = async (id: string) => {
    for (const scope of ["upcoming", "history"]) expect((await activity(scope)).map((r: { id: string }) => r.id)).not.toContain(id);
    expect((await member.rpc("list_own_upcoming_customer_bookings")).data.map((r: { id: string }) => r.id)).not.toContain(id);
    expect((await member.rpc("list_own_court_activity_history")).data.map((r: { id: string }) => r.id)).not.toContain(id);
  };
  const params = (start: number) => ({ p_court_id: courtId, p_booking_date: "2099-10-15", p_starts_at_minute: start,
    p_ends_at_minute: start + 60, p_account_user_id: userIds[0], p_customer_name: "Stripe guest",
    p_customer_email: "stripe@example.test", p_customer_phone: "123", p_total_amount_minor: 5000,
    p_currency: "RON", p_payment_method: "online", p_provider: "stripe", p_hold_seconds: paymentHoldDurationSeconds });
  async function hold(start: number) {
    const held = await db.rpc("create_customer_booking", params(start));
    expect(held.error).toBeNull();
    return held.data[0];
  }
  async function begin(attemptId: string) {
    create.mockResolvedValueOnce({ id: `pi_${attemptId}`, client_secret: `pi_${attemptId}_secret` });
    return startOnlineCheckout(attemptId, db);
  }
  function webhook(attemptId: string, type: string, eventId = `evt_${randomUUID()}`, amount = 5000) {
    const payload = JSON.stringify({ id: eventId, type, data: { object: { id: `pi_${attemptId}`, amount,
      amount_received: amount, currency: "ron", metadata: { payment_attempt_id: attemptId } } } });
    return new Request("http://localhost/api/payments/stripe/webhook", { method: "POST", body: payload,
      headers: { "stripe-signature": stripe.webhooks.generateTestHeaderString({ payload, secret: "whsec_Fixture" }) } });
  }
  const email = async (id: string) => (await db.from("booking_email_outbox").select("event_kind").eq("booking_id", id)).data;
  try {
    const emailAddress = `stripe-${randomUUID()}@example.test`;
    const account = await db.auth.admin.createUser({ email: emailAddress, password: "stripe-test-password-123", email_confirm: true });
    expect(account.error).toBeNull(); userIds.push(account.data.user!.id);
    expect((await member.auth.signInWithPassword({ email: emailAddress, password: "stripe-test-password-123" })).error).toBeNull();
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_Fixture"); vi.stubEnv("STRIPE_PUBLISHABLE_KEY", "pk_test_Fixture"); vi.stubEnv("STRIPE_WEBHOOK_SECRET", "whsec_Fixture");
    expect((await db.from("payment_provider_settings").update({ active_provider: "stripe" }).eq("id", true)).error).toBeNull();
    expect((await db.from("locations").insert({ id: locationId, name: "Stripe test", slug: `stripe-${locationId}`, timezone: "UTC", currency: "RON", is_public: true })).error).toBeNull();
    expect((await db.from("courts").insert({ id: courtId, location_id: locationId, name: "Court", slug: "court", environment: "outdoor", surface: "clay" })).error).toBeNull();
    const held = await hold(600), checkout = await begin(held.payment_attempt_id);
    expect(create).toHaveBeenCalledWith({ amount: 5000, currency: "ron", allowed_payment_method_types: ["card"],
      metadata: { payment_attempt_id: held.payment_attempt_id } }, { idempotencyKey: `court-payment-${held.payment_attempt_id}` });
    expect((await db.rpc("create_customer_booking", params(600))).error?.code).toBe("23P01");
    expect(await email(held.booking_id)).toEqual([]);
    expect(await readOnlineCheckout({ attemptId: checkout.attemptId, token: checkout.token }, db)).toMatchObject({ status: "pending_payment" });
    await invisible(held.booking_id);
    expect((await db.from("bookings").update({ status: "cancelled" }).eq("id", held.booking_id)).error?.code).toBe("23514");
    await expect(readOnlineCheckout({ attemptId: checkout.attemptId, token: "a".repeat(64) }, db)).rejects.toThrow();
    expect((await POST(new Request("http://localhost", { method: "POST", body: "{}", headers: { "stripe-signature": "invalid" } }))).status).toBe(400);
    expect(await email(held.booking_id)).toEqual([]);
    const eventId = `evt_${randomUUID()}`;
    expect((await Promise.all([POST(webhook(checkout.attemptId, "payment_intent.succeeded", eventId)),
      POST(webhook(checkout.attemptId, "payment_intent.succeeded", eventId))])).map(r => r.status)).toEqual([200,200]);
    // A second distinct success event is also harmless.
    expect((await POST(webhook(checkout.attemptId, "payment_intent.succeeded"))).status).toBe(200);
    expect(await readOnlineCheckout({ attemptId: checkout.attemptId, token: checkout.token }, db)).toMatchObject({ status: "confirmed", cancellationPolicy: { noticeMinutes: 1440 } });
    expect((await db.from("bookings").select("reservation_id,status").eq("id", held.booking_id).single()).data)
      .toEqual({ reservation_id: held.reservation_id, status: "confirmed" });
    expect((await db.from("court_reservations").select("status,hold_expires_at").eq("id", held.reservation_id).single()).data)
      .toEqual({ status: "active", hold_expires_at: null });
    expect(await email(held.booking_id)).toEqual([{ event_kind: "confirmed" }]);
    expect((await activity("upcoming")).map((r: { id: string }) => r.id)).toEqual([held.booking_id]);
    expect((await activity("history", "2099-10-16T00:00:00Z")).map((r: { id: string }) => r.id)).toEqual([held.booking_id]);
    expect((await member.rpc("cancel_own_customer_booking", { p_id: held.booking_id })).data).toBe("cancelled");
    expect(await activity("upcoming")).toEqual([]);
    expect(await activity("history")).toMatchObject([{ id: held.booking_id, status: "cancelled" }]);
    expect(await email(held.booking_id)).toEqual([{ event_kind: "confirmed" }, { event_kind: "customer_cancelled" }]);
    const failed = await hold(660), failureCheckout = await begin(failed.payment_attempt_id);
    expect((await POST(webhook(failureCheckout.attemptId, "payment_intent.payment_failed"))).status).toBe(200);
    expect(await readOnlineCheckout({ attemptId: failureCheckout.attemptId, token: failureCheckout.token }, db)).toMatchObject({ status: "pending_payment" });
    expect((await db.from("court_reservations").select("status,hold_expires_at").eq("id", failed.reservation_id).single()).data)
      .toEqual({ status: "held", hold_expires_at: failed.hold_expires_at });
    expect((await db.from("payment_attempts").select("status,provider_payment_id").eq("id", failed.payment_attempt_id).single()).data)
      .toEqual({ status: "pending", provider_payment_id: `pi_${failed.payment_attempt_id}` });
    await invisible(failed.booking_id);
    expect((await db.rpc("create_customer_booking", params(660))).error?.code).toBe("23P01");
    // A different card succeeds on the original pending attempt and reservation.
    expect((await POST(webhook(failureCheckout.attemptId, "payment_intent.succeeded"))).status).toBe(200);
    expect(await readOnlineCheckout({ attemptId: failureCheckout.attemptId, token: failureCheckout.token }, db)).toMatchObject({ status: "confirmed" });
    expect(await email(failed.booking_id)).toEqual([{ event_kind: "confirmed" }]);
    // A delayed decline must not downgrade success.
    expect((await POST(webhook(failureCheckout.attemptId, "payment_intent.payment_failed"))).status).toBe(200);
    expect(await readOnlineCheckout({ attemptId: failureCheckout.attemptId, token: failureCheckout.token }, db)).toMatchObject({ status: "confirmed" });
    expect(await abandonOnlineCheckout({ attemptId: failureCheckout.attemptId, token: failureCheckout.token }, db)).toEqual({ released: false });
    const cancelled = await hold(780), cancelledCheckout = await begin(cancelled.payment_attempt_id);
    vi.mocked(revalidateCourtActivity).mockClear();
    retrieve.mockResolvedValue({ status: "requires_payment_method" }); cancel.mockResolvedValue({ status: "canceled" });
    await expect(abandonOnlineCheckout({ attemptId: cancelledCheckout.attemptId, token: "b".repeat(64) }, db)).rejects.toThrow();
    expect(cancel).not.toHaveBeenCalled();
    retrieve.mockResolvedValueOnce({ status: "succeeded" });
    expect(await abandonOnlineCheckout({ attemptId: cancelledCheckout.attemptId, token: cancelledCheckout.token }, db)).toEqual({ released: false });
    expect(cancel).not.toHaveBeenCalled();
    expect((await db.from("court_reservations").select("status").eq("id", cancelled.reservation_id).single()).data?.status).toBe("held");
    expect(await abandonOnlineCheckout({ attemptId: cancelledCheckout.attemptId, token: cancelledCheckout.token }, db)).toEqual({ released: true });
    expect(cancel).toHaveBeenCalledWith(`pi_${cancelledCheckout.attemptId}`, { cancellation_reason: "abandoned" },
      { idempotencyKey: `court-payment-abandon-${cancelledCheckout.attemptId}` });
    const cancellationId = `evt_${randomUUID()}`;
    expect((await POST(webhook(cancelledCheckout.attemptId, "payment_intent.canceled", cancellationId))).status).toBe(200);
    expect(revalidateCourtActivity).toHaveBeenCalledWith("create");
    expect((await POST(webhook(cancelledCheckout.attemptId, "payment_intent.canceled", cancellationId))).status).toBe(200);
    expect(await readOnlineCheckout({ attemptId: cancelledCheckout.attemptId, token: cancelledCheckout.token }, db)).toMatchObject({ status: "expired" });
    expect((await db.from("payment_attempts").select("status").eq("id", cancelled.payment_attempt_id).single()).data?.status).toBe("cancelled");
    expect((await db.from("court_reservations").select("status,hold_expires_at").eq("id", cancelled.reservation_id).single()).data)
      .toEqual({ status: "released", hold_expires_at: null });
    await invisible(cancelled.booking_id);
    expect(await email(cancelled.booking_id)).toEqual([]);
    expect((await hold(780)).reservation_id).not.toBe(cancelled.reservation_id);
    expect((await POST(webhook(cancelledCheckout.attemptId, "payment_intent.succeeded"))).status).toBe(200);
    expect(await email(cancelled.booking_id)).toEqual([]);
    expect((await db.from("payment_provider_events").select("reconciliation_required").eq("attempt_id", cancelledCheckout.attemptId)
      .eq("outcome", "succeeded")).data).toEqual([{ reconciliation_required: true }]);
    const expired = await hold(840), expiredCheckout = await begin(expired.payment_attempt_id);
    expect((await db.from("court_reservations").update({ hold_expires_at: "2020-01-01T00:00:00Z" }).eq("id", expired.reservation_id)).error).toBeNull();
    vi.mocked(revalidatePath).mockClear();
    expect(await readOnlineCheckout({ attemptId: expiredCheckout.attemptId, token: expiredCheckout.token }, db)).toMatchObject({ status: "expired" });
    expect(revalidatePath).toHaveBeenCalledWith("/book");
    await invisible(expired.booking_id);
    const replacement = await hold(840);
    expect((await POST(webhook(expiredCheckout.attemptId, "payment_intent.succeeded"))).status).toBe(200);
    expect(await readOnlineCheckout({ attemptId: expiredCheckout.attemptId, token: expiredCheckout.token }, db)).toMatchObject({ status: "expired" });
    expect((await db.from("court_reservations").select("status").eq("id", replacement.reservation_id).single()).data?.status).toBe("held");
    expect(await email(expired.booking_id)).toEqual([]);
    expect((await db.from("payment_provider_events").select("settlement_result,reconciliation_required").eq("attempt_id", expiredCheckout.attemptId)).data)
      .toEqual([{ settlement_result: "expired", reconciliation_required: true }]);
    const mismatch = await hold(720), mismatchCheckout = await begin(mismatch.payment_attempt_id);
    expect((await POST(webhook(mismatchCheckout.attemptId, "payment_intent.succeeded", undefined, 1))).status).toBe(200);
    expect(await email(mismatch.booking_id)).toEqual([]);
    expect((await db.from("payment_provider_events").select("settlement_result,reconciliation_required").eq("attempt_id", mismatchCheckout.attemptId)).data)
      .toEqual([{ settlement_result: "amount_mismatch", reconciliation_required: true }]);
    expect((await db.from("bookings").select("id").in("reservation_id", [held.reservation_id, failed.reservation_id, expired.reservation_id, replacement.reservation_id, mismatch.reservation_id])).data).toHaveLength(5);
  } finally {
    vi.unstubAllEnvs(); create.mockReset(); retrieve.mockReset(); cancel.mockReset();
    await db.from("payment_provider_settings").update({ active_provider: previous }).eq("id", true);
    const reservations = (await db.from("court_reservations").select("id").eq("court_id", courtId)).data?.map(r => r.id) ?? [];
    const bookings = (await db.from("bookings").select("id").in("reservation_id", reservations)).data?.map(b => b.id) ?? [];
    await db.from("booking_email_outbox").delete().in("booking_id", bookings);
    await db.from("bookings").delete().in("id", bookings);
    await db.from("court_reservations").delete().eq("court_id", courtId);
    await db.from("courts").delete().eq("id", courtId); await db.from("locations").delete().eq("id", locationId);
    await cleanupAuthFixtures(db, userIds);
  }
}, 30000);
