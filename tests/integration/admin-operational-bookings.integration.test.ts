import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { assert, expect, test } from "vitest";
import { getReservationDay } from "@/lib/reservations/service";
import { mondayWeekday } from "@/lib/pricing/resolution";
import { cleanupAuthFixtures, localFixtureClient } from "./auth-fixtures";

test("Admin sees booking snapshots beside direct reservations while Coach receives occupancy only", async () => {
  const service = localFixtureClient();
  const locationId = randomUUID(), courtId = randomUUID();
  const directId = randomUUID(), reservationId = randomUUID(), bookingId = randomUUID();
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
    assert.strictEqual((await service.from("location_opening_hours").insert({ location_id: locationId,
      weekday: mondayWeekday(date), opens_at_minute: 600, closes_at_minute: 780 })).error, null);
    const admin = await account("admin"), coach = await account("coach"), member = await account();
    assert.strictEqual((await service.from("users").update({ first_name: "Mihai", last_name: "Stan" }).eq("id", coach.id)).error, null);
    assert.strictEqual((await service.from("court_reservations").insert([
      { id: directId, court_id: courtId, booking_date: date, starts_at_minute: 600,
        ends_at_minute: 660, reason: "Training", created_by_user_id: coach.id },
      { id: reservationId, court_id: courtId, booking_date: date, starts_at_minute: 660,
        ends_at_minute: 750 },
    ])).error, null);
    assert.strictEqual((await service.from("bookings").insert({ id: bookingId, reservation_id: reservationId,
      account_user_id: member.id, payment_method: "pay_at_club", customer_name: "Ana Pop", customer_email: "ana@example.test",
      customer_phone: "+40 123", cancellation_notice_minutes: 120, total_amount_minor: 7500, currency: "RON" })).error, null);

    const adminDay = await getReservationDay(location, date, now, admin.client);
    expect(adminDay.adminOccupancy).toEqual([
      expect.objectContaining({ kind: "reservation", id: directId, creator_name: "Mihai Stan", reason: "Training" }),
      expect.objectContaining({ kind: "booking", id: bookingId, customer_name: "Ana Pop",
        customer_email: "ana@example.test", customer_phone: "+40 123", cancellation_notice_minutes: 120, total_amount_minor: 7500, currency: "RON",
        starts_at_minute: 660, ends_at_minute: 750 }),
    ]);
    assert.strictEqual((await service.from("users").update({ first_name: "Different", last_name: "Profile" }).eq("id", member.id)).error, null);
    expect((await getReservationDay(location, date, now, admin.client)).adminOccupancy[1]).toMatchObject({ customer_name: "Ana Pop" });
    const coachDay = await getReservationDay(location, date, now, coach.client);
    expect(coachDay.adminOccupancy).toEqual([]);
    expect(coachDay.courts[0].cells).toEqual(["booked", "booked", "booked", "booked", "booked", "available"]);
    expect((await coach.client.rpc("list_admin_operational_occupancy", { p_court_ids: [courtId], p_date: date })).error?.code).toBe("42501");
    expect((await member.client.rpc("list_admin_operational_occupancy", { p_court_ids: [courtId], p_date: date })).error?.code).toBe("42501");
    expect((await admin.client.from("bookings").select("customer_email")).error?.code).toBe("42501");
    expect((await service.from("bookings").update({ status: "cancelled" }).eq("id", bookingId)).error).toBeNull();
    expect((await getReservationDay(location, date, now, admin.client)).adminOccupancy.map((item) => item.id)).toEqual([directId]);
  } finally {
    await service.from("bookings").delete().eq("id", bookingId);
    await service.from("court_reservations").delete().in("id", [directId, reservationId]);
    await service.from("location_opening_hours").delete().eq("location_id", locationId);
    await service.from("courts").delete().eq("id", courtId);
    await service.from("locations").delete().eq("id", locationId);
    await cleanupAuthFixtures(service, userIds);
  }
});
