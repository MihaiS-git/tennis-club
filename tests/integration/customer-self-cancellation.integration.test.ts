import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { assert, expect, test } from "vitest";
import { cancelOwnCustomerBooking } from "@/lib/bookings/self-cancellation-service";
import { listOwnUpcomingCustomerBookings } from "@/lib/bookings/personal-service";
import { listOwnCourtHistory } from "@/lib/bookings/history-service";
import { localMinute, localToday } from "@/lib/courts/local-time";
import { cleanupAuthFixtures, localFixtureClient } from "./auth-fixtures";
import { ensureIntegrationAdminAnchor } from "./admin-anchor";

test("self-cancellation enforces account ownership, snapshot notice, staff exemption and serialized lifecycle", async () => {
  const service = localFixtureClient();
  await ensureIntegrationAdminAnchor(service);
  const locationId = randomUUID(), users: string[] = [], courts: string[] = [], reservations: string[] = [], bookings: string[] = [];
  const timezone = "Europe/Bucharest", password = "self-cancel-booking-test-123";
  const reader = () => createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_PUBLISHABLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  async function account(role?: "admin" | "coach") {
    const email = `self-cancel-${randomUUID()}@example.test`;
    const created = await service.auth.admin.createUser({ email, password, email_confirm: true });
    assert.strictEqual(created.error, null); assert.ok(created.data.user);
    const id = created.data.user.id; users.push(id);
    if (role) assert.strictEqual((await service.from("user_roles").insert({ user_id: id, role_code: role })).error, null);
    const client = reader();
    assert.strictEqual((await client.auth.signInWithPassword({ email, password })).error, null);
    return { id, email, client };
  }
  async function booking(owner: string | null, minutesAhead: number, notice: number, email = "stored@example.test") {
    let start = new Date(Math.floor((Date.now() + minutesAhead * 60_000) / (30 * 60_000)) * 30 * 60_000);
    if (localMinute(timezone, start) > 1380) start = new Date(start.getTime() + 30 * 60_000);
    const courtId = randomUUID(), reservationId = randomUUID(), bookingId = randomUUID();
    courts.push(courtId); reservations.push(reservationId); bookings.push(bookingId);
    assert.strictEqual((await service.from("courts").insert({ id: courtId, location_id: locationId,
      name: "Test court", slug: courtId, environment: "outdoor", surface: "clay" })).error, null);
    const minute = localMinute(timezone, start);
    assert.strictEqual((await service.from("court_reservations").insert({ id: reservationId, court_id: courtId,
      booking_date: localToday(timezone, start), starts_at_minute: minute, ends_at_minute: minute + 60 })).error, null);
    assert.strictEqual((await service.from("bookings").insert({ id: bookingId, reservation_id: reservationId,
      account_user_id: owner, payment_method: "pay_at_club", customer_name: "Stored Owner", customer_email: email, customer_phone: "123",
      cancellation_notice_minutes: notice, total_amount_minor: 9000, currency: "RON" })).error, null);
    return { id: bookingId, reservationId, courtId, start };
  }
  const read = async (item: Awaited<ReturnType<typeof booking>>) => {
    const b = await service.from("bookings").select("*").eq("id", item.id).single();
    const r = await service.from("court_reservations").select("*").eq("id", item.reservationId).single();
    assert.strictEqual(b.error, null); assert.strictEqual(r.error, null);
    return { booking: b.data!, reservation: r.data! };
  };
  try {
    assert.strictEqual((await service.from("locations").insert({ id: locationId, name: "Self cancellation",
      slug: `self-cancel-${locationId}`, timezone, currency: "RON", is_public: true,
      customer_cancellation_notice_minutes: 43200 })).error, null);
    const owner = await account(), other = await account(), admin = await account("admin"), coach = await account("coach");
    const eligible = await booking(owner.id, 180, 60);
    const before = await read(eligible);
    expect(Date.parse((await listOwnUpcomingCustomerBookings(owner.client)).find((row) => row.id === eligible.id)!.starts_at_instant))
      .toBe(eligible.start.getTime());
    // Privileges do not turn My Activity into a global management surface.
    for (const actor of [other, admin, coach]) {
      expect(await cancelOwnCustomerBooking(eligible.id, actor.client)).toMatchObject({ ok: false });
      expect((await actor.client.rpc("cancel_own_customer_booking", { p_id: eligible.id })).data).toBe("unavailable");
    }
    expect((await reader().rpc("cancel_own_customer_booking", { p_id: eligible.id })).error?.code).toBe("42501");
    expect(await cancelOwnCustomerBooking(randomUUID(), owner.client)).toMatchObject({ ok: false });
    expect(await cancelOwnCustomerBooking("invalid", owner.client)).toMatchObject({ ok: false });
    expect(await cancelOwnCustomerBooking(eligible.id, owner.client)).toEqual({ ok: true });
    const after = await read(eligible);
    expect(after.booking.status).toBe("cancelled"); expect(after.reservation.status).toBe("cancelled");
    expect(after.reservation.cancelled_at).not.toBeNull(); expect(after.reservation.cancelled_by_user_id).toBe(owner.id);
    for (const key of Object.keys(before.booking).filter((key) => !["status", "updated_at"].includes(key)))
      expect(after.booking[key]).toEqual(before.booking[key]);
    for (const key of Object.keys(before.reservation).filter((key) => !["status", "updated_at", "cancelled_at", "cancelled_by_user_id"].includes(key)))
      expect(after.reservation[key]).toEqual(before.reservation[key]);
    expect((await listOwnUpcomingCustomerBookings(owner.client)).map((row) => row.id)).not.toContain(eligible.id);
    expect((await listOwnCourtHistory(1, owner.client)).rows).toContainEqual(expect.objectContaining({
      id: eligible.id, status: "cancelled", cancellation_notice_minutes: 60 }));
    expect((await reader().from("court_reservations").select("court_id, starts_at_minute").eq("court_id", eligible.courtId)).data).toEqual([]);
    expect(await cancelOwnCustomerBooking(eligible.id, owner.client)).toMatchObject({ ok: false });
    expect((await owner.client.rpc("cancel_own_customer_booking", { p_id: eligible.id })).data).toBe("unavailable");
    expect(await read(eligible)).toEqual(after);

    const expired = await booking(owner.id, 180, 1440);
    expect(await cancelOwnCustomerBooking(expired.id, owner.client)).toMatchObject({ ok: false, message: expect.stringContaining("expired") });
    expect((await owner.client.rpc("cancel_own_customer_booking", { p_id: expired.id })).data).toBe("notice_required");
    for (const [actor, role] of [[admin, "admin"], [coach, "coach"]] as const) {
      const own = await booking(actor.id, 180, 43200);
      expect(await cancelOwnCustomerBooking(own.id, actor.client)).toEqual({ ok: true });
      // Current roles, rather than booking-time roles, determine the exemption.
      const removedRole = await booking(actor.id, 180, 43200);
      assert.strictEqual((await service.from("user_roles").delete().eq("user_id", actor.id)).error, null);
      expect((await actor.client.rpc("cancel_own_customer_booking", { p_id: removedRole.id })).data).toBe("notice_required");
      assert.strictEqual((await service.from("user_roles").insert({ user_id: actor.id, role_code: role })).error, null);
    }
    // 36 hours in the past avoids midnight interval boundaries in every timezone.
    for (const actor of [owner, admin, coach]) {
      const started = await booking(actor.id, -2160, 0);
      expect((await actor.client.rpc("cancel_own_customer_booking", { p_id: started.id })).data).toBe("started");
    }
    assert.strictEqual((await service.from("users").update({ first_name: "Stored", last_name: "Owner", phone: "123" })
      .eq("id", owner.id)).error, null);
    const guest = await booking(null, 180, 0, owner.email);
    expect(await cancelOwnCustomerBooking(guest.id, owner.client)).toMatchObject({ ok: false });
    expect((await owner.client.rpc("cancel_own_customer_booking", { p_id: guest.id })).data).toBe("unavailable");
    const inactive = await booking(owner.id, 180, 0);
    assert.strictEqual((await service.from("court_reservations").update({ status: "cancelled",
      cancelled_at: new Date().toISOString(), cancelled_by_user_id: owner.id }).eq("id", inactive.reservationId)).error, null);
    expect((await owner.client.rpc("cancel_own_customer_booking", { p_id: inactive.id })).data).toBe("unavailable");
    expect((await read(inactive)).booking.status).toBe("confirmed");
    const race = await booking(owner.id, 180, 0);
    const attempts = await Promise.all([1, 2].map(() => owner.client.rpc("cancel_own_customer_booking", { p_id: race.id })));
    for (const attempt of attempts) expect(attempt.error).toBeNull();
    expect(attempts.map((row) => row.data).sort()).toEqual(["cancelled", "unavailable"]);
    const raceAfter = await read(race);
    expect((await owner.client.rpc("cancel_own_customer_booking", { p_id: race.id })).data).toBe("unavailable");
    expect(await read(race)).toEqual(raceAfter);
    const suspended = await booking(owner.id, 180, 0);
    assert.strictEqual((await service.from("users").update({ status: "suspended" }).eq("id", owner.id)).error, null);
    expect(await cancelOwnCustomerBooking(suspended.id, owner.client)).toMatchObject({ ok: false });
    expect((await owner.client.rpc("cancel_own_customer_booking", { p_id: suspended.id })).error?.code).toBe("42501");
    expect((await read(suspended)).booking.status).toBe("confirmed");
  } finally {
    if (bookings.length) assert.strictEqual((await service.from("bookings").delete().in("id", bookings)).error, null);
    if (reservations.length) assert.strictEqual((await service.from("court_reservations").delete().in("id", reservations)).error, null);
    if (courts.length) assert.strictEqual((await service.from("courts").delete().in("id", courts)).error, null);
    assert.strictEqual((await service.from("locations").delete().eq("id", locationId)).error, null);
    await cleanupAuthFixtures(service, users);
  }
}, 60000);
