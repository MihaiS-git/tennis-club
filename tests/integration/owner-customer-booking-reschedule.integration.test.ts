import { readBookingContracts } from "./checkout-fixtures";
import { appendBookingContractFixture } from "./checkout-fixtures";
import { insertBookingFixture } from "./checkout-fixtures";
import { cleanupBookingFixtures } from "./checkout-fixtures";
import { insertOpeningHoursFixture } from "./opening-hours-fixtures";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { assert, expect, test } from "vitest";
import { listOwnUpcomingCustomerBookings } from "../helpers/current-activity";
import { cancelOwnCustomerBooking } from "@/lib/bookings/self-cancellation-service";
import { getReservationDay } from "@/lib/reservations/service";
import { getOwnBookingEditDay, rescheduleOwnCustomerBooking } from "@/lib/bookings/self-reschedule";
import { mondayWeekday } from "@/lib/pricing/resolution";
import { cleanupAuthFixtures, localFixtureClient } from "./auth-fixtures";

test("Owner rescheduling preserves rows, enforces notice/ownership and shares pricing, stale and overlap protection", async () => {
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
    return { id: created.data.user.id, client, email };
  }
  try {
    assert.strictEqual((await service.from("locations").insert({ id: locationId, name: location.name,
      slug: `booking-cancel-${locationId}`, timezone: "UTC", is_public: false, currency: "RON" })).error, null);
    assert.strictEqual((await service.from("courts").insert({ id: courtId, location_id: locationId,
      name: "Court 1", slug: "court-1", surface: "clay", environment: "outdoor", is_active: true })).error, null);
    assert.strictEqual((await insertOpeningHoursFixture(service, { location_id: locationId,
      weekday: mondayWeekday(date), opens_at_minute: 600, closes_at_minute: 780 })).error, null);
    const admin = await account("admin"), coach = await account("coach"), owner = await account();
    assert.strictEqual((await service.from("court_reservations").insert([
      { id: reservationId, court_id: courtId, booking_date: date, starts_at_minute: 600, ends_at_minute: 660 },
      { id: guestReservationId, court_id: courtId, booking_date: date, starts_at_minute: 660, ends_at_minute: 720 },
    ])).error, null);
    assert.strictEqual((await insertBookingFixture(service, [
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
    // Same-price online edits still use the existing schedule/concurrency path.
    await appendBookingContractFixture(bookingId, { payment_method: "online", total_amount_minor: 9001 });
    const samePrice = await getOwnBookingEditDay(bookingId, date, owner.client, now);
    expect(await rescheduleOwnCustomerBooking({ id: bookingId, expectedUpdatedAt: samePrice.booking.updated_at,
      expectedRevisionId: samePrice.booking.current_revision_id, courtId, date, startMinute: 720, endMinute: 780,
      save: true, expectedTotal: 9001, priceAcknowledged: false }, owner.client)).toEqual({ ok: true, totalAmountMinor: 9001 });
    await appendBookingContractFixture(bookingId, { payment_method: "pay_at_club", total_amount_minor: 8000,
      starts_at_minute: 600, ends_at_minute: 660 });
    expect((await service.from("payment_attempts").insert({ booking_id: bookingId, method: "pay_at_club",
      amount_minor: 8000, currency: "RON", status: "due" })).error).toBeNull();
    const beforeBooking = (await readBookingContracts(service, { ids: [bookingId] }))[0];
    const beforeReservation = (await service.from("court_reservations").select("*").eq("id", reservationId).single()).data!;
    const context = await getOwnBookingEditDay(bookingId, date, owner.client, now);
    expect(context.booking.occupancy).toEqual([{ court_id: courtId, starts_at_minute: 660, ends_at_minute: 720 }]);
    const input = { id: bookingId, expectedUpdatedAt: context.booking.updated_at,
      expectedRevisionId: context.booking.current_revision_id, courtId, date,
      startMinute: 720, endMinute: 780, save: true, expectedTotal: 9001, priceAcknowledged: false };
    expect(await rescheduleOwnCustomerBooking(input, owner.client)).toMatchObject({ ok: false, reason: "price_changed", totalAmountMinor: 9001 });
    expect((await readBookingContracts(service, { ids: [bookingId] }))[0]).toEqual(beforeBooking);
    expect((await service.from("court_reservations").select("*").eq("id", reservationId).single()).data).toEqual(beforeReservation);
    // A quote changing again must be acknowledged again; neither row is written.
    await service.from("location_pricing_rules").update({ price_per_hour_minor: 10001 }).eq("court_id", courtId);
    expect(await rescheduleOwnCustomerBooking({ ...input, priceAcknowledged: true }, owner.client))
      .toMatchObject({ ok: false, reason: "price_changed", totalAmountMinor: 10001 });
    expect((await service.from("court_reservations").select("*").eq("id", reservationId).single()).data).toEqual(beforeReservation);
    expect(await rescheduleOwnCustomerBooking({ ...input, startMinute: 660, endMinute: 720,
      expectedTotal: 10001, priceAcknowledged: true }, owner.client)).toMatchObject({ ok: false, message: expect.stringContaining("no longer available") });
    for (const client of [coach.client, admin.client]) {
      expect(await rescheduleOwnCustomerBooking(input, client)).toMatchObject({ ok: false });
    }

    expect(await rescheduleOwnCustomerBooking({ ...input, expectedTotal: 10001, priceAcknowledged: true }, owner.client))
      .toEqual({ ok: true, totalAmountMinor: 10001 });
    const afterBooking = (await readBookingContracts(service, { ids: [bookingId] }))[0];
    const afterReservation = (await service.from("court_reservations").select("*").eq("id", reservationId).single()).data!;
    for (const key of ["id", "reservation_id", "account_user_id", "customer_name", "customer_email", "customer_phone",
      "currency", "cancellation_notice_minutes", "created_at", "status"] as const) expect(afterBooking[key]).toBe(beforeBooking[key]);
    expect(afterBooking.total_amount_minor).toBe(10001);
    expect((await service.from("payment_attempts").select("amount_minor,status,method").eq("booking_id", bookingId)).data)
      .toEqual([{ amount_minor: 8000, status: "due", method: "pay_at_club" }]);
    for (const key of ["id", "created_by_user_id", "created_at", "reason", "status", "cancelled_at", "cancelled_by_user_id"] as const)
      expect(afterReservation[key]).toBe(beforeReservation[key]);
    expect(afterReservation).toMatchObject({ starts_at_minute: 720, ends_at_minute: 780 });
    expect(await rescheduleOwnCustomerBooking({ ...input, expectedTotal: 10001, priceAcknowledged: true }, owner.client))
      .toMatchObject({ ok: true });
    expect((await readBookingContracts(service, { ids: [bookingId] }))[0]).toEqual(afterBooking);
    expect((await service.from("court_reservations").select("*").eq("id", reservationId).single()).data).toEqual(afterReservation);
    const personal = (await listOwnUpcomingCustomerBookings(owner.client)).filter((b) => b.id === bookingId);
    expect(personal).toHaveLength(1);
    expect(personal[0]).toMatchObject({ booking_date: date, court_name: "Court 1", starts_at_minute: 720, ends_at_minute: 780, total_amount_minor: 10001 });
    // A Coach uses the same owner service for a real save, including price and stale tokens.
    assert.strictEqual((await service.from("user_roles").insert({ user_id: owner.id, role_code: "coach" })).error, null);
    const coachContext = await getOwnBookingEditDay(bookingId, date, owner.client, now);
    expect(await rescheduleOwnCustomerBooking({ ...input, expectedUpdatedAt: coachContext.booking.updated_at,
      expectedRevisionId: coachContext.booking.current_revision_id, startMinute: 600, endMinute: 660,
      expectedTotal: 10001, priceAcknowledged: true }, owner.client)).toEqual({ ok: true, totalAmountMinor: 10001 });
    const coachDay = await getReservationDay(location, date, now, owner.client);
    expect(coachDay.occupancy).toContainEqual({ court_id: courtId, starts_at_minute: 600, ends_at_minute: 660 });
    expect(coachDay.occupancy).not.toContainEqual({ court_id: courtId, starts_at_minute: 720, ends_at_minute: 780 });
    assert.strictEqual((await service.from("user_roles").delete().eq("user_id", owner.id).eq("role_code", "coach")).error, null);
    // Snapshot cutoff is enforced by the command even if the client opened earlier.
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    await appendBookingContractFixture(bookingId, { booking_date: tomorrow, cancellation_notice_minutes: 43200 });
    const currentBooking = (await service.from("bookings").select("current_revision_id").eq("id", bookingId).single()).data!;
    const currentReservation = (await service.from("court_reservations").select("updated_at").eq("id", reservationId).single()).data!;
    const cutoffInput = { ...input, expectedUpdatedAt: currentReservation.updated_at,
      expectedRevisionId: currentBooking.current_revision_id, save: false };
    expect(await rescheduleOwnCustomerBooking(cutoffInput, owner.client)).toMatchObject({ ok: false });
    await expect(getOwnBookingEditDay(bookingId, date, owner.client)).rejects.toThrow();
    for (const role of ["coach", "admin"]) {
      assert.strictEqual((await service.from("user_roles").insert({ user_id: owner.id, role_code: role })).error, null);
      expect(await rescheduleOwnCustomerBooking(cutoffInput, owner.client)).toMatchObject({ ok: true });
      assert.strictEqual((await service.from("user_roles").delete().eq("user_id", owner.id).eq("role_code", role)).error, null);
    }
    assert.strictEqual((await service.from("users").update({ status: "suspended" }).eq("id", owner.id)).error, null);
    expect(await rescheduleOwnCustomerBooking(cutoffInput, owner.client)).toMatchObject({ ok: false });
    assert.strictEqual((await service.from("users").update({ status: "active" }).eq("id", owner.id)).error, null);
    assert.strictEqual((await service.from("user_roles").insert({ user_id: owner.id, role_code: "coach" })).error, null);
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    await appendBookingContractFixture(bookingId, { booking_date: yesterday });
    const startedBooking = (await service.from("bookings").select("current_revision_id").eq("id", bookingId).single()).data!;
    const started = (await service.from("court_reservations").select("updated_at").eq("id", reservationId).single()).data!;
    expect(await rescheduleOwnCustomerBooking({ ...cutoffInput, expectedUpdatedAt: started.updated_at,
      expectedRevisionId: startedBooking.current_revision_id }, owner.client))
      .toMatchObject({ ok: false });
    expect(await cancelOwnCustomerBooking(bookingId, owner.client)).toMatchObject({ ok: false });
    // Matching email never grants guest or another account's ownership.
    for (const id of [bookingId, guestBookingId]) await appendBookingContractFixture(id, { customer_email:coach.email });
    for (const id of [bookingId, guestBookingId]) {
      expect(await cancelOwnCustomerBooking(id, coach.client)).toMatchObject({ ok: false });
      expect(await rescheduleOwnCustomerBooking({ ...input, id }, coach.client)).toMatchObject({ ok: false });
      await expect(getOwnBookingEditDay(id, date, coach.client, now)).rejects.toThrow();
    }
    await appendBookingContractFixture(bookingId, { booking_date: date });
    expect(await cancelOwnCustomerBooking(bookingId, owner.client)).toEqual({ ok: true, outcome: "cancelled" });
    const cancelledDay = await getReservationDay(location, date, now, owner.client);
    expect(cancelledDay.occupancy).toEqual([{ court_id: courtId, starts_at_minute: 660, ends_at_minute: 720 }]);
    expect((await service.from("bookings").select("status,account_user_id").eq("id", bookingId).single()).data)
      .toEqual({ status: "cancelled", account_user_id: owner.id });
  } finally {
    await cleanupBookingFixtures({ bookingIds: [bookingId, guestBookingId] });
    expect((await service.from("court_reservations").delete().in("id", [reservationId, guestReservationId])).error).toBeNull();
    expect((await service.from("location_opening_hours").delete().eq("location_id", locationId)).error).toBeNull();
    expect((await service.from("location_pricing_rules").delete().eq("location_id", locationId)).error).toBeNull();
    expect((await service.from("pricing_rule_sets").delete().eq("location_id", locationId)).error).toBeNull();
    expect((await service.from("courts").delete().eq("id", courtId)).error).toBeNull();
    expect((await service.from("locations").delete().eq("id", locationId)).error).toBeNull();
    await cleanupAuthFixtures(service, users);
  }
}, 60000);
