import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { assert, expect, test } from "vitest";
import { listOwnUpcomingCustomerBookings } from "@/lib/bookings/personal-service";
import { localMinute, localToday } from "@/lib/courts/local-time";
import { listPersonalReservations } from "@/lib/reservations/personal-service";
import { cleanupAuthFixtures, localFixtureClient } from "./auth-fixtures";

test("upcoming customer booking reads are owner scoped for members and staff", async () => {
  const service = localFixtureClient();
  const locationId = randomUUID();
  const courtIds: string[] = [];
  const reservationIds: string[] = [];
  const userIds: string[] = [];
  const now = new Date();
  const utcDate = now.toISOString().slice(0, 10);
  const timezone = ["Pacific/Pago_Pago", "Pacific/Honolulu", "Pacific/Kiritimati"]
    .find((zone) => localToday(zone, now) !== utcDate)!;
  const today = localToday(timezone, now);
  const inProgressStart = Math.max(0, Math.min(1380, Math.floor(localMinute(timezone, now) / 30) * 30 - 30));
  const elapsedDate = localMinute(timezone, now) >= 60 ? today
    : new Date(Date.parse(`${today}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  const client = () => createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_PUBLISHABLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  async function account(role?: "admin" | "coach") {
    const email = `personal-booking-${randomUUID()}@example.test`;
    const created = await service.auth.admin.createUser({ email, password: "booking-test-password-123", email_confirm: true });
    assert.strictEqual(created.error, null); assert.ok(created.data.user);
    const id = created.data.user.id;
    userIds.push(id);
    if (role) assert.strictEqual((await service.from("user_roles").insert({ user_id: id, role_code: role })).error, null);
    const signedIn = client();
    assert.strictEqual((await signedIn.auth.signInWithPassword({ email, password: "booking-test-password-123" })).error, null);
    return { id, email, client: signedIn };
  }
  async function booking(accountUserId: string | null, date: string, start: number, end: number,
    options: { bookingStatus?: "confirmed" | "cancelled"; reservationStatus?: "active" | "cancelled"; email?: string } = {}) {
    const courtId = randomUUID(), reservationId = randomUUID();
    courtIds.push(courtId); reservationIds.push(reservationId);
    assert.strictEqual((await service.from("courts").insert({ id: courtId, location_id: locationId,
      name: `Court ${courtIds.length}`, slug: `court-${courtIds.length}`, surface: "clay", environment: "outdoor" })).error, null);
    assert.strictEqual((await service.from("court_reservations").insert({ id: reservationId, court_id: courtId,
      booking_date: date, starts_at_minute: start, ends_at_minute: end,
      status: options.reservationStatus ?? "active",
      cancelled_at: options.reservationStatus === "cancelled" ? now.toISOString() : null,
      cancelled_by_user_id: options.reservationStatus === "cancelled" ? accountUserId : null })).error, null);
    const id = randomUUID();
    assert.strictEqual((await service.from("bookings").insert({ id, reservation_id: reservationId,
      account_user_id: accountUserId, customer_name: "Snapshot Name", customer_email: options.email ?? "snapshot@example.test",
      customer_phone: "+40 123", total_amount_minor: 9000, currency: "RON",
      status: options.bookingStatus ?? "confirmed" })).error, null);
    return id;
  }
  try {
    assert.strictEqual((await service.from("locations").insert({ id: locationId, name: "Personal booking fixture",
      slug: `personal-booking-${locationId}`, timezone, currency: "RON" })).error, null);
    const member = await account();
    const other = await account();
    const admin = await account("admin");
    const coach = await account("coach");
    // Insert out of order so insertion order cannot satisfy the assertion.
    const lastFuture = await booking(member.id, "2099-10-16", 600, 660);
    const future = await booking(member.id, "2099-10-15", 600, 660);
    const nextFuture = await booking(member.id, "2099-10-15", 720, 780);
    const inProgress = await booking(member.id, today, inProgressStart, inProgressStart + 60);
    const elapsed = await booking(member.id, elapsedDate, 0, 60);
    const cancelled = await booking(member.id, "2099-10-16", 600, 660, { bookingStatus: "cancelled" });
    const inactive = await booking(member.id, "2099-10-17", 600, 660, { reservationStatus: "cancelled" });
    const another = await booking(other.id, "2099-10-18", 600, 660);
    const guest = await booking(null, "2099-10-19", 600, 660, { email: member.email });
    assert.strictEqual((await service.from("users").update({ first_name: "Current", last_name: "Profile" })
      .eq("id", member.id)).error, null);

    const memberRows = await listOwnUpcomingCustomerBookings(member.client);
    expect(memberRows.map((row) => row.id)).toEqual([inProgress, future, nextFuture, lastFuture]);
    expect(memberRows[0]).toMatchObject({ customer_name: "Snapshot Name", customer_email: "snapshot@example.test",
      customer_phone: "+40 123", total_amount_minor: 9000, currency: "RON" });
    for (const hidden of [elapsed, cancelled, inactive, another, guest])
      expect(memberRows.map((row) => row.id)).not.toContain(hidden);
    expect((await listOwnUpcomingCustomerBookings(other.client)).map((row) => row.id)).toEqual([another]);
    for (const staff of [admin, coach]) {
      const last = await booking(staff.id, "2099-10-21", 600, 660);
      const first = await booking(staff.id, "2099-10-20", 600, 660);
      const middle = await booking(staff.id, "2099-10-20", 720, 780);
      const ownReservations: string[] = [];
      for (const start of [840, 660]) {
        const courtId = randomUUID(), id = randomUUID();
        courtIds.push(courtId); reservationIds.push(id); ownReservations.push(id);
        assert.strictEqual((await service.from("courts").insert({ id: courtId, location_id: locationId,
          name: `Court ${courtIds.length}`, slug: `court-${courtIds.length}`, surface: "clay", environment: "outdoor" })).error, null);
        assert.strictEqual((await service.from("court_reservations").insert({ id, court_id: courtId,
          booking_date: "2099-10-20", starts_at_minute: start, ends_at_minute: start + 60,
          created_by_user_id: staff.id, reason: "Own training" })).error, null);
      }
      expect((await listOwnUpcomingCustomerBookings(staff.client)).map((row) => row.id)).toEqual([first, middle, last]);
      const direct = (await listPersonalReservations(staff.client)).upcoming;
      expect(direct.map((row) => row.id)).toEqual([...ownReservations].reverse());
      expect(direct.every((row) => row.created_by_user_id === staff.id)).toBe(true);
    }
    expect(await listPersonalReservations(member.client)).toEqual({ upcoming: [] });
    expect((await member.client.rpc("list_personal_court_reservations")).error?.code).toBe("42501");
    expect((await member.client.from("bookings").select("id")).error?.code).toBe("42501");
  } finally {
    if (reservationIds.length) assert.strictEqual((await service.from("bookings").delete().in("reservation_id", reservationIds)).error, null);
    if (reservationIds.length) assert.strictEqual((await service.from("court_reservations").delete().in("id", reservationIds)).error, null);
    if (courtIds.length) assert.strictEqual((await service.from("courts").delete().in("id", courtIds)).error, null);
    assert.strictEqual((await service.from("locations").delete().eq("id", locationId)).error, null);
    await cleanupAuthFixtures(service, userIds);
  }
});
