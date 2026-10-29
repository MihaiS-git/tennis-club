import { appendBookingContractFixture } from "./checkout-fixtures";
import { configureCheckoutPolicyFixture } from "./opening-hours-fixtures";
import { processOnlinePaymentEvent } from "@/lib/payments/service";
import { cleanupBookingFixtures, insertCheckoutFixture, type CheckoutFixtureInput } from "./checkout-fixtures";
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

test("customer/Admin refunds preserve occupancy until verified, complete on a later refund check, and remain replay-safe", async () => {
  const db = localFixtureClient();
  const locationId = randomUUID(), courtId = randomUUID(), users: string[] = [];
  const member = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_PUBLISHABLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
  const admin = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_PUBLISHABLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
  const previous = (await db.from("payment_provider_settings").select("active_provider").single()).data!.active_provider;
  const rows = async (table: string, bookingId: string) => {
    const result = await db.from(table).select("*").eq(table === "checkout_records" ? "id" : "booking_id", bookingId);
    expect(result.error).toBeNull(); return result.data!;
  };
  const cancelled = async (booking: { booking_id: string; reservation_id: string }) => {
    expect((await rows("checkout_records", booking.booking_id))[0].status).toBe("cancelled");
    expect((await db.from("court_reservations").select("status").eq("id", booking.reservation_id).single()).data?.status).toBe("cancelled");
  };
  async function book(start: number, method: CheckoutFixtureInput["paymentMethod"] = "online") {
    const booking = await insertCheckoutFixture({ courtId, bookingDate: "2099-10-15",
      startMinute: start, endMinute: start + 60, accountUserId: users[0],
      customerName: "Refund customer", customerEmail: "refund@example.test", customerPhone: "123",
      totalAmountMinor: 5000, currency: "RON", paymentMethod: method,
      provider: method === "online" ? "stripe" : null, holdSeconds: 600 });
    if (method === "online") {
      const providerPaymentId=`original-${booking.payment_attempt_id}`;
      expect((await db.from("payment_attempts").update({provider_payment_id:providerPaymentId})
        .eq("id",booking.payment_attempt_id)).error).toBeNull();
      expect(await processOnlinePaymentEvent({ attemptId: booking.payment_attempt_id, provider: "stripe",
        providerPaymentId, providerCaptureId:providerPaymentId, eventId:`capture-${randomUUID()}`,
        outcome: "succeeded", amountMinor:5000, currency:"RON" })).toBe("succeeded");
    }
    return booking;
  }
  async function cancel(bookingId: string, asAdmin = false) {
    return cancelBookingCommand(bookingId, users[asAdmin ? 1 : 0], asAdmin);
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
    await configureCheckoutPolicyFixture(db,locationId,courtId);
    const own = await book(600);
    // Changed booking pricing must not change the original captured refund amount.
    await appendBookingContractFixture(own.booking_id, { total_amount_minor: 7000 });
    const [first, duplicate] = await Promise.all([cancel(own.booking_id), cancel(own.booking_id)]);
    expect(first).toEqual(duplicate); expect(first.outcome).toBe("cancellation_pending");
    if (first.outcome !== "cancellation_pending" || !first.refundIds[0]) throw new Error("Expected refund ID");
    expect((await rows("checkout_records",own.booking_id))[0].status).toBe("confirmed");
    expect(await rows("payment_refunds", own.booking_id)).toMatchObject([{ id: first.refundIds[0], amount_minor: 5000, captured_amount_minor: 5000,
      currency: "RON", status: "pending", payment_attempt_id: own.payment_attempt_id, requested_by_user_id: users[0] }]);
    expect(await rows("payment_refunds", own.booking_id)).toHaveLength(1);
    refundPayment.mockRejectedValueOnce(new Error("network response lost"));
    expect(await processBookingRefund(first.refundIds[0])).toBe("pending_retry");
    expect((await rows("checkout_records",own.booking_id))[0].status).toBe("confirmed");
    expect((await rows("payment_refunds", own.booking_id))[0]).toMatchObject({ status: "pending_retry" });
    refundPayment.mockResolvedValue({ status: "succeeded", providerRefundId: `refund-${first.refundIds[0]}` });
    expect(await cancel(own.booking_id)).toEqual(first);
    expect(await processBookingRefund(first.refundIds[0])).toBe("succeeded");
    await cancelled(own);
    const replacement=await book(600,"pay_at_club"); // Occupancy is free only after verified completion.
    expect(refundPayment).toHaveBeenLastCalledWith(expect.objectContaining({ id: first.refundIds[0], operation:"replay", executionId:expect.any(String),idempotencyKey:expect.any(String), providerPaymentId: `original-${own.payment_attempt_id}`,
      providerRefundId: null, amountMinor: 5000, currency: "RON" }));
    refundPayment.mockClear(); expect(await processBookingRefund(first.refundIds[0])).toBe("succeeded");
    expect(refundPayment).not.toHaveBeenCalled();
    refundPayment.mockImplementation(async request => ({status:"succeeded",providerRefundId:`refund-${request.id}`}));
    expect((await db.from("payment_refunds").update({ amount_minor: 0 }).eq("id", first.refundIds[0])).error?.code).toBe("23514");
    const adminRefund = await book(660);
    const withRefund = await cancel(adminRefund.booking_id, true);
    expect(withRefund).toMatchObject({ outcome: "cancellation_pending", refundIds: [expect.any(String)] });
    expect((await rows("checkout_records",adminRefund.booking_id))[0].status).toBe("confirmed");
    expect(await cancel(adminRefund.booking_id, true)).toEqual(withRefund);
    if(withRefund.outcome!=="cancellation_pending") throw new Error("Missing refund");
    expect(await processBookingRefund(withRefund.refundIds[0])).toBe("succeeded");
    await cancelled(adminRefund);
    const nextAdminBooking = await book(720);
    const automaticRefund = await cancel(nextAdminBooking.booking_id, true);
    expect(automaticRefund).toMatchObject({ outcome: "cancellation_pending", refundIds: [expect.any(String)] });
    if(automaticRefund.outcome!=="cancellation_pending") throw new Error("Missing refund");
    expect(await processBookingRefund(automaticRefund.refundIds[0])).toBe("succeeded");
    await cancelled(nextAdminBooking); expect(await rows("payment_refunds", nextAdminBooking.booking_id)).toHaveLength(1);
    expect(await cancel(replacement.booking_id)).toEqual({ outcome: "cancelled", refundIds: [] });
    expect(await rows("payment_refunds", replacement.booking_id)).toEqual([]);
    // Application services exercise verified identity, read eligibility and post-commit adapter dispatch.
    refundPayment.mockImplementation(async (request) => ({ status: "succeeded", providerRefundId: `refund-${request.id}` }));
    const adminFlow = await book(780);
    expect(await cancelCustomerBookingAsAdmin({ id: adminFlow.booking_id }, admin)).toEqual({ ok: true, outcome: "cancelled", refundStatus: "succeeded" });
    await cancelled(adminFlow);
    const secondAdminFlow = await book(840);
    refundPayment.mockClear();
    expect(await cancelCustomerBookingAsAdmin({ id: secondAdminFlow.booking_id }, admin)).toEqual({ ok: true, outcome: "cancelled", refundStatus:"succeeded" });
    expect(refundPayment).toHaveBeenCalledOnce();
    // Staff-owned bookings use the owner cancellation/refund workflow unchanged.
    expect((await db.from("user_roles").insert({ user_id: users[0], role_code: "coach" })).error).toBeNull();
    const ownerFlow = await book(900);
    refundPayment.mockRejectedValueOnce(new Error("ambiguous network response"));
    expect(await cancelOwnCustomerBooking(ownerFlow.booking_id, member)).toEqual({ ok: true, outcome: "cancellation_pending" });
    expect((await rows("checkout_records",ownerFlow.booking_id))[0].status).toBe("confirmed");
    const ownerRefund = (await rows("payment_refunds", ownerFlow.booking_id))[0];
    // The Stripe refund webhook for this refund replays the unconfirmed request.
    expect(await processBookingRefund(ownerRefund.id, { strict: true })).toBe("succeeded");
    await cancelled(ownerFlow);
    expect(await cancelOwnCustomerBooking(ownerFlow.booking_id, member)).toEqual({ ok: true, outcome: "cancelled", refundStatus: "succeeded" });
    expect(await rows("payment_refunds", ownerFlow.booking_id)).toHaveLength(1);
    expect(refundPayment).toHaveBeenLastCalledWith(expect.objectContaining({ id: ownerRefund.id, amountMinor: 5000 }));
    for (const booking of [own, adminFlow, secondAdminFlow, ownerFlow, replacement]) await cancelled(booking);
    expect((await db.from("user_roles").delete().eq("user_id", users[0]).eq("role_code", "coach")).error).toBeNull();
    const replayed = await book(960);
    expect(await cancelOwnCustomerBooking(replayed.booking_id, member)).toEqual({ ok: true, outcome: "cancelled", refundStatus: "succeeded" });
    await cancelled(replayed);
    expect((await rows("payment_refunds", replayed.booking_id))[0].status).toBe("succeeded");
    expect(await cancelOwnCustomerBooking(replayed.booking_id, member)).toEqual({ ok: true, outcome: "cancelled", refundStatus: "succeeded" });
    expect(await rows("payment_refunds", replayed.booking_id)).toMatchObject([{ status: "succeeded", amount_minor: 5000 }]);
    expect((await member.from("payment_refunds").select("*")).error?.code).toBe("42501");
    expect((await rows("payment_attempts", own.booking_id))[0]).toMatchObject({ status: "succeeded", amount_minor: 5000, provider: "stripe" });
  } finally {
    refundPayment.mockReset();
    expect((await db.from("payment_provider_settings").update({ active_provider: previous }).eq("id", true)).error).toBeNull();
    const ids = (await db.from("court_reservations").select("id").eq("court_id", courtId)).data?.map(r => r.id) ?? [];
    const bookings = (await db.from("checkout_records").select("id").in("reservation_id", ids)).data?.map(b => b.id) ?? [];
    await cleanupBookingFixtures({ bookingIds: bookings });
    expect((await db.from("court_reservations").delete().eq("court_id", courtId)).error).toBeNull();
    expect((await db.from("pricing_rule_sets").delete().eq("location_id",locationId)).error).toBeNull();
    expect((await db.from("location_opening_hours").delete().eq("location_id",locationId)).error).toBeNull();
    expect((await db.from("courts").delete().eq("id", courtId)).error).toBeNull();
    expect((await db.from("locations").delete().eq("id", locationId)).error).toBeNull();
    await cleanupAuthFixtures(db, users);
  }
}, 30000);
