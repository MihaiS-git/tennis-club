import { readBookingContracts } from "./checkout-fixtures";
import { appendBookingContractFixture } from "./checkout-fixtures";
import { insertBookingFixture } from "./checkout-fixtures";
import { cleanupBookingFixtures } from "./checkout-fixtures";
import { insertOpeningHoursFixture } from "./opening-hours-fixtures";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { assert, expect, test, vi } from "vitest";
import { getDataSource } from "@/lib/db/data-source";
import { listBookingEditDayCoverage, listCheckoutCourtCoverage } from "@/lib/db/repositories/clubs.repository";
import { listBookingEditDayPricing, listCheckoutPricing } from "@/lib/db/repositories/pricing.repository";
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
  const coveredId = randomUUID(), indoorId = randomUUID(), unpricedId = randomUUID();
  const futureDate = "2099-10-22";
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
    await insertBookingFixture([
      { id: bookingId, reservation_id: reservationId, account_user_id: owner.id,
        payment_method: "pay_at_club", customer_name: "Ana Pop", customer_email: "ana@example.test", customer_phone: "+40 123",
        cancellation_notice_minutes: 120, total_amount_minor: 8000, currency: "RON" },
      { id: guestBookingId, reservation_id: guestReservationId, account_user_id: null,
        payment_method: "pay_at_club", customer_name: "Guest", customer_email: "guest@example.test", customer_phone: "+40 999",
        cancellation_notice_minutes: 120, total_amount_minor: 7000, currency: "RON" },
    ]);
    const ruleSetId = randomUUID();
    assert.strictEqual((await service.from("pricing_rule_sets").insert({ id: ruleSetId, location_id: locationId })).error, null);
    assert.strictEqual((await service.from("location_pricing_rules").insert({ location_id: locationId,
      court_id: courtId, rule_set_id: ruleSetId, court_state: "outdoor", weekday: mondayWeekday(date),
      starts_at_minute: 600, ends_at_minute: 780, price_per_hour_minor: 9001 })).error, null);
    // Same-price online edits still use the existing schedule/concurrency path.
    await appendBookingContractFixture(bookingId, { payment_method: "online", total_amount_minor: 9001 });
    const samePrice = await getOwnBookingEditDay(bookingId, date, owner.client, now);
    expect(samePrice.day.courts[0].rates).toEqual(Array(6).fill(9001));
    // Add distinct states and an unpriced court at the unpublished owner location.
    assert.strictEqual((await service.from("courts").insert([
      { id: coveredId, location_id: locationId, name: "Covered", slug: "covered", surface: "clay", environment: "outdoor" },
      { id: indoorId, location_id: locationId, name: "Indoor", slug: "indoor", surface: "hard", environment: "indoor" },
      { id: unpricedId, location_id: locationId, name: "Unpriced", slug: "unpriced", surface: "clay", environment: "outdoor" },
    ])).error, null);
    assert.strictEqual((await service.from("court_coverage_periods").insert({ court_id: coveredId, starts_on: date, ends_on: date })).error, null);
    assert.strictEqual((await service.from("location_pricing_rules").insert([
      { court_id: coveredId, court_state: "covered", price_per_hour_minor: 12001 },
      { court_id: coveredId, court_state: "outdoor", price_per_hour_minor: 6001 },
      { court_id: indoorId, court_state: "indoor", price_per_hour_minor: 18001 },
    ].map(row => ({ ...row, location_id: locationId, rule_set_id: ruleSetId, weekday: mondayWeekday(date),
      starts_at_minute: 600, ends_at_minute: 780, starts_on: date, ends_on: date })))).error, null);
    const manager = (await getDataSource()).manager;
    const courtIds = [courtId, coveredId, indoorId, unpricedId];
    const [batchCoverage, batchPricing] = await Promise.all([
      listBookingEditDayCoverage(manager, locationId, courtIds, date),
      listBookingEditDayPricing(manager, locationId, courtIds, mondayWeekday(date), date),
    ]);
    for (const id of courtIds) {
      expect(batchCoverage.filter(row => row.courtId === id)).toEqual(await listCheckoutCourtCoverage(manager, id, date));
      const previous = await listCheckoutPricing(manager, id, mondayWeekday(date), date);
      expect(batchPricing.filter(row => row.courtId === id)).toEqual(previous.sort((a, b) => a.id.localeCompare(b.id)));
    }
    expect(await listBookingEditDayCoverage(manager, randomUUID(), courtIds, date)).toEqual([]);
    expect(await listBookingEditDayPricing(manager, randomUUID(), courtIds, mondayWeekday(date), date)).toEqual([]);
    expect(await listBookingEditDayCoverage(manager, locationId, [], date)).toEqual([]);
    expect(await listBookingEditDayPricing(manager, locationId, [], mondayWeekday(date), date)).toEqual([]);
    const queryLog = vi.spyOn((await getDataSource()).logger, "logQuery");
    try {
      const multiple = await getOwnBookingEditDay(bookingId, date, owner.client, now);
      for (const [id, rate] of [[courtId, 9001], [coveredId, 12001], [indoorId, 18001], [unpricedId, null]] as const) {
        expect(multiple.day.courts.find(row => row.court.id === id)?.rates).toEqual(Array(6).fill(rate));
      }
      expect(queryLog.mock.calls.filter(([sql]) => sql.includes('FROM "public"."court_coverage_periods"'))).toHaveLength(1);
      expect(queryLog.mock.calls.filter(([sql]) => sql.includes('FROM "public"."location_pricing_rules"'))).toHaveLength(1);
    } finally { queryLog.mockRestore(); }
    // Future playing-date hours and date-bounded pricing remain authoritative.
    assert.strictEqual((await service.from("opening_hours_schedules").update({ ends_on: "2099-10-21" }).eq("location_id", locationId)).error, null);
    const futureSchedule = await service.from("opening_hours_schedules").insert({ location_id: locationId, starts_on: futureDate }).select("id").single();
    assert.strictEqual(futureSchedule.error, null); assert.ok(futureSchedule.data);
    assert.strictEqual((await insertOpeningHoursFixture(service, { location_id: locationId, schedule_id: futureSchedule.data.id,
      weekday: mondayWeekday(futureDate), opens_at_minute: 840, closes_at_minute: 960 })).error, null);
    assert.strictEqual((await service.from("location_pricing_rules").insert({ location_id: locationId,
      court_id: courtId, rule_set_id: ruleSetId, court_state: "outdoor", weekday: mondayWeekday(futureDate),
      starts_at_minute: 840, ends_at_minute: 960, starts_on: futureDate, ends_on: futureDate, price_per_hour_minor: 15001 })).error, null);
    const future = await getOwnBookingEditDay(bookingId, futureDate, owner.client, now);
    expect(future.day.times).toEqual([840, 870, 900, 930]);
    expect(future.day.courts.find(row => row.court.id === courtId)?.rates).toEqual(Array(4).fill(15001));
    expect(future.day.courts.find(row => row.court.id === coveredId)?.rates).toEqual(Array(4).fill(null));
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
    expect((await service.from("court_coverage_periods").delete().in("court_id", [courtId, coveredId, indoorId, unpricedId])).error).toBeNull();
    expect((await service.from("courts").delete().in("id", [courtId, coveredId, indoorId, unpricedId])).error).toBeNull();
    expect((await service.from("locations").delete().eq("id", locationId)).error).toBeNull();
    await cleanupAuthFixtures(service, users);
  }
}, 60000);
