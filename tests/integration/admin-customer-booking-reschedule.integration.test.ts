import { rescheduleCommandFixture } from "./checkout-fixtures";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { assert, expect, test } from "vitest";
import { listOwnCourtHistory } from "@/lib/bookings/history-service";
import { listOwnUpcomingCustomerBookings } from "@/lib/bookings/personal-service";
import { cancelCustomerBookingAsAdmin } from "@/lib/reservations/service";
import { getAdminBookingEditDay, rescheduleCustomerBookingAsAdmin } from "@/lib/bookings/admin-reschedule";
import { commandFence, readBookingActor, readBookingContext } from "@/lib/bookings/persistence";
import { mondayWeekday } from "@/lib/pricing/resolution";
import { cleanupAuthFixtures, localFixtureClient } from "./auth-fixtures";

test("Admin reschedules the same rows with acknowledged pricing, stale/overlap protection and owner visibility", async () => {
  const service = localFixtureClient();
  const locationId = randomUUID(), courtId = randomUUID(), reservationId = randomUUID(), bookingId = randomUUID();
  const guestReservationId = randomUUID(), guestBookingId = randomUUID();
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
    const admin = await account("admin"), coach = await account("coach"), owner = await account();
    assert.strictEqual((await service.from("court_reservations").insert([
      { id: reservationId, court_id: courtId, booking_date: date, starts_at_minute: 600, ends_at_minute: 660 },
      { id: guestReservationId, court_id: courtId, booking_date: date, starts_at_minute: 660, ends_at_minute: 720 },
    ])).error, null);
    assert.strictEqual((await service.from("bookings").insert([
      { id: bookingId, reservation_id: reservationId, account_user_id: owner.id,
        payment_method: "pay_at_club", customer_name: "Ana Pop", customer_email: "ana@example.test", customer_phone: "+40 123",
        cancellation_notice_minutes: 120, total_amount_minor: 8000, currency: "RON" },
      { id: guestBookingId, reservation_id: guestReservationId, account_user_id: null,
        payment_method: "pay_at_club", customer_name: "Guest", customer_email: "guest@example.test", customer_phone: "+40 999",
        cancellation_notice_minutes: 120, total_amount_minor: 7000, currency: "RON" },
    ])).error, null);
    const ruleSetId = randomUUID();
    assert.strictEqual((await service.from("pricing_rule_sets").insert({ id: ruleSetId, location_id: locationId })).error, null);
    assert.strictEqual((await service.from("location_pricing_rules").insert({ location_id: locationId,
      court_id: courtId, rule_set_id: ruleSetId, court_state: "outdoor", weekday: mondayWeekday(date),
      starts_at_minute: 600, ends_at_minute: 780, price_per_hour_minor: 9001 })).error, null);
    const beforeBooking = (await service.from("bookings").select("*").eq("id", bookingId).single()).data!;
    const beforeReservation = (await service.from("court_reservations").select("*").eq("id", reservationId).single()).data!;
    const context = await getAdminBookingEditDay(bookingId, date, admin.client, now);
    expect(context.booking.occupancy).toEqual([{ court_id: courtId, starts_at_minute: 660, ends_at_minute: 720 }]);
    const input = { id: bookingId, expectedUpdatedAt: context.booking.updated_at,
      expectedBookingUpdatedAt: context.booking.booking_updated_at, courtId, date,
      startMinute: 720, endMinute: 780, save: true, expectedTotal: 9001, priceAcknowledged: false };
    expect(await rescheduleCustomerBookingAsAdmin(input, admin.client)).toMatchObject({ ok: false, reason: "price_changed", totalAmountMinor: 9001 });
    expect((await service.from("bookings").select("*").eq("id", bookingId).single()).data).toEqual(beforeBooking);
    expect((await service.from("court_reservations").select("*").eq("id", reservationId).single()).data).toEqual(beforeReservation);
    const quotedFacts = await readBookingContext(bookingId, service);
    assert.ok(quotedFacts);
    const actorFacts = await readBookingActor(admin.id, service);
    const persistenceCommand = { ...commandFence(quotedFacts), p_actor: admin.id, p_actor_expected: actorFacts,
      p_scope: "admin", p_deadline: "2099-10-15T10:00:00Z", p_inclusive: false, p_total: 9001, p_event: null,
      p_schedule: { court_id: courtId, booking_date: date, starts_at_minute: 720, ends_at_minute: 780 } };
    // A quote changing again must be acknowledged again; neither row is written.
    await service.from("location_pricing_rules").update({ price_per_hour_minor: 10001 }).eq("court_id", courtId);
    expect((await service.rpc("commit_booking_reschedule", persistenceCommand)).error?.code).toBe("40001");
    const currentFacts = await readBookingContext(bookingId, service);
    assert.ok(currentFacts);
    const currentCommand = { ...persistenceCommand, ...commandFence(currentFacts), p_total: 10001 };
    expect((await service.rpc("commit_booking_reschedule", { ...currentCommand,
      p_actor_expected: { ...actorFacts, roles: [] } })).error?.code).toBe("40001");
    expect((await service.rpc("commit_booking_reschedule", { ...currentCommand,
      p_deadline: "1970-01-01T00:00:00Z" })).error?.code).toBe("40001");
    expect((await service.rpc("commit_booking_reschedule", { ...currentCommand,
      p_event: { kind: "invalid", key: "invalid", recipient: "ana@example.test", payload: {} } })).error?.code).toBe("23514");
    expect((await service.from("bookings").select("*").eq("id", bookingId).single()).data).toEqual(beforeBooking);
    expect((await service.from("court_reservations").select("*").eq("id", reservationId).single()).data).toEqual(beforeReservation);
    expect(await rescheduleCustomerBookingAsAdmin({ ...input, priceAcknowledged: true }, admin.client))
      .toMatchObject({ ok: false, reason: "price_changed", totalAmountMinor: 10001 });
    expect((await service.from("court_reservations").select("*").eq("id", reservationId).single()).data).toEqual(beforeReservation);
    expect(await rescheduleCustomerBookingAsAdmin({ ...input, startMinute: 660, endMinute: 720,
      expectedTotal: 10001, priceAcknowledged: true }, admin.client)).toMatchObject({ ok: false, message: expect.stringContaining("no longer available") });
    for (const client of [coach.client, owner.client]) {
      expect((await client.rpc("commit_booking_reschedule", rescheduleCommandFixture(bookingId))).error?.code).toBe("42501");
      await expect(rescheduleCustomerBookingAsAdmin(input, client)).rejects.toThrow();
    }
    expect(await rescheduleCustomerBookingAsAdmin({ ...input, expectedTotal: 10001, priceAcknowledged: true }, admin.client))
      .toEqual({ ok: true, totalAmountMinor: 10001 });
    const afterBooking = (await service.from("bookings").select("*").eq("id", bookingId).single()).data!;
    const afterReservation = (await service.from("court_reservations").select("*").eq("id", reservationId).single()).data!;
    for (const key of ["id", "reservation_id", "account_user_id", "customer_name", "customer_email", "customer_phone",
      "currency", "cancellation_notice_minutes", "created_at", "status"] as const) expect(afterBooking[key]).toBe(beforeBooking[key]);
    expect(afterBooking.total_amount_minor).toBe(10001);
    for (const key of ["id", "created_by_user_id", "created_at", "reason", "status", "cancelled_at", "cancelled_by_user_id"] as const)
      expect(afterReservation[key]).toBe(beforeReservation[key]);
    expect(afterReservation).toMatchObject({ starts_at_minute: 720, ends_at_minute: 780 });
    expect(await rescheduleCustomerBookingAsAdmin({ ...input, expectedTotal: 10001, priceAcknowledged: true }, admin.client))
      .toMatchObject({ ok: false, reason: "stale" });
    expect((await service.from("bookings").select("*").eq("id", bookingId).single()).data).toEqual(afterBooking);
    expect((await service.from("court_reservations").select("*").eq("id", reservationId).single()).data).toEqual(afterReservation);
    const personal = (await listOwnUpcomingCustomerBookings(owner.client)).filter((b) => b.id === bookingId);
    expect(personal).toHaveLength(1);
    expect(personal[0]).toMatchObject({ booking_date: date, court_name: "Court 1", starts_at_minute: 720, ends_at_minute: 780, total_amount_minor: 10001 });
    expect((await admin.client.rpc("cancel_admin_court_reservation", { p_id: reservationId })).data).toBe(false);
    expect((await cancelCustomerBookingAsAdmin(bookingId, admin.client)).ok).toBe(true);
    expect((await listOwnCourtHistory(1, owner.client)).rows).toContainEqual(expect.objectContaining({ id: bookingId, status: "cancelled" }));
  } finally {
    await service.from("bookings").delete().in("id", [bookingId, guestBookingId]);
    await service.from("court_reservations").delete().in("id", [reservationId, guestReservationId]);
    await service.from("location_opening_hours").delete().eq("location_id", locationId);
    await service.from("location_pricing_rules").delete().eq("location_id", locationId);
    await service.from("pricing_rule_sets").delete().eq("location_id", locationId);
    await service.from("courts").delete().eq("id", courtId);
    await service.from("locations").delete().eq("id", locationId);
    await cleanupAuthFixtures(service, users);
  }
}, 60000);
