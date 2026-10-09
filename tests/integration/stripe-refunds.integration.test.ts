import { z } from "zod";
import { settleOnlinePayment } from "@/lib/payments/service";
import { insertCheckoutFixture } from "./checkout-fixtures";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { expect, test, vi } from "vitest";
import { cleanupAuthFixtures, localFixtureClient } from "./auth-fixtures";
import { ensureIntegrationAdminAnchor } from "./admin-anchor";
const { refundPayment } = vi.hoisted(() => ({ refundPayment: vi.fn() }));
vi.mock("@/lib/payments/providers", () => ({ onlinePaymentAdapter: async () => ({ refundPayment }) }));
import { cancelOwnCustomerBooking } from "@/lib/bookings/self-cancellation-service";
import { cancelCustomerBookingAsAdmin } from "@/lib/reservations/service";
import { cancelBookingCommand } from "@/lib/bookings/cancellation-service";
import { processBookingRefund } from "@/lib/payments/refunds";

test("full customer/Admin refunds are atomic, replay-safe and leave failed refunds cancelled; pay at club needs no refund", async () => {
  const db = localFixtureClient();
  const messages: { bookingId: string; recipient: string; text: string; bookingStatus: string; reservationStatus: string }[] = [];
  const realFetch = globalThis.fetch;
  let failDelivery = false;
  vi.stubEnv("BREVO_API_KEY", "mock-brevo-key");
  vi.stubEnv("BOOKING_MAIL_FROM", "bookings@example.test");
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) !== "https://api.brevo.com/v3/smtp/email") return realFetch(input, init);
    const body = z.object({ to: z.array(z.object({ email: z.email() })).length(1), textContent: z.string() })
      .parse(JSON.parse(String(init?.body)));
    const bookingId = z.uuid().parse(body.textContent.match(/Booking reference: (.*)/)?.[1]);
    // A separate connection must see committed state at the moment HTTP delivery begins.
    const booking = await db.from("bookings").select("status,reservation_id").eq("id", bookingId).single();
    const reservation = await db.from("court_reservations").select("status").eq("id", booking.data!.reservation_id).single();
    messages.push({ bookingId, recipient: body.to[0].email, text: body.textContent,
      bookingStatus: booking.data!.status, reservationStatus: reservation.data!.status });
    if (failDelivery) throw new Error("Mock Brevo transport failure");
    return new Response(null, { status: 201 });
  });
  const cancellations = (id: string) => messages.filter(message => message.bookingId === id && message.text.includes("cancelled your booking."));
  const locationId = randomUUID(), courtId = randomUUID(), users: string[] = [];
  const member = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_PUBLISHABLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
  const admin = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_PUBLISHABLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
  const previous = (await db.from("payment_provider_settings").select("active_provider").single()).data!.active_provider;
  const rows = async (table: string, bookingId: string) => {
    const result = await db.from(table).select("*").eq(table === "bookings" ? "id" : "booking_id", bookingId);
    expect(result.error).toBeNull(); return result.data!;
  };
  const cancelled = async (booking: { booking_id: string; reservation_id: string }) => {
    expect((await rows("bookings", booking.booking_id))[0].status).toBe("cancelled");
    expect((await db.from("court_reservations").select("status").eq("id", booking.reservation_id).single()).data?.status).toBe("cancelled");
  };
  async function book(start: number, method = "online") {
    const result = await insertCheckoutFixture(db, { p_court_id: courtId, p_booking_date: "2099-10-15",
      p_starts_at_minute: start, p_ends_at_minute: start + 60, p_account_user_id: users[0],
      p_customer_name: "Refund customer", p_customer_email: "refund@example.test", p_customer_phone: "123",
      p_total_amount_minor: 5000, p_currency: "RON", p_payment_method: method,
      p_provider: method === "online" ? "stripe" : null, p_hold_seconds: 600 });
    expect(result.error).toBeNull(); const booking = result.data[0];
    if (method === "online") expect((await settleOnlinePayment({ attemptId: booking.payment_attempt_id,
      provider: "stripe", providerPaymentId: `original-${booking.payment_attempt_id}`, outcome: "succeeded" }))).toBe("succeeded");
    return booking;
  }
  async function cancel(bookingId: string, asAdmin = false, refund: boolean | null = null) {
    return cancelBookingCommand(bookingId, users[asAdmin ? 1 : 0], asAdmin, refund);
  }
  try {
    await ensureIntegrationAdminAnchor(db);
    for (const [index, client] of [member, admin].entries()) {
      const email = `refund-${randomUUID()}@example.test`, password = "refund-test-password-123";
      const user = await db.auth.admin.createUser({ email, password, email_confirm: true });
      expect(user.error).toBeNull(); users.push(user.data.user!.id);
      if (index === 1) expect((await db.from("user_roles").insert({ user_id: users[1], role_code: "admin" })).error).toBeNull();
      expect((await client.auth.signInWithPassword({ email, password })).error).toBeNull();
    }
    expect((await db.from("payment_provider_settings").update({ active_provider: "stripe" }).eq("id", true)).error).toBeNull();
    expect((await db.from("locations").insert({ id: locationId, name: "Refund test", slug: `refund-${locationId}`,
      timezone: "UTC", currency: "RON", is_public: true, allow_pay_at_club: true })).error).toBeNull();
    expect((await db.from("courts").insert({ id: courtId, location_id: locationId, name: "Court", slug: "court", environment: "outdoor", surface: "clay" })).error).toBeNull();
    const own = await book(600);
    // Changed booking pricing must not change the original captured refund amount.
    expect((await db.from("bookings").update({ total_amount_minor: 7000 }).eq("id", own.booking_id)).error).toBeNull();
    const [first, duplicate] = await Promise.all([cancel(own.booking_id), cancel(own.booking_id)]);
    expect(first).toEqual(duplicate); expect(first.outcome).toBe("cancelled");
    if (!first.refund_id) throw new Error("Expected refund ID");
    await cancelled(own);
    expect(await rows("payment_refunds", own.booking_id)).toMatchObject([{ id: first.refund_id, amount_minor: 5000,
      currency: "RON", status: "pending", payment_attempt_id: own.payment_attempt_id, requested_by_user_id: users[0] }]);
    expect(await rows("payment_refunds", own.booking_id)).toHaveLength(1);
    const replacement = await book(600, "pay_at_club"); // Occupancy really is free.
    refundPayment.mockRejectedValueOnce(new Error("network response lost"));
    expect(await processBookingRefund(first.refund_id)).toBe("pending_retry");
    await cancelled(own);
    expect((await rows("payment_refunds", own.booking_id))[0]).toMatchObject({ status: "pending_retry", last_error: "provider_request_incomplete" });
    refundPayment.mockResolvedValue({ status: "succeeded", providerRefundId: `refund-${first.refund_id}` });
    expect((await cancel(own.booking_id)).refund_id).toBe(first.refund_id);
    expect(await processBookingRefund(first.refund_id)).toBe("succeeded");
    expect(refundPayment).toHaveBeenLastCalledWith({ id: first.refund_id, providerPaymentId: `original-${own.payment_attempt_id}`,
      providerRefundId: null, amountMinor: 5000, currency: "RON" });
    refundPayment.mockClear(); expect(await processBookingRefund(first.refund_id)).toBe("succeeded");
    expect(refundPayment).not.toHaveBeenCalled();
    expect((await db.from("payment_refunds").update({ amount_minor: 0 }).eq("id", first.refund_id)).error?.code).toBe("23514");
    const adminRefund = await book(660);
    expect((await cancel(adminRefund.booking_id, true)).outcome).toBe("refund_choice_required");
    expect(cancellations(adminRefund.booking_id)).toEqual([]);
    expect((await rows("bookings", adminRefund.booking_id))[0].status).toBe("confirmed");
    expect(await rows("payment_refunds", adminRefund.booking_id)).toEqual([]);
    const withRefund = await cancel(adminRefund.booking_id, true, true);
    expect(withRefund.refund_id).toBeTruthy(); await cancelled(adminRefund);
    const noRefund = await book(720);
    expect(await cancel(noRefund.booking_id, true, false)).toEqual({ outcome: "cancelled", refund_id: null });
    await cancelled(noRefund); expect(await rows("payment_refunds", noRefund.booking_id)).toEqual([]);
    expect((await cancel(noRefund.booking_id, true, true)).refund_id).toBeNull();
    expect(await cancel(replacement.booking_id)).toEqual({ outcome: "cancelled", refund_id: null });
    expect(await rows("payment_refunds", replacement.booking_id)).toEqual([]);
    // Application services exercise verified identity, read eligibility and post-commit adapter dispatch.
    refundPayment.mockImplementation(async (request) => ({ status: "succeeded", providerRefundId: `refund-${request.id}` }));
    const adminFlow = await book(780);
    expect(await cancelCustomerBookingAsAdmin({ id: adminFlow.booking_id, refund: true }, admin)).toEqual({ ok: true, refundStatus: "succeeded" });
    await cancelled(adminFlow);
    const adminNoRefundFlow = await book(840);
    refundPayment.mockClear();
    expect(await cancelCustomerBookingAsAdmin({ id: adminNoRefundFlow.booking_id, refund: false }, admin)).toEqual({ ok: true });
    expect(refundPayment).not.toHaveBeenCalled();
    const ownerFlow = await book(900);
    refundPayment.mockRejectedValueOnce(new Error("ambiguous network response"));
    expect(await cancelOwnCustomerBooking(ownerFlow.booking_id, member)).toEqual({ ok: true, refundStatus: "pending_retry" });
    await cancelled(ownerFlow);
    const ownerRefund = (await rows("payment_refunds", ownerFlow.booking_id))[0];
    expect(await cancelOwnCustomerBooking(ownerFlow.booking_id, member)).toEqual({ ok: true, refundStatus: "succeeded" });
    expect(await rows("payment_refunds", ownerFlow.booking_id)).toHaveLength(1);
    expect(refundPayment).toHaveBeenLastCalledWith(expect.objectContaining({ id: ownerRefund.id, amountMinor: 5000 }));
    for (const booking of [own, adminFlow, adminNoRefundFlow, ownerFlow, replacement]) {
      expect(cancellations(booking.booking_id)).toHaveLength(1);
      expect(cancellations(booking.booking_id)[0]).toMatchObject({ recipient: "refund@example.test",
        bookingStatus: "cancelled", reservationStatus: "cancelled" });
    }
    expect(cancellations(own.booking_id)[0].text).toContain("Your full payment refund has been requested.");
    expect(cancellations(adminFlow.booking_id)[0].text).toContain("The club administrator has cancelled");
    expect(cancellations(ownerFlow.booking_id)[0].text).toContain("You have cancelled");
    expect(cancellations(adminNoRefundFlow.booking_id)[0].text).not.toContain("refund has been requested");
    const failedDelivery = await book(960);
    failDelivery = true;
    expect(await cancelOwnCustomerBooking(failedDelivery.booking_id, member)).toEqual({ ok: true, refundStatus: "succeeded" });
    await cancelled(failedDelivery);
    expect((await rows("payment_refunds", failedDelivery.booking_id))[0].status).toBe("succeeded");
    expect(await cancelOwnCustomerBooking(failedDelivery.booking_id, member)).toEqual({ ok: true, refundStatus: "succeeded" });
    expect(cancellations(failedDelivery.booking_id)).toHaveLength(1);
    expect((await member.from("payment_refunds").select("*")).error?.code).toBe("42501");
    expect((await rows("payment_attempts", own.booking_id))[0]).toMatchObject({ status: "succeeded", amount_minor: 5000, provider: "stripe" });
  } finally {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    refundPayment.mockReset();
    await db.from("payment_provider_settings").update({ active_provider: previous }).eq("id", true);
    const ids = (await db.from("court_reservations").select("id").eq("court_id", courtId)).data?.map(r => r.id) ?? [];
    const bookings = (await db.from("bookings").select("id").in("reservation_id", ids)).data?.map(b => b.id) ?? [];
    await db.from("bookings").delete().in("id", bookings);
    await db.from("court_reservations").delete().eq("court_id", courtId);
    await db.from("courts").delete().eq("id", courtId); await db.from("locations").delete().eq("id", locationId);
    await cleanupAuthFixtures(db, users);
  }
}, 30000);
