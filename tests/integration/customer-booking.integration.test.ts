import { insertCheckoutFixture } from "./checkout-fixtures";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { assert, expect, test } from "vitest";
import { createCustomerBooking } from "@/lib/bookings/service";
import { getPublicCourtDay } from "@/lib/courts/public-calendar";
import { listPublicLocationsWithCourts } from "@/lib/courts/public";
import { mondayWeekday } from "@/lib/pricing/resolution";
import { localFixtureClient } from "./auth-fixtures";

test("customer booking persists both rows, snapshots contact and price, and rolls back conflicts", async () => {
  const service = localFixtureClient();
  const reader = () => createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_PUBLISHABLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const guest = reader();
  const locationId = randomUUID(), courtId = randomUUID(), inactiveCourtId = randomUUID(), ruleSetId = randomUUID();
  const date = "2099-10-15", now = new Date("2099-10-14T12:00:00Z");
  const userIds: string[] = [];
  const base = { paymentMethod: "pay_at_club", courtId, date, startMinute: 600, endMinute: 660,
    customerName: "  Booking Guest  ", customerEmail: "  guest@example.test  ", customerPhone: "  +40 123  ",
    expectedTotalAmountMinor: 5000, expectedCurrency: "RON" };
  const rows = async () => {
    const reservations = await service.from("court_reservations").select("*").eq("court_id", courtId);
    assert.strictEqual(reservations.error, null);
    const bookings = await service.from("bookings").select("*").in("reservation_id", reservations.data!.map((row) => row.id));
    assert.strictEqual(bookings.error, null);
    return { bookings: bookings.data!, reservations: reservations.data! };
  };
  const allBookings = async () => {
    const result = await service.from("bookings").select("*").in("reservation_id",
      (await service.from("court_reservations").select("id").eq("court_id", courtId)).data?.map((row) => row.id) ?? []);
    assert.strictEqual(result.error, null); return result.data!;
  };
  try {
    assert.strictEqual((await service.from("locations").insert({ id: locationId, slug: `booking-${locationId}`,
      name: "Booking fixture", timezone: "UTC", currency: "RON", is_public: true, allow_pay_at_club: true, customer_cancellation_notice_minutes: 120 })).error, null);
    assert.strictEqual((await service.from("courts").insert([
      { id: courtId, location_id: locationId, name: "Court", slug: "court", surface: "clay", environment: "outdoor", is_active: true },
      { id: inactiveCourtId, location_id: locationId, name: "Inactive", slug: "inactive", surface: "clay", environment: "outdoor", is_active: false },
    ])).error, null);
    assert.strictEqual((await service.from("location_opening_hours").insert({ location_id: locationId,
      weekday: mondayWeekday(date), opens_at_minute: 600, closes_at_minute: 900 })).error, null);
    assert.strictEqual((await service.from("pricing_rule_sets").insert({ id: ruleSetId, location_id: locationId })).error, null);
    const priceRule = { location_id: locationId, rule_set_id: ruleSetId, court_id: courtId,
      court_state: "outdoor", weekday: mondayWeekday(date), starts_at_minute: 600,
      ends_at_minute: 660, price_per_hour_minor: 5000 };
    assert.strictEqual((await service.from("location_pricing_rules").insert([priceRule,
      { ...priceRule, starts_at_minute: 660, ends_at_minute: 720, price_per_hour_minor: 7000 }])).error, null);

    expect(await createCustomerBooking({ ...base, expectedTotalAmountMinor: 100 }, guest, service, now))
      .toEqual({ ok: false, reason: "price_changed", totalAmountMinor: 5000, currency: "RON" });
    expect(await rows()).toEqual({ bookings: [], reservations: [] });
    assert.strictEqual((await service.from("location_pricing_rules").update({ price_per_hour_minor: 6000 })
      .eq("location_id", locationId).eq("starts_at_minute", 600)).error, null);
    expect(await createCustomerBooking(base, guest, service, now))
      .toEqual({ ok: false, reason: "price_changed", totalAmountMinor: 6000, currency: "RON" });
    expect(await rows()).toEqual({ bookings: [], reservations: [] });
    assert.strictEqual((await service.from("locations").update({ currency: "EUR" }).eq("id", locationId)).error, null);
    expect(await createCustomerBooking({ ...base, expectedTotalAmountMinor: 6000 }, guest, service, now))
      .toEqual({ ok: false, reason: "price_changed", totalAmountMinor: 6000, currency: "EUR" });
    expect(await rows()).toEqual({ bookings: [], reservations: [] });
    const guestResult = await createCustomerBooking({ ...base, expectedTotalAmountMinor: 6000,
      expectedCurrency: "EUR" }, guest, service, now);
    assert.ok(guestResult.ok, JSON.stringify(guestResult));
    expect(guestResult.cancellationPolicy).toEqual({ noticeMinutes: 120, cutoff: null });
    const first = await rows();
    expect(first.bookings).toHaveLength(1); expect(first.reservations).toHaveLength(1);
    expect(first.bookings[0]).toMatchObject({ account_user_id: null, customer_name: "Booking Guest",
      customer_email: "guest@example.test", customer_phone: "+40 123", status: "confirmed",
      cancellation_notice_minutes: 120, total_amount_minor: 6000, currency: "EUR", reservation_id: first.reservations[0].id });
    expect(first.reservations[0]).toMatchObject({ status: "active", reason: null, created_by_user_id: null });
    const publicLocation = (await listPublicLocationsWithCourts(guest)).find((item) => item.id === locationId)!;
    const publicDay = await getPublicCourtDay(publicLocation, date, "2099-10-14", now, guest);
    expect(publicDay.courts.find((item) => item.court.id === courtId)?.cells.slice(0, 2)).toEqual(["booked", "booked"]);
    const overlap = await insertCheckoutFixture(service, {
      p_payment_method: "pay_at_club", p_provider: null, p_hold_seconds: 600,
      p_court_id: courtId, p_booking_date: date, p_starts_at_minute: 600, p_ends_at_minute: 660,
      p_account_user_id: null, p_customer_name: "Race", p_customer_email: "race@example.test",
      p_customer_phone: "123", p_total_amount_minor: 6000, p_currency: "EUR",
    });
    expect(overlap.error?.code).toBe("23P01");
    expect((await rows()).bookings).toHaveLength(1);

    assert.strictEqual((await service.from("locations").update({ customer_cancellation_notice_minutes: 1440 })
      .eq("id", locationId)).error, null);
    expect((await allBookings())[0]).toEqual(first.bookings[0]);

    const email = `booking-${randomUUID()}@example.test`, password = "booking-test-password-123";
    const created = await service.auth.admin.createUser({ email, password, email_confirm: true });
    assert.strictEqual(created.error, null); assert.ok(created.data.user);
    const memberId = created.data.user.id;
    userIds.push(memberId);
    const member = reader();
    assert.strictEqual((await member.auth.signInWithPassword({ email, password })).error, null);
    const profileBefore = await service.from("users").select("email, first_name, last_name, phone").eq("id", memberId).single();
    expect(await createCustomerBooking({ ...base, startMinute: 660, endMinute: 720,
      customerName: "Different Customer", customerEmail: "different@example.test",
      expectedTotalAmountMinor: 7000, expectedCurrency: "EUR" }, member, service, now)).toMatchObject({ ok: true, cancellationPolicy: { noticeMinutes: 1440, cutoff: "2099-10-14T11:00:00.000Z" } });
    const booked = await allBookings();
    expect(booked).toHaveLength(2);
    expect(booked.find((row) => row.account_user_id === memberId)).toMatchObject({
      customer_name: "Different Customer", customer_email: "different@example.test", cancellation_notice_minutes: 1440, total_amount_minor: 7000, currency: "EUR" });
    expect((await service.from("users").select("email, first_name, last_name, phone").eq("id", memberId).single()).data)
      .toEqual(profileBefore.data);

    expect(booked.find((row) => row.account_user_id === null)?.cancellation_notice_minutes).toBe(120);
    for (const policyField of ["cancellation_notice_minutes", "customer_cancellation_notice_minutes", "cancellationNoticeMinutes"]) {
      expect(await createCustomerBooking({ ...base, [policyField]: 0 }, guest, service, now)).toMatchObject({ ok: false });
    }

    const count = async () => ({ bookings: (await allBookings()).length,
      reservations: (await service.from("court_reservations").select("id").eq("court_id", courtId)).data?.length });
    const before = await count();
    expect(await createCustomerBooking(base, guest, service, now)).toMatchObject({ ok: false });
    expect(await count()).toEqual(before);
    for (const intent of [
      { ...base, startMinute: 750, endMinute: 810 },
      { ...base, startMinute: 540, endMinute: 600 },
      { ...base, date: "2099-10-13" },
      { ...base, startMinute: 615 },
      { ...base, endMinute: 630 },
      { ...base, courtId: inactiveCourtId },
    ]) expect(await createCustomerBooking(intent, guest, service, now)).toMatchObject({ ok: false });
    expect(await count()).toEqual(before);
    assert.strictEqual((await service.from("users").update({ status: "suspended" }).eq("id", memberId)).error, null);
    expect(await createCustomerBooking({ ...base, startMinute: 720, endMinute: 780 }, member, service, now))
      .toMatchObject({ ok: false });
    expect(await count()).toEqual(before);
    assert.strictEqual((await service.from("locations").update({ is_public: false }).eq("id", locationId)).error, null);
    expect(await createCustomerBooking({ ...base, startMinute: 720, endMinute: 780 }, guest, service, now))
      .toMatchObject({ ok: false });
    expect(await count()).toEqual(before);
    assert.strictEqual((await service.from("locations").update({ is_public: true }).eq("id", locationId)).error, null);
    const orphanBefore = await count();
    const invalidWrite = await insertCheckoutFixture(service, {
      p_payment_method: "pay_at_club", p_provider: null, p_hold_seconds: 600,
      p_court_id: courtId, p_booking_date: date, p_starts_at_minute: 720, p_ends_at_minute: 780,
      p_account_user_id: null, p_customer_name: " ", p_customer_email: "invalid@example.test",
      p_customer_phone: "123", p_total_amount_minor: 5000, p_currency: "EUR",
    });
    expect(invalidWrite.error?.code).toBe("23514");
    expect(await count()).toEqual(orphanBefore);
    assert.strictEqual((await service.from("location_pricing_rules").delete().eq("location_id", locationId)).error, null);
    expect(await createCustomerBooking({ ...base, startMinute: 720, endMinute: 780 }, guest, service, now))
      .toMatchObject({ ok: false });
    expect(await count()).toEqual(orphanBefore);
    expect((await allBookings()).map((row) => row.total_amount_minor).sort()).toEqual([6000, 7000]);
  } finally {
    const reservationIds = (await service.from("court_reservations").select("id").in("court_id", [courtId, inactiveCourtId])).data?.map((row) => row.id) ?? [];
    if (reservationIds.length) assert.strictEqual((await service.from("bookings").delete().in("reservation_id", reservationIds)).error, null);
    assert.strictEqual((await service.from("court_reservations").delete().in("court_id", [courtId, inactiveCourtId])).error, null);
    assert.strictEqual((await service.from("location_pricing_rules").delete().eq("location_id", locationId)).error, null);
    assert.strictEqual((await service.from("pricing_rule_sets").delete().eq("location_id", locationId)).error, null);
    assert.strictEqual((await service.from("location_opening_hours").delete().eq("location_id", locationId)).error, null);
    assert.strictEqual((await service.from("courts").delete().eq("location_id", locationId)).error, null);
    assert.strictEqual((await service.from("locations").delete().eq("id", locationId)).error, null);
    for (const id of userIds) {
      assert.strictEqual((await service.from("users").delete().eq("id", id)).error, null);
      assert.strictEqual((await service.auth.admin.deleteUser(id)).error, null);
    }
  }
});
