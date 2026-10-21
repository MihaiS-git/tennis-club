import { insertBookingFixture } from "./checkout-fixtures";
import { cleanupBookingFixtures } from "./checkout-fixtures";
import { insertOpeningHoursFixture } from "./opening-hours-fixtures";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { assert, expect, test } from "vitest";
import { cancelCustomerBookingAsAdmin, cancelDirectReservationAsAdmin, editDirectReservationAsAdmin, getAdminReservationEditDay, getReservationDay } from "@/lib/reservations/service";
import { mondayWeekday } from "@/lib/pricing/resolution";
import { cleanupAuthFixtures, localFixtureClient } from "./auth-fixtures";

test("Admin and Coach share direct, customer and guest details while mutations remain Admin-only", async () => {
  const service = localFixtureClient();
  const locationId = randomUUID(), courtId = randomUUID();
  const directId = randomUUID(), reservationId = randomUUID(), bookingId = randomUUID(), paymentId = randomUUID();
  const guestReservationId = randomUUID(), guestBookingId = randomUUID(), guestPaymentId = randomUUID();
  const userIds: string[] = [];
  const date = "2099-10-15", now = new Date("2099-10-14T12:00:00Z");
  const location = { id: locationId, name: "Operations", timezone: "UTC", courts: [{ id: courtId, name: "Court 1" }] };
  const password = "operational-booking-test-123";
  async function account(role?: "admin" | "coach") {
    const email = `operational-${randomUUID()}@example.test`;
    const created = await service.auth.admin.createUser({ email, password, email_confirm: true });
    assert.strictEqual(created.error, null); assert.ok(created.data.user);
    userIds.push(created.data.user.id);
    if (role) assert.strictEqual((await service.from("user_roles").insert({ user_id: created.data.user.id, role_code: role })).error, null);
    const client = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_PUBLISHABLE_KEY!, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    assert.strictEqual((await client.auth.signInWithPassword({ email, password })).error, null);
    return { id: created.data.user.id, client };
  }
  try {
    assert.strictEqual((await service.from("locations").insert({ id: locationId, name: location.name,
      slug: `operational-${locationId}`, timezone: "UTC", is_public: true })).error, null);
    assert.strictEqual((await service.from("courts").insert({ id: courtId, location_id: locationId,
      name: "Court 1", slug: "court-1", surface: "clay", environment: "outdoor", is_active: true })).error, null);
    assert.strictEqual((await insertOpeningHoursFixture(service, { location_id: locationId,
      weekday: mondayWeekday(date), opens_at_minute: 600, closes_at_minute: 780 })).error, null);
    const admin = await account("admin"), coach = await account("coach"), member = await account();
    assert.strictEqual((await service.from("users").update({ first_name: "Mihai", last_name: "Stan" }).eq("id", coach.id)).error, null);
    assert.strictEqual((await service.from("court_reservations").insert([
      { id: directId, court_id: courtId, booking_date: date, starts_at_minute: 600,
        ends_at_minute: 660, reason: "Training", created_by_user_id: coach.id },
      { id: reservationId, court_id: courtId, booking_date: date, starts_at_minute: 660,
        ends_at_minute: 750 },
    ])).error, null);
    assert.strictEqual((await insertBookingFixture(service, { id: bookingId, reservation_id: reservationId,
      account_user_id: member.id, payment_method: "pay_at_club", customer_name: "Ana Pop", customer_email: "ana@example.test",
      customer_phone: "+40 123", cancellation_notice_minutes: 120, total_amount_minor: 7500, currency: "RON" })).error, null);

    assert.strictEqual((await service.from("payment_attempts").insert({ id: paymentId, booking_id: bookingId,
      method: "pay_at_club", status: "due", amount_minor: 7500, currency: "RON" })).error, null);
    const adminDay = await getReservationDay(location, date, now, admin.client);
    expect(adminDay.adminOccupancy).toHaveLength(2);
    expect(adminDay.adminOccupancy).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "reservation", id: directId, creator_name: "Mihai Stan", reason: "Training", payment_method: null }),
      expect.objectContaining({ kind: "booking", id: bookingId, account_user_id: member.id, payment_method: "pay_at_club", stripe_refund_available: false, customer_name: "Ana Pop",
        customer_email: "ana@example.test", customer_phone: "+40 123", cancellation_notice_minutes: 120, total_amount_minor: 7500, currency: "RON", payments: [{ id: paymentId, method: "pay_at_club", provider: null, status: "due" }],
        starts_at_minute: 660, ends_at_minute: 750 }),
    ]));
    assert.strictEqual((await service.from("users").update({ first_name: "Different", last_name: "Profile" }).eq("id", member.id)).error, null);
    expect((await getReservationDay(location, date, now, admin.client)).adminOccupancy.find((row) => row.kind === "booking")).toMatchObject({ customer_name: "Ana Pop" });
    const coachDay = await getReservationDay(location, date, now, coach.client);
    // Coaches keep staff reservations but receive another customer's booking as a bare interval.
    expect(coachDay.adminOccupancy).toEqual([adminDay.adminOccupancy.find((row) => row.kind === "reservation"),
      { kind: "occupied", id: `occupied:${courtId}:660`, court_id: courtId, booking_date: date, starts_at_minute: 660, ends_at_minute: 750 }]);
    for (const leaked of [bookingId, member.id, paymentId, "Ana Pop", "ana@example.test", "+40 123", "pay_at_club", "7500", "RON"])
      expect(JSON.stringify(coachDay)).not.toContain(leaked);
    expect(adminDay.canManage).toBe(true);
    expect(coachDay.canManage).toBe(false);
    await expect(getReservationDay(location, date, now, member.client)).rejects.toThrow();
    const guest = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_PUBLISHABLE_KEY!, { auth: { persistSession: false } });
    await expect(getReservationDay(location, date, now, guest)).rejects.toThrow();
    await expect(cancelDirectReservationAsAdmin(directId, coach.client)).rejects.toThrow();
    await expect(editDirectReservationAsAdmin({}, coach.client)).rejects.toThrow();
    await expect(getAdminReservationEditDay({ reservationId: directId, date }, coach.client, now)).rejects.toThrow();
    await expect(cancelCustomerBookingAsAdmin({ id: bookingId }, coach.client)).rejects.toThrow();
    expect(await cancelCustomerBookingAsAdmin({ id: bookingId }, admin.client)).toMatchObject({ ok: true });
    assert.strictEqual((await service.from("court_reservations").insert({ id: guestReservationId,
      court_id: courtId, booking_date: date, starts_at_minute: 660, ends_at_minute: 750 })).error, null);
    assert.strictEqual((await insertBookingFixture(service, { id: guestBookingId, reservation_id: guestReservationId,
      account_user_id: null, payment_method: "online", customer_name: "Ana Pop", customer_email: "ana@example.test",
      customer_phone: "+40 123", cancellation_notice_minutes: 120, total_amount_minor: 7500, currency: "RON" })).error, null);
    assert.strictEqual((await service.from("payment_attempts").insert({ id: guestPaymentId, booking_id: guestBookingId,
      amount_minor: 7500, currency: "RON", method: "online", provider: "stripe",
      provider_payment_id: `pi_${guestPaymentId}`, status: "succeeded", expires_at: "2099-10-14T12:10:00Z",
      completed_at: "2099-10-14T12:01:00Z" })).error, null);
    const guestAdminDay = await getReservationDay(location, date, now, admin.client);
    const guestCoachDay = await getReservationDay(location, date, now, coach.client);
    expect(guestCoachDay.adminOccupancy.find((row) => row.kind !== "reservation")).toEqual({ kind: "occupied",
      id: `occupied:${courtId}:660`, court_id: courtId, booking_date: date, starts_at_minute: 660, ends_at_minute: 750 });
    for (const leaked of [guestBookingId, guestPaymentId, `pi_${guestPaymentId}`, "Ana Pop", "ana@example.test", "stripe", "succeeded"])
      expect(JSON.stringify(guestCoachDay)).not.toContain(leaked);
    expect(guestAdminDay.adminOccupancy.find((row) => row.kind === "booking")).toMatchObject({
      account_user_id: null, customer_name: "Ana Pop", customer_email: "ana@example.test", customer_phone: "+40 123", payment_method: "online", stripe_refund_available: true,
      payments: [{ id: guestPaymentId, method: "online", provider: "stripe", status: "succeeded" }] });
    expect(coachDay.courts[0].cells).toEqual(["booked", "booked", "booked", "booked", "booked", "available"]);
    expect((await admin.client.from("booking_revisions").select("customer_email")).error?.code).toBe("42501");
    expect((await service.from("bookings").update({ status: "cancelled" }).eq("id", guestBookingId)).error).toBeNull();
    expect((await getReservationDay(location, date, now, admin.client)).adminOccupancy.map((item) => item.id)).toEqual([directId]);
  } finally {
    await cleanupBookingFixtures({ bookingIds: [bookingId, guestBookingId] });
    expect((await service.from("court_reservations").delete().in("id", [directId, reservationId, guestReservationId])).error).toBeNull();
    expect((await service.from("location_opening_hours").delete().eq("location_id", locationId)).error).toBeNull();
    expect((await service.from("courts").delete().eq("id", courtId)).error).toBeNull();
    expect((await service.from("locations").delete().eq("id", locationId)).error).toBeNull();
    await cleanupAuthFixtures(service, userIds);
  }
});
