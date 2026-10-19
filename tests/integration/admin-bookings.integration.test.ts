import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { expect, test } from "vitest";
import { getDataSource } from "@/lib/db/data-source";
import { findAdminBookingDetails } from "@/lib/db/repositories/bookings.repository";
import { listAdminBookings } from "@/lib/bookings/admin-details";
import { parseAdminBookingQuery } from "@/lib/bookings/admin-query";
import { cleanupAuthFixtures, localFixtureClient } from "./auth-fixtures";
import { ensureIntegrationAdminAnchor } from "./admin-anchor";
import { cleanupBookingFixtures, insertBookingFixture } from "./checkout-fixtures";

test("Admin bookings list guest, account, cancelled and historical bookings with database filters, search, sorting and pagination", async () => {
  const db = localFixtureClient(), users: string[] = [];
  const admin = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_PUBLISHABLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
  const marker = `bookings-${randomUUID()}`;
  const [central, archived] = [randomUUID(), randomUUID()], [courtA, courtB, oldCourt] = [randomUUID(), randomUUID(), randomUUID()];
  // 23 bookings: 0–19 Central/Court A confirmed, 20 Court B cancelled account booking, 21 archived historical guest, 22 pending.
  const reservationIds = Array.from({ length: 23 }, () => randomUUID()), bookingIds = reservationIds.map(() => randomUUID());
  const courtFor = (index: number) => index === 20 ? courtB : index === 21 ? oldCourt : courtA;
  const dateFor = (index: number) => index === 21 ? "2020-03-01" : `2099-01-${String(23 - index).padStart(2, "0")}`;
  const query = (params: Record<string, string> = {}) => parseAdminBookingQuery({ q: marker, ...params });
  try {
    await ensureIntegrationAdminAnchor(db);
    const email = `${marker}@example.test`, password = "bookings-read-test-password-123";
    const auth = await db.auth.admin.createUser({ email, password, email_confirm: true });
    expect(auth.error).toBeNull(); users.push(auth.data.user!.id);
    expect((await db.from("user_roles").insert({ user_id: users[0], role_code: "admin" })).error).toBeNull();
    expect((await admin.auth.signInWithPassword({ email, password })).error).toBeNull();
    expect((await db.from("locations").insert([{ id: central, name: "Bookings central", slug: `${marker}-c`, timezone: "UTC", currency: "RON", is_active: true, archived_at: null },
      { id: archived, name: "Bookings archived", slug: `${marker}-a`, timezone: "UTC", currency: "RON", is_active: false, archived_at: "2021-01-01T00:00:00Z" }])).error).toBeNull();
    expect((await db.from("courts").insert([{ id: courtA, location_id: central, name: "Court A", slug: "a", environment: "outdoor", surface: "clay", is_active: true },
      { id: courtB, location_id: central, name: "Court B", slug: "b", environment: "outdoor", surface: "clay", is_active: true },
      { id: oldCourt, location_id: archived, name: "Old court", slug: "old", environment: "outdoor", surface: "clay", is_active: false }])).error).toBeNull();
    expect((await db.from("court_reservations").insert(reservationIds.map((id, index) => ({ id, court_id: courtFor(index),
      booking_date: dateFor(index), starts_at_minute: 600, ends_at_minute: 660, status: index === 20 ? "cancelled" : "active",
      cancelled_at: index === 20 ? "2026-10-06T10:00:00Z" : null, cancelled_by_user_id: index === 20 ? users[0] : null })))).error).toBeNull();
    expect((await insertBookingFixture(db, bookingIds.map((id, index) => ({ id, reservation_id: reservationIds[index],
      account_user_id: index === 20 ? users[0] : null,
      customer_name: index === 21 ? `${marker} Historic Guest` : `${marker} Customer ${index}`,
      customer_email: `${marker}-${index}@example.test`, customer_phone: "123",
      status: index === 20 ? "cancelled" : index === 22 ? "pending_payment" : "confirmed", total_amount_minor: 1000 + index, currency: "RON",
      cancellation_notice_minutes: 1440, payment_method: "online", created_at: `2026-09-${String(index + 1).padStart(2, "0")}T10:00:00Z` })))).error).toBeNull();

    const first = await listAdminBookings(query(), admin), second = await listAdminBookings(query({ page: "2" }), admin);
    expect(first).toMatchObject({ total: 23, totalPages: 2, page: 1 }); expect(first.rows).toHaveLength(20); expect(second.rows).toHaveLength(3);
    // Newest-created first, with no duplicates across pages.
    expect([...first.rows, ...second.rows].map((row) => row.id)).toEqual([...bookingIds].reverse());
    expect(first.rows.find((row) => row.id === bookingIds[20])).toMatchObject({ status: "cancelled", account_user_id: users[0],
      court_name: "Court B", location_id: central, total_amount_minor: 1020, currency: "RON" });
    expect(first.rows.find((row) => row.id === bookingIds[21])).toMatchObject({ account_user_id: null, location_name: "Bookings archived",
      court_name: "Old court", booking_date: "2020-03-01" });
    expect(await listAdminBookings(query({ page: "99" }), admin)).toMatchObject({ page: 2, rows: second.rows });

    expect((await listAdminBookings(query({ status: "cancelled" }), admin)).rows.map((row) => row.id)).toEqual([bookingIds[20]]);
    expect((await listAdminBookings(query({ status: "pending_payment" }), admin)).rows.map((row) => row.id)).toEqual([bookingIds[22]]);
    expect((await listAdminBookings(query({ location: archived }), admin)).rows.map((row) => row.id)).toEqual([bookingIds[21]]);
    expect((await listAdminBookings(query({ location: central }), admin)).total).toBe(22);
    expect((await listAdminBookings(query({ location: central, court: courtB }), admin)).rows.map((row) => row.id)).toEqual([bookingIds[20]]);
    // A court from another location yields nothing rather than widening the filter.
    expect((await listAdminBookings(query({ location: central, court: oldCourt }), admin)).total).toBe(0);
    expect((await listAdminBookings(query({ from: "2099-01-01", to: "2099-01-03" }), admin)).rows.map((row) => row.id))
      .toEqual([bookingIds[22], bookingIds[20]]);
    expect((await listAdminBookings(query({ to: "2021-01-01" }), admin)).rows.map((row) => row.id)).toEqual([bookingIds[21]]);
    const scheduled = await listAdminBookings(query({ sort: "scheduled", dir: "asc" }), admin);
    expect(scheduled.rows[0].id).toBe(bookingIds[21]); expect(scheduled.rows[1].id).toBe(bookingIds[22]);
    expect((await listAdminBookings(query({ dir: "asc" }), admin)).rows[0].id).toBe(bookingIds[0]);

    expect((await listAdminBookings(parseAdminBookingQuery({ q: bookingIds[5].slice(0, 13).toUpperCase() }), admin)).rows.map((row) => row.id)).toContain(bookingIds[5]);
    expect((await listAdminBookings(parseAdminBookingQuery({ q: bookingIds[5] }), admin)).rows.map((row) => row.id)).toEqual([bookingIds[5]]);
    expect((await listAdminBookings(parseAdminBookingQuery({ q: `${marker} historic` }), admin)).rows.map((row) => row.id)).toEqual([bookingIds[21]]);
    expect((await listAdminBookings(parseAdminBookingQuery({ q: `${marker}-7@EXAMPLE.test` }), admin)).rows.map((row) => row.id)).toEqual([bookingIds[7]]);
    expect((await listAdminBookings(query({ q: "%" }), admin)).total).toBe(0);

    // Details are ownership-independent current snapshots, including cancelled and archived-resource bookings.
    const manager = (await getDataSource()).manager;
    expect(await findAdminBookingDetails(manager, bookingIds[20])).toMatchObject({ id: bookingIds[20], status: "cancelled",
      account_user_id: users[0], customer_email: `${marker}-20@example.test`, payment_method: "online", created_at: expect.stringMatching(/^2026-09-21T10:00:00/) });
    expect(await findAdminBookingDetails(manager, bookingIds[21])).toMatchObject({ account_user_id: null, location_name: "Bookings archived",
      court_name: "Old court", booking_date: "2020-03-01", total_amount_minor: 1021 });
    expect(await findAdminBookingDetails(manager, randomUUID())).toBeNull();

    // Losing the Admin role, or suspension, denies the list before any rows are returned.
    expect((await db.from("user_roles").delete().eq("user_id", users[0]).eq("role_code", "admin")).error).toBeNull();
    await expect(listAdminBookings(query(), admin)).rejects.toThrow();
    expect((await db.from("user_roles").insert({ user_id: users[0], role_code: "admin" })).error).toBeNull();
    expect((await db.from("users").update({ status: "suspended" }).eq("id", users[0])).error).toBeNull();
    await expect(listAdminBookings(query(), admin)).rejects.toThrow();
  } finally {
    await db.from("users").update({ status: "active" }).in("id", users);
    await cleanupBookingFixtures({ bookingIds });
    await db.from("court_reservations").delete().in("id", reservationIds);
    await db.from("courts").delete().in("id", [courtA, courtB, oldCourt]); await db.from("locations").delete().in("id", [central, archived]);
    await cleanupAuthFixtures(db, users);
  }
}, 30000);
