import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { assert, expect, test } from "vitest";
import { listOwnCourtHistory } from "../helpers/current-activity";
import { listOwnUpcomingCustomerBookings } from "../helpers/current-activity";
import { getReservationDay, cancelCustomerBookingAsAdmin } from "@/lib/reservations/service";
import { localMinute, localToday } from "@/lib/courts/local-time";
import { mondayWeekday } from "@/lib/pricing/resolution";
import { cleanupAuthFixtures, localFixtureClient } from "./auth-fixtures";

test("Admin cancellation atomically preserves snapshots, frees occupancy and moves owner activity to History", async () => {
  const service = localFixtureClient();
  const locationId = randomUUID(), courtId = randomUUID(), reservationId = randomUUID(), bookingId = randomUUID();
  const guestReservationId = randomUUID(), guestBookingId = randomUUID();
  const pastBookingId = randomUUID(), startedBookingId = randomUUID();
  const pastReservationId = randomUUID(), startedReservationId = randomUUID(), pastDirectId = randomUUID();
  const users: string[] = [];
  const date = "2099-10-15", now = new Date("2099-10-14T12:00:00Z");
  const location = { id: locationId, name: "Operations", timezone: "UTC", courts: [{ id: courtId, name: "Court 1" }] };
  const password = "admin-booking-cancel-test-123";
  async function account(role?: "admin" | "coach") {
    const email = `booking-cancel-${randomUUID()}@example.test`;
    const created = await service.auth.admin.createUser({ email, password, email_confirm: true });
    assert.strictEqual(created.error, null); assert.ok(created.data.user);
    users.push(created.data.user.id);
    if (role) assert.strictEqual((await service.from("user_roles").insert({ user_id: created.data.user.id, role_code: role })).error, null);
    const client = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_PUBLISHABLE_KEY!, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    assert.strictEqual((await client.auth.signInWithPassword({ email, password })).error, null);
    return { id: created.data.user.id, client };
  }
  try {
    assert.strictEqual((await service.from("locations").insert({ id: locationId, name: location.name,
      slug: `booking-cancel-${locationId}`, timezone: "UTC", is_public: true, currency: "RON" })).error, null);
    assert.strictEqual((await service.from("courts").insert({ id: courtId, location_id: locationId,
      name: "Court 1", slug: "court-1", surface: "clay", environment: "outdoor", is_active: true })).error, null);
    assert.strictEqual((await service.from("location_opening_hours").insert({ location_id: locationId,
      weekday: mondayWeekday(date), opens_at_minute: 600, closes_at_minute: 780 })).error, null);
    const admin = await account("admin"), secondAdmin = await account("admin"), coach = await account("coach"), owner = await account();
    assert.strictEqual((await service.from("court_reservations").insert([
      { id: reservationId, court_id: courtId, booking_date: date, starts_at_minute: 600, ends_at_minute: 660 },
      { id: guestReservationId, court_id: courtId, booking_date: date, starts_at_minute: 660, ends_at_minute: 720 },
    ])).error, null);
    assert.strictEqual((await service.from("bookings").insert([
      { id: bookingId, reservation_id: reservationId, account_user_id: owner.id,
        payment_method: "pay_at_club", customer_name: "Ana Pop", customer_email: "ana@example.test", customer_phone: "+40 123",
        cancellation_notice_minutes: 120, total_amount_minor: 9000, currency: "RON" },
      { id: guestBookingId, reservation_id: guestReservationId, account_user_id: null,
        payment_method: "pay_at_club", customer_name: "Guest", customer_email: "guest@example.test", customer_phone: "+40 999",
        cancellation_notice_minutes: 120, total_amount_minor: 7000, currency: "RON" },
    ])).error, null);
    const beforeBooking = (await service.from("bookings").select("*").eq("id", bookingId).single()).data!;
    const beforeReservation = (await service.from("court_reservations").select("*").eq("id", reservationId).single()).data!;
    expect((await listOwnUpcomingCustomerBookings(owner.client)).map((item) => item.id)).toContain(bookingId);
    expect((await listOwnUpcomingCustomerBookings(owner.client)).map((item) => item.id)).not.toContain(guestBookingId);
    expect((await getReservationDay(location, date, now, admin.client)).adminOccupancy.map((item) => item.id)).toContain(bookingId);
    const anonymous = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_PUBLISHABLE_KEY!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    for (const client of [coach.client, owner.client, anonymous]) await expect(cancelCustomerBookingAsAdmin(bookingId, client)).rejects.toThrow();
    const attempts = await Promise.all([
      cancelCustomerBookingAsAdmin(bookingId, admin.client),
      cancelCustomerBookingAsAdmin(bookingId, secondAdmin.client),
    ]);
    expect(attempts.map((result) => result.ok).sort()).toEqual([false, true]);
    const winner = attempts[0].ok ? admin.id : secondAdmin.id;
    expect((await cancelCustomerBookingAsAdmin(bookingId, admin.client)).ok).toBe(false);
    expect((await cancelCustomerBookingAsAdmin(randomUUID(), admin.client)).ok).toBe(false);
    const afterBooking = (await service.from("bookings").select("*").eq("id", bookingId).single()).data!;
    const afterReservation = (await service.from("court_reservations").select("*").eq("id", reservationId).single()).data!;
    expect(afterBooking.status).toBe("cancelled");
    expect(afterReservation.status).toBe("cancelled");
    expect(afterReservation.cancelled_at).not.toBeNull();
    expect(afterReservation.cancelled_by_user_id).toBe(winner);
    for (const key of ["id", "reservation_id", "account_user_id", "customer_name", "customer_email",
      "customer_phone", "total_amount_minor", "currency", "created_at"] as const) expect(afterBooking[key]).toBe(beforeBooking[key]);
    for (const key of ["id", "court_id", "booking_date", "starts_at_minute", "ends_at_minute",
      "created_by_user_id", "created_at"] as const) expect(afterReservation[key]).toBe(beforeReservation[key]);
    expect((await listOwnUpcomingCustomerBookings(owner.client)).map((item) => item.id)).not.toContain(bookingId);
    expect((await listOwnCourtHistory(1, owner.client)).rows).toContainEqual(expect.objectContaining({ id: bookingId, kind: "booking", status: "cancelled" }));
    expect((await listOwnCourtHistory(1, owner.client)).rows.map((item) => item.id)).not.toContain(guestBookingId);
    const day = await getReservationDay(location, date, now, admin.client);
    expect(day.adminOccupancy.map((item) => item.id)).not.toContain(bookingId);
    expect(day.courts[0].cells.slice(0, 2)).toEqual(["available", "available"]);
    expect((await anonymous.from("court_reservations").select("court_id, starts_at_minute")
      .eq("court_id", courtId).eq("booking_date", date)).error?.code).toBe("42501");
    expect((await cancelCustomerBookingAsAdmin(guestBookingId, admin.client)).ok).toBe(true);

    const clock = new Date();
    const startedMinute = Math.min(1320, Math.floor(localMinute("UTC", clock) / 30) * 30);
    assert.strictEqual((await service.from("court_reservations").insert([
      { id: pastReservationId, court_id: courtId, booking_date: "2000-01-01", starts_at_minute: 600, ends_at_minute: 660 },
      { id: pastDirectId, court_id: courtId, booking_date: "2000-01-01", starts_at_minute: 660, ends_at_minute: 720 },
      { id: startedReservationId, court_id: courtId, booking_date: localToday("UTC", clock), starts_at_minute: startedMinute, ends_at_minute: startedMinute + 120 },
    ])).error, null);
    assert.strictEqual((await service.from("bookings").insert([
      { id: pastBookingId, reservation_id: pastReservationId, payment_method: "pay_at_club", customer_name: "Historical",
        customer_email: "past@example.test", customer_phone: "+40 123", cancellation_notice_minutes: 120, total_amount_minor: 5000, currency: "RON" },
      { id: startedBookingId, reservation_id: startedReservationId, payment_method: "pay_at_club", customer_name: "Started",
        customer_email: "started@example.test", customer_phone: "+40 123", cancellation_notice_minutes: 120, total_amount_minor: 5000, currency: "RON" },
    ])).error, null);
    for (const id of [pastBookingId, startedBookingId]) {
      const bookingBefore = (await service.from("bookings").select("*").eq("id", id).single()).data!;
      const reservationBefore = (await service.from("court_reservations").select("*").eq("id", bookingBefore.reservation_id).single()).data!;
      expect(await cancelCustomerBookingAsAdmin(id, admin.client)).toEqual({ ok: false, message: "This booking is no longer available to cancel." });
      expect((await service.from("bookings").select("*").eq("id", id).single()).data).toEqual(bookingBefore);
      expect((await service.from("court_reservations").select("*").eq("id", bookingBefore.reservation_id).single()).data).toEqual(reservationBefore);
    }
    const directBefore = (await service.from("court_reservations").select("*").eq("id", pastDirectId).single()).data!;
    expect((await service.from("court_reservations").select("*").eq("id", pastDirectId).single()).data).toEqual(directBefore);
  } finally {
    await service.from("bookings").delete().in("id", [bookingId, guestBookingId, pastBookingId, startedBookingId]);
    await service.from("court_reservations").delete().in("id", [reservationId, guestReservationId, pastReservationId, startedReservationId, pastDirectId]);
    await service.from("location_opening_hours").delete().eq("location_id", locationId);
    await service.from("courts").delete().eq("id", courtId);
    await service.from("locations").delete().eq("id", locationId);
    await cleanupAuthFixtures(service, users);
  }
}, 60000);
