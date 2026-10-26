import { insertBookingFixture } from "./checkout-fixtures";
import { cleanupBookingFixtures } from "./checkout-fixtures";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { assert, expect, test, vi } from "vitest";
import { listOwnCourtActivity, listOwnUpcomingActivity } from "@/lib/bookings/activity-service";
async function listOwnUpcomingCustomerBookings(client: Parameters<typeof listOwnUpcomingActivity>[1]) {
  return (await listOwnUpcomingActivity({}, client)).bookings;
}
import { parseActivityQuery } from "@/lib/bookings/activity-query";
import { getDataSource } from "@/lib/db/data-source";
import { localMinute, localToday } from "@/lib/courts/local-time";
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
    options: { bookingStatus?: "confirmed" | "cancelled"; reservationStatus?: "active" | "cancelled"; email?: string;
      paymentMethod?: "online" | "pay_at_club"; payments?: ("succeeded" | "failed" | "pending")[] } = {}) {
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
    await insertBookingFixture({ id, reservation_id: reservationId,
      account_user_id: accountUserId, payment_method: options.paymentMethod ?? "pay_at_club", customer_name: "Snapshot Name", customer_email: options.email ?? "snapshot@example.test",
      customer_phone: "+40 123", cancellation_notice_minutes: 120, total_amount_minor: 9000, currency: "RON",
      status: options.bookingStatus ?? "confirmed" });
    for (const status of options.payments ?? []) {
      assert.strictEqual((await service.from("payment_attempts").insert({ id: randomUUID(), booking_id: id,
        method: "online", provider: "stripe", amount_minor: 9000, currency: "RON", status,
        expires_at: "2099-11-01T00:00:00Z", completed_at: status === "pending" ? null : now.toISOString(),
      })).error, null);
    }
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

    assert.strictEqual((await service.from("locations").update({ customer_cancellation_notice_minutes: 2880 })
      .eq("id", locationId)).error, null);
    const memberRows = await listOwnUpcomingCustomerBookings(member.client);
    expect(memberRows.map((row) => row.id)).toEqual([inProgress, future, nextFuture, lastFuture]);
    expect(memberRows[0]).toMatchObject({ customer_name: "Snapshot Name", customer_email: "snapshot@example.test",
      customer_phone: "+40 123", cancellation_notice_minutes: 120, total_amount_minor: 9000, currency: "RON" });
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
      const direct = (await listOwnUpcomingActivity({}, staff.client)).upcoming;
      expect(direct.map((row) => row.id)).toEqual([...ownReservations].reverse());
      expect(direct.every((row) => row.created_by_user_id === staff.id)).toBe(true);
    }
    const unpaid = await booking(member.id, "2099-11-01", 600, 660, { paymentMethod: "online" });
    const paid = await booking(member.id, "2099-11-02", 600, 660, { paymentMethod: "online", payments: ["succeeded"] });
    const paidTwice = await booking(member.id, "2099-11-03", 600, 660, { paymentMethod: "online", payments: ["succeeded", "succeeded"] });
    const failed = await booking(member.id, "2099-11-04", 600, 660, { paymentMethod: "online", payments: ["failed", "pending"] });
    const club = await booking(member.id, "2099-11-05", 600, 660);
    const cancelledPaid = await booking(member.id, "2099-11-06", 600, 660, { paymentMethod: "online",
      bookingStatus: "cancelled", reservationStatus: "cancelled", payments: ["succeeded"] });
    const cancelledUnpaid = await booking(member.id, "2099-11-07", 600, 660, { paymentMethod: "online",
      bookingStatus: "cancelled", reservationStatus: "cancelled", payments: ["failed"] });
    const manager = (await getDataSource()).manager;
    const reads = vi.spyOn(manager, "query");
    try {
      const onlineRows = await listOwnCourtActivity("upcoming", parseActivityQuery({ from: "2099-11-01" }, "upcoming"), member.client);
      expect(onlineRows.rows.map(row => row.id)).toEqual([paid, paidTwice, club]);
      expect(onlineRows.rows.map(row => row.id)).not.toContain(unpaid);
      expect(onlineRows.rows.map(row => row.id)).not.toContain(failed);
      const paymentReads = reads.mock.calls.filter(([sql]) => typeof sql === "string" && sql.includes("FROM public.payment_attempts"));
      expect(paymentReads).toHaveLength(1);
      expect(paymentReads[0][1]).toEqual([expect.arrayContaining([unpaid, paid, paidTwice, failed])]);
      expect(paymentReads[0][1]).toEqual([expect.not.arrayContaining([club])]);
      reads.mockClear();
      const cancelledRows = await listOwnCourtActivity("history", parseActivityQuery({ from: "2099-11-01" }, "history"), member.client);
      expect(cancelledRows.rows.map(row => row.id)).toEqual([cancelledPaid]);
      expect(cancelledRows.rows.map(row => row.id)).not.toContain(cancelledUnpaid);
      expect(reads.mock.calls.filter(([sql]) => typeof sql === "string" && sql.includes("FROM public.payment_attempts"))).toHaveLength(1);
    } finally { reads.mockRestore(); }
    expect((await listOwnUpcomingActivity({}, member.client)).upcoming).toEqual([]);
    expect((await member.client.from("bookings").select("id")).error?.code).toBe("42501");
  } finally {
    await cleanupBookingFixtures({ reservationIds });
    if (reservationIds.length) assert.strictEqual((await service.from("court_reservations").delete().in("id", reservationIds)).error, null);
    if (courtIds.length) assert.strictEqual((await service.from("courts").delete().in("id", courtIds)).error, null);
    assert.strictEqual((await service.from("locations").delete().eq("id", locationId)).error, null);
    await cleanupAuthFixtures(service, userIds);
  }
});
