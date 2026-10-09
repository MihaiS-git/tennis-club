import type { BookingEmailEvent } from "@/lib/notifications/booking-email";
const sent = vi.hoisted(() => vi.fn());
vi.mock("@/lib/notifications/booking-email", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/notifications/booking-email")>(), sendBookingNotification: sent,
}));
const notifications = (id: string): BookingEmailEvent[] => sent.mock.calls.map(([event]) => event).filter(event => event.payload.booking_id === id);
import { expirePaymentHolds } from "@/lib/payments/hold-expiry";
import { settleOnlinePayment } from "@/lib/payments/service";
import { insertCheckoutFixture } from "./checkout-fixtures";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { expect, test, vi } from "vitest";
import { localFixtureClient } from "./auth-fixtures";
import { paymentHoldDurationSeconds } from "@/lib/payments/domain";
import { createCustomerBooking } from "@/lib/bookings/service";
import { getPublicCourtDay } from "@/lib/courts/public-calendar";
import { listPublicLocationsWithCourts } from "@/lib/courts/public";

// Real database transactions and public reads; no provider API or webhook.
test("payment lifecycle keeps one reservation, protects overlap, releases expiry, and confirms email only on confirmation", async () => {
  const db = localFixtureClient();
  const previousProvider = (await db.from("payment_provider_settings").select("active_provider").single()).data!.active_provider;
  const guest = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_PUBLISHABLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const locationId = randomUUID(), courtId = randomUUID(), ruleId = randomUUID();
  const date = "2099-10-15";
  const intent = { courtId, date, startMinute: 600, endMinute: 660, customerName: "Payment Guest",
    customerEmail: "payment@example.test", customerPhone: "123", expectedTotalAmountMinor: 5000, expectedCurrency: "RON" };
  const params = (start: number, method = "online") => ({ p_court_id: courtId, p_booking_date: date,
    p_starts_at_minute: start, p_ends_at_minute: start + 60, p_account_user_id: null,
    p_customer_name: "Payment Guest", p_customer_email: "payment@example.test", p_customer_phone: "123",
    p_total_amount_minor: 5000, p_currency: "RON", p_payment_method: method,
    p_provider: method === "online" ? "netopia" : null, p_hold_seconds: paymentHoldDurationSeconds });
  const emails = async (id: string) => {
    return notifications(id).map(({ event_kind }) => ({ event_kind }));
  };
  const booking = async (id: string) => (await db.from("bookings").select("*").eq("id", id).single()).data!;
  const reservation = async (id: string) => (await db.from("court_reservations").select("*").eq("id", id).single()).data!;
  const settle = (row: { payment_attempt_id: string }, outcome: "succeeded" | "failed" | "cancelled") => settleOnlinePayment({
    attemptId: row.payment_attempt_id, provider: "netopia", providerPaymentId: `provider-${row.payment_attempt_id}`, outcome: outcome,
  });
  try {
    vi.stubEnv("NETOPIA_API_KEY", "foundation-fixture"); vi.stubEnv("NETOPIA_POS_SIGNATURE", "foundation-pos"); vi.stubEnv("NETOPIA_ENVIRONMENT", "sandbox");
    expect((await db.from("payment_provider_settings").update({ active_provider: "netopia" }).eq("id", true)).error).toBeNull();
    expect((await db.from("locations").insert({ id: locationId, slug: `payment-${locationId}`, name: "Payments",
      timezone: "UTC", currency: "RON", is_public: true })).error).toBeNull();
    expect((await db.from("courts").insert({ id: courtId, location_id: locationId, slug: "court", name: "Court",
      environment: "outdoor", surface: "clay", is_active: true })).error).toBeNull();
    expect((await db.from("location_opening_hours").insert({ location_id: locationId, weekday: 3,
      opens_at_minute: 600, closes_at_minute: 1080 })).error).toBeNull();
    expect((await db.from("pricing_rule_sets").insert({ id: ruleId, location_id: locationId })).error).toBeNull();
    expect((await db.from("location_pricing_rules").insert({ rule_set_id: ruleId, location_id: locationId, court_id: courtId,
      court_state: "outdoor", weekday: 3, starts_at_minute: 600, ends_at_minute: 1080, price_per_hour_minor: 5000 })).error).toBeNull();
    expect(await createCustomerBooking({ ...intent, paymentMethod: "pay_at_club" }, guest)).toMatchObject({ ok: false });
    // Failed atomic insert leaves no orphan occupancy/payment.
    expect((await insertCheckoutFixture(db, { ...params(600), p_customer_name: " " })).error?.code).toBe("23514");
    expect((await db.from("court_reservations").select("id").eq("court_id", courtId)).data).toEqual([]);

    // Simultaneous writes: exactly one transaction may own the interval.
    const races = await Promise.all([insertCheckoutFixture(db, params(600)), insertCheckoutFixture(db, params(600))]);
    expect(races.filter((r) => !r.error)).toHaveLength(1);
    expect(races.find((r) => r.error)?.error?.code).toBe("23P01");
    const held = races.find((r) => !r.error)!.data[0];
    expect(await booking(held.booking_id)).toMatchObject({ status: "pending_payment", payment_method: "online" });
    const heldReservation = await reservation(held.reservation_id);
    expect(heldReservation.status).toBe("held");
    expect(Date.parse(heldReservation.hold_expires_at)).toBe(Date.parse(held.hold_expires_at!));
    const attempt = await db.from("payment_attempts").select("*").eq("booking_id", held.booking_id).single();
    expect(attempt.data).toMatchObject({ provider: "netopia", status: "pending", amount_minor: 5000, currency: "RON" });
    expect(Date.parse(attempt.data!.expires_at) - Date.parse(attempt.data!.created_at)).toBeCloseTo(paymentHoldDurationSeconds * 1000, -2);
    expect(await emails(held.booking_id)).toEqual([]);
    expect((await db.from("court_reservations").insert({ court_id: courtId, booking_date: date,
      starts_at_minute: 600, ends_at_minute: 660 })).error?.code).toBe("23P01");
    const location = (await listPublicLocationsWithCourts(guest)).find((l) => l.id === locationId)!;
    const day = () => getPublicCourtDay(location, date, "2026-10-05", new Date(), guest);
    expect((await day()).courts[0].cells.slice(0, 2)).toEqual(["booked", "booked"]);
    expect((await guest.from("payment_attempts").select("*")).error).not.toBeNull();
    expect((await settleOnlinePayment({ attemptId: held.payment_attempt_id,
      provider: "stripe", providerPaymentId: "wrong-provider", outcome: "succeeded" }))).toBe("unavailable");
    const settlements = await Promise.all([settle(held, "succeeded"), settle(held, "succeeded")]);
    expect(settlements.every((r) => r === "succeeded")).toBe(true);
    expect(await booking(held.booking_id)).toMatchObject({ status: "confirmed", reservation_id: held.reservation_id });
    expect(await reservation(held.reservation_id)).toMatchObject({ status: "active", hold_expires_at: null });
    expect(await emails(held.booking_id)).toEqual([{ event_kind: "confirmed" }]);

    const failed = (await insertCheckoutFixture(db, params(660))).data[0];
    expect((await settle(failed, "failed"))).toBe("failed");
    expect(await reservation(failed.reservation_id)).toMatchObject({ status: "released" });
    expect(await emails(failed.booking_id)).toEqual([]);
    const expired = (await insertCheckoutFixture(db, params(660))).data[0];
    // Simulate wall-clock expiry, without a browser timer or long test sleep.
    expect((await db.from("court_reservations").update({ hold_expires_at: "2020-01-01T00:00:00Z" })
      .eq("id", expired.reservation_id)).error).toBeNull();
    expect((await day()).courts[0].cells.slice(2, 4)).toEqual(["available", "available"]);
    // Raw fixture inserts do not run runtime lazy cleanup; expire through TypeScript.
    expect(await expirePaymentHolds({ courtId })).toBe(1);
    const replacement = await insertCheckoutFixture(db, params(660));
    expect(replacement.error).toBeNull();
    expect(await booking(expired.booking_id)).toMatchObject({ status: "expired" });
    expect(await reservation(expired.reservation_id)).toMatchObject({ status: "released", hold_expires_at: null });
    expect((await settle(expired, "succeeded"))).toBe("expired");
    expect(await emails(expired.booking_id)).toEqual([]);
    const late = (await insertCheckoutFixture(db, params(720))).data[0];
    expect((await db.from("court_reservations").update({ hold_expires_at: "2020-01-01T00:00:00Z" }).eq("id", late.reservation_id)).error).toBeNull();
    expect((await settle(late, "succeeded"))).toBe("expired");
    expect(await emails(late.booking_id)).toEqual([]);

    expect((await db.from("locations").update({ allow_pay_at_club: true }).eq("id", locationId)).error).toBeNull();
    const atClub = await createCustomerBooking({ ...intent, paymentMethod: "pay_at_club", startMinute: 720, endMinute: 780 }, guest);
    expect(atClub).toMatchObject({ ok: true, status: "confirmed", holdExpiresAt: null });
    if (!atClub.ok) throw new Error("Expected confirmed at-club booking");
    expect(await emails(atClub.bookingId)).toEqual([{ event_kind: "confirmed" }]);
    expect((await db.from("payment_attempts").select("method,provider,status").eq("booking_id", atClub.bookingId)).data)
      .toEqual([{ method: "pay_at_club", provider: null, status: "due" }]);
    const online = await createCustomerBooking({ ...intent, startMinute: 780, endMinute: 840 }, guest);
    // NETOPIA fixture settlement is provider-neutral; no production NETOPIA checkout adapter exists.
    expect(online).toMatchObject({ ok: false, message: "Online payment is unavailable. Choose Pay at club if offered, or try again later." });
  } finally {
    vi.unstubAllEnvs();
    await db.from("payment_provider_settings").update({ active_provider: previousProvider }).eq("id", true);
    const ids = (await db.from("court_reservations").select("id").eq("court_id", courtId)).data?.map((r) => r.id) ?? [];
    const bookings = (await db.from("bookings").select("id").in("reservation_id", ids)).data?.map((b) => b.id) ?? [];
    await db.from("bookings").delete().in("id", bookings);
    await db.from("court_reservations").delete().eq("court_id", courtId);
    await db.from("location_pricing_rules").delete().eq("location_id", locationId);
    await db.from("pricing_rule_sets").delete().eq("id", ruleId);
    await db.from("location_opening_hours").delete().eq("location_id", locationId);
    await db.from("courts").delete().eq("id", courtId);
    await db.from("locations").delete().eq("id", locationId);
  }
}, 30000);
