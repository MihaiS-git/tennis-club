import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { assert, expect, test } from "vitest";
import { listOwnCourtHistory } from "@/lib/bookings/history-service";
import { cleanupAuthFixtures, localFixtureClient } from "./auth-fixtures";

test("mixed history is owner scoped, time zone aware, globally ordered and paged", async () => {
  const service = localFixtureClient();
  const locationId = randomUUID();
  const courts: string[] = [], reservations: string[] = [], bookings: string[] = [], users: string[] = [];
  const now = new Date("2026-10-03T11:30:00Z"); // 01:30 on 4 October in Kiritimati
  const password = "history-test-password-123";
  async function account(role?: "admin" | "coach") {
    const email = `history-${randomUUID()}@example.test`;
    const result = await service.auth.admin.createUser({ email, password, email_confirm: true });
    assert.strictEqual(result.error, null); assert.ok(result.data.user);
    users.push(result.data.user.id);
    if (role) assert.strictEqual((await service.from("user_roles").insert({ user_id: result.data.user.id, role_code: role })).error, null);
    const client = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_PUBLISHABLE_KEY!, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    assert.strictEqual((await client.auth.signInWithPassword({ email, password })).error, null);
    return { id: result.data.user.id, email, client };
  }
  async function activity(input: { owner: string | null; date: string; kind: "booking" | "reservation";
    status?: "confirmed" | "cancelled"; email?: string; start?: number; end?: number }) {
    const courtId = randomUUID(), reservationId = randomUUID();
    courts.push(courtId); reservations.push(reservationId);
    assert.strictEqual((await service.from("courts").insert({ id: courtId, location_id: locationId,
      name: `Court ${courts.length}`, slug: `court-${courts.length}`, surface: "clay", environment: "outdoor" })).error, null);
    assert.strictEqual((await service.from("court_reservations").insert({ id: reservationId, court_id: courtId,
      booking_date: input.date, starts_at_minute: input.start ?? 600, ends_at_minute: input.end ?? 660,
      created_by_user_id: input.kind === "reservation" ? input.owner : null,
      reason: input.kind === "reservation" ? "Training" : null })).error, null);
    if (input.kind === "reservation") return reservationId;
    const id = randomUUID(); bookings.push(id);
    assert.strictEqual((await service.from("bookings").insert({ id, reservation_id: reservationId,
      account_user_id: input.owner, payment_method: "pay_at_club", customer_name: "Stored Customer", customer_email: input.email ?? "stored@example.test",
      customer_phone: "+40 999", cancellation_notice_minutes: 120, total_amount_minor: 9000, currency: "RON", status: input.status ?? "confirmed" })).error, null);
    return id;
  }
  try {
    assert.strictEqual((await service.from("locations").insert({ id: locationId, name: "History fixture",
      slug: `history-${locationId}`, timezone: "Pacific/Kiritimati", currency: "RON" })).error, null);
    const member = await account(), other = await account(), admin = await account("admin"), coach = await account("coach");
    const expected: { kind: string; id: string }[] = [];
    for (let day = 1; day <= 22; day++) {
      const kind = day % 2 ? "booking" : "reservation";
      const id = await activity({ owner: admin.id, date: `2026-09-${String(day).padStart(2, "0")}`, kind: kind as "booking" | "reservation" });
      expected.unshift({ kind, id });
    }
    const tiedBooking = await activity({ owner: admin.id, date: "2026-09-22", kind: "booking" });
    expected.unshift({ kind: "booking", id: tiedBooking });
    const memberElapsed = await activity({ owner: member.id, date: "2026-10-04", kind: "booking", start: 0, end: 60 });
    const memberFuture = await activity({ owner: member.id, date: "2026-10-04", kind: "booking", start: 120, end: 180 });
    const memberCancelled = await activity({ owner: member.id, date: "2026-10-05", kind: "booking", status: "cancelled" });
    const otherBooking = await activity({ owner: other.id, date: "2026-09-25", kind: "booking" });
    const guest = await activity({ owner: null, date: "2026-09-26", kind: "booking", email: member.email });
    const coachReservation = await activity({ owner: coach.id, date: "2026-09-27", kind: "reservation" });
    const adminOwnBooking = await activity({ owner: admin.id, date: "2026-09-28", kind: "booking" });
    assert.strictEqual((await service.from("locations").update({ customer_cancellation_notice_minutes: 2880 })
      .eq("id", locationId)).error, null);
    const memberHistory = await listOwnCourtHistory(1, member.client, now);
    expect(memberHistory.rows.map((row) => row.id).sort()).toEqual([memberElapsed, memberCancelled].sort());
    expect(memberHistory.rows.map((row) => row.id)).not.toContain(memberFuture);
    expect(memberHistory.rows.map((row) => row.id)).not.toContain(otherBooking);
    expect(memberHistory.rows.map((row) => row.id)).not.toContain(guest);
    expect(memberHistory.rows.find((row) => row.id === memberElapsed)).toMatchObject({ kind: "booking", status: "confirmed",
      customer_name: "Stored Customer", customer_email: "stored@example.test", customer_phone: "+40 999",
      cancellation_notice_minutes: 120, total_amount_minor: 9000, currency: "RON" });
    const first = await listOwnCourtHistory(1, admin.client, now);
    const second = await listOwnCourtHistory(2, admin.client, now);
    expect(first.rows).toHaveLength(20); expect(first.hasNext).toBe(true);
    expect(first.rows[0]).toMatchObject({ kind: "booking", id: adminOwnBooking });
    expect([...first.rows.slice(1), ...second.rows].map((row) => ({ kind: row.kind, id: row.id }))).toEqual(expected);
    expect(second.rows).toHaveLength(4); expect(second.hasNext).toBe(false);
    expect((await listOwnCourtHistory(3, admin.client, now)).rows).toEqual([]);
    expect((await listOwnCourtHistory(1, coach.client, now)).rows.map((row) => row.id)).toEqual([coachReservation]);
    expect((await listOwnCourtHistory(1, other.client, now)).rows.map((row) => row.id)).toEqual([otherBooking]);
    expect((await member.client.from("bookings").select("id")).error?.code).toBe("42501");
    await expect(listOwnCourtHistory(0, member.client, now)).rejects.toThrow("Choose a valid history page.");
  } finally {
    if (bookings.length) assert.strictEqual((await service.from("bookings").delete().in("id", bookings)).error, null);
    if (reservations.length) assert.strictEqual((await service.from("court_reservations").delete().in("id", reservations)).error, null);
    if (courts.length) assert.strictEqual((await service.from("courts").delete().in("id", courts)).error, null);
    assert.strictEqual((await service.from("locations").delete().eq("id", locationId)).error, null);
    await cleanupAuthFixtures(service, users);
  }
}, 60000);
