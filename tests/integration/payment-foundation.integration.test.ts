import { readBookingContracts } from "./checkout-fixtures";
import { insertOpeningHoursFixture } from "./opening-hours-fixtures";
import { expirePaymentHolds } from "@/lib/payments/hold-expiry";
import { processOnlinePaymentEvent, settleOnlinePayment } from "@/lib/payments/service";
import { cleanupBookingFixtures, insertCheckoutFixture, type CheckoutFixtureInput } from "./checkout-fixtures";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { expect, test, vi } from "vitest";
import { localFixtureClient } from "./auth-fixtures";
import { paymentHoldDurationSeconds } from "@/lib/payments/domain";
import { createCustomerBooking } from "@/lib/bookings/service";
import { getPublicCourtDay } from "@/lib/courts/public-calendar";
import { listPublicLocationsWithCourts } from "@/lib/courts/public";

// Soft checks report a failed cleanup step without hiding test failures or skipping
// independent steps; steps within one call depend on each other and stop at the first error.
const cleanup = (step: string, work: () => Promise<unknown>) =>
  expect.soft(Promise.resolve().then(work).then(() => "done"), step).resolves.toBe("done");

// Real database transactions and public reads; no provider API or webhook.
test("payment lifecycle keeps one reservation, protects overlap and releases expiry", async () => {
  const db = localFixtureClient();
  const previousProvider = (await db.from("payment_provider_settings").select("active_provider").single()).data!.active_provider;
  const guest = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_PUBLISHABLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const locationId = randomUUID(), courtId = randomUUID(), ruleId = randomUUID();
  const date = "2099-10-15";
  const intent = { courtId, date, startMinute: 600, endMinute: 660, customerName: "Payment Guest",
    customerEmail: "payment@example.test", customerPhone: "123", expectedTotalAmountMinor: 5000, expectedCurrency: "RON" };
  const params = (start: number, method: CheckoutFixtureInput["paymentMethod"] = "online"): CheckoutFixtureInput => ({ courtId, bookingDate: date,
    startMinute: start, endMinute: start + 60, accountUserId: null,
    customerName: "Payment Guest", customerEmail: "payment@example.test", customerPhone: "123",
    totalAmountMinor: 5000, currency: "RON", paymentMethod: method,
    provider: method === "online" ? "netopia" : null, holdSeconds: paymentHoldDurationSeconds });
  const booking = async (id: string) => (await readBookingContracts(db, { ids: [id] }))[0];
  const reservation = async (id: string) => (await db.from("court_reservations").select("*").eq("id", id).single()).data!;
  const settle = async (row: { payment_attempt_id: string }, outcome: "succeeded" | "failed" | "cancelled") => {
    if (outcome === "succeeded") {
      expect((await db.from("payment_attempts").update({ provider_payment_id:`provider-${row.payment_attempt_id}` })
        .eq("id",row.payment_attempt_id)).error).toBeNull();
      return processOnlinePaymentEvent({ attemptId: row.payment_attempt_id, provider: "netopia",
        providerPaymentId: `provider-${row.payment_attempt_id}`, providerCaptureId: `capture-${row.payment_attempt_id}`,
        eventId: randomUUID(), outcome, amountMinor: 5000, currency: "RON" });
    }
    return settleOnlinePayment({ attemptId: row.payment_attempt_id, provider: "netopia",
      providerPaymentId: `provider-${row.payment_attempt_id}`, outcome });
  };
  try {
    vi.stubEnv("NETOPIA_API_KEY", "foundation-fixture"); vi.stubEnv("NETOPIA_POS_SIGNATURE", "foundation-pos"); vi.stubEnv("NETOPIA_ENVIRONMENT", "sandbox");
    expect((await db.from("payment_provider_settings").update({ active_provider: "netopia" }).eq("id", true)).error).toBeNull();
    expect((await db.from("locations").insert({ id: locationId, slug: `payment-${locationId}`, name: "Payments",
      timezone: "UTC", currency: "RON", is_public: true })).error).toBeNull();
    expect((await db.from("courts").insert({ id: courtId, location_id: locationId, slug: "court", name: "Court",
      environment: "outdoor", surface: "clay", is_active: true })).error).toBeNull();
    expect((await insertOpeningHoursFixture(db, { location_id: locationId, weekday: 3,
      opens_at_minute: 600, closes_at_minute: 1080 })).error).toBeNull();
    expect((await db.from("pricing_rule_sets").insert({ id: ruleId, location_id: locationId })).error).toBeNull();
    expect((await db.from("location_pricing_rules").insert({ rule_set_id: ruleId, location_id: locationId, court_id: courtId,
      court_state: "outdoor", weekday: 3, starts_at_minute: 600, ends_at_minute: 1080, price_per_hour_minor: 5000 })).error).toBeNull();
    expect(await createCustomerBooking({ ...intent, paymentMethod: "pay_at_club" }, guest)).toMatchObject({ ok: false });
    // Failed atomic insert leaves no orphan occupancy/payment.
    await expect(insertCheckoutFixture({ ...params(600), customerName: " " })).rejects.toMatchObject({ driverError: { code: "23514" } });
    expect((await db.from("court_reservations").select("id").eq("court_id", courtId)).data).toEqual([]);

    // Simultaneous writes: exactly one transaction may own the interval.
    const races = await Promise.allSettled([insertCheckoutFixture(params(600)), insertCheckoutFixture(params(600))]);
    const won = races.filter((r) => r.status === "fulfilled"), lost = races.filter((r) => r.status === "rejected");
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(lost[0].reason).toMatchObject({ driverError: { code: "23P01" } });
    const held = won[0].value;
    expect(await booking(held.booking_id)).toMatchObject({ status: "pending_payment", payment_method: "online" });
    const heldReservation = await reservation(held.reservation_id);
    expect(heldReservation.status).toBe("held");
    expect(Date.parse(heldReservation.hold_expires_at)).toBe(Date.parse(held.hold_expires_at!));
    const attempt = await db.from("payment_attempts").select("*").eq("booking_id", held.booking_id).single();
    expect(attempt.data).toMatchObject({ provider: "netopia", status: "pending", amount_minor: 5000, currency: "RON" });
    expect(Date.parse(attempt.data!.expires_at) - Date.parse(attempt.data!.created_at)).toBeCloseTo(paymentHoldDurationSeconds * 1000, -2);
    expect((await db.from("court_reservations").insert({ court_id: courtId, booking_date: date,
      starts_at_minute: 600, ends_at_minute: 660 })).error?.code).toBe("23P01");
    const location = (await listPublicLocationsWithCourts()).find((l) => l.id === locationId)!;
    const day = () => getPublicCourtDay(location, date, "2026-10-05", new Date());
    expect((await day()).courts[0].cells.slice(0, 2)).toEqual(["booked", "booked"]);
    expect((await guest.from("payment_attempts").select("*")).error).not.toBeNull();
    expect((await settleOnlinePayment({ attemptId: held.payment_attempt_id,
      provider: "stripe", providerPaymentId: "wrong-provider", outcome: "succeeded" }))).toBe("unavailable");
    expect((await db.from("payment_attempts").update({ provider_payment_id:`provider-${held.payment_attempt_id}` })
      .eq("id",held.payment_attempt_id)).error).toBeNull();
    const settlements = await Promise.all([settle(held, "succeeded"), settle(held, "succeeded")]);
    expect(settlements.every((r) => r === "succeeded")).toBe(true);
    expect(await booking(held.booking_id)).toMatchObject({ status: "confirmed", reservation_id: held.reservation_id });
    expect(await reservation(held.reservation_id)).toMatchObject({ status: "active", hold_expires_at: null });

    const failed = await insertCheckoutFixture(params(660));
    expect((await settle(failed, "failed"))).toBe("failed");
    expect(await reservation(failed.reservation_id)).toMatchObject({ status: "released" });
    const expired = await insertCheckoutFixture(params(660));
    // Simulate wall-clock expiry, without a browser timer or long test sleep.
    expect((await db.from("court_reservations").update({ hold_expires_at: "2020-01-01T00:00:00Z" })
      .eq("id", expired.reservation_id)).error).toBeNull();
    expect((await day()).courts[0].cells.slice(2, 4)).toEqual(["available", "available"]);
    // Raw fixture inserts do not run runtime lazy cleanup; expire through TypeScript.
    expect(await expirePaymentHolds({ courtId })).toBe(1);
    await insertCheckoutFixture(params(660));
    expect(await booking(expired.booking_id)).toMatchObject({ status: "expired" });
    expect(await reservation(expired.reservation_id)).toMatchObject({ status: "released", hold_expires_at: null });
    expect((await settle(expired, "succeeded"))).toBe("expired");
    const late = await insertCheckoutFixture(params(720));
    expect((await db.from("court_reservations").update({ hold_expires_at: "2020-01-01T00:00:00Z" }).eq("id", late.reservation_id)).error).toBeNull();
    expect((await settle(late, "succeeded"))).toBe("expired");

    expect((await db.from("locations").update({ allow_pay_at_club: true }).eq("id", locationId)).error).toBeNull();
    const atClub = await createCustomerBooking({ ...intent, paymentMethod: "pay_at_club", startMinute: 720, endMinute: 780 }, guest);
    expect(atClub).toMatchObject({ ok: true, status: "confirmed", holdExpiresAt: null });
    if (!atClub.ok) throw new Error("Expected confirmed at-club booking");
    expect((await db.from("payment_attempts").select("method,provider,status").eq("booking_id", atClub.bookingId)).data)
      .toEqual([{ method: "pay_at_club", provider: null, status: "due" }]);
    const online = await createCustomerBooking({ ...intent, startMinute: 780, endMinute: 840 }, guest);
    // NETOPIA fixture settlement is provider-neutral; no production NETOPIA checkout adapter exists.
    expect(online).toMatchObject({ ok: false, message: "Online payment is unavailable. Choose Pay at club if offered, or try again later." });
  } finally {
    vi.unstubAllEnvs();
    await cleanup("restore the payment provider", async () => {
      expect((await db.from("payment_provider_settings").update({ active_provider: previousProvider }).eq("id", true)).error).toBeNull();
    });
    // Booking evidence is selected by this test's court, so no lookup can turn an error into "nothing to delete".
    await cleanup("delete bookings and club fixtures", async () => {
      await cleanupBookingFixtures({ courtIds: [courtId] });
      expect((await db.from("court_reservations").delete().eq("court_id", courtId)).error).toBeNull();
      expect((await db.from("location_pricing_rules").delete().eq("location_id", locationId)).error).toBeNull();
      expect((await db.from("pricing_rule_sets").delete().eq("id", ruleId)).error).toBeNull();
      expect((await db.from("location_opening_hours").delete().eq("location_id", locationId)).error).toBeNull();
      expect((await db.from("courts").delete().eq("id", courtId)).error).toBeNull();
      expect((await db.from("locations").delete().eq("id", locationId)).error).toBeNull();
    });
  }
}, 30000);
