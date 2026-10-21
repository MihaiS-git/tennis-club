import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { expect, test } from "vitest";
import { parseCoachBookingQuery } from "@/lib/bookings/admin-query";
import { getCoachDirectReservation, getCoachLesson, listCoachBookings } from "@/lib/bookings/coach-bookings";
import { getDataSource } from "@/lib/db/data-source";
import { cancelOwnDirectReservation } from "@/lib/reservations/personal-service";
import { cancelDirectReservationAsAdmin, getReservationDay } from "@/lib/reservations/service";
import { cleanupAuthFixtures, localFixtureClient } from "./auth-fixtures";
import { ensureIntegrationAdminAnchor } from "./admin-anchor";
import { cleanupBookingFixtures, insertBookingFixture } from "./checkout-fixtures";

test("Coaches list and open only their own lessons and staff reservations, enforced in the database query and services", async () => {
  const db = localFixtureClient(), database = await getDataSource(), users: string[] = [];
  const session = () => createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_PUBLISHABLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
  const [coachA, coachB] = [session(), session()];
  const marker = `coachlist-${randomUUID()}`, password = "coach-bookings-test-password-123";
  const [location, court, program] = [randomUUID(), randomUUID(), randomUUID()];
  // Lessons: A confirmed, A cancelled, A payment pending, B confirmed, plus an uncoached court booking.
  const lessonKeys = ["aConfirmed", "aCancelled", "aPending", "bConfirmed", "court"] as const;
  const lessonReservations = Object.fromEntries(lessonKeys.map((key) => [key, randomUUID()])) as Record<typeof lessonKeys[number], string>;
  const lessons = Object.fromEntries(lessonKeys.map((key) => [key, randomUUID()])) as Record<typeof lessonKeys[number], string>;
  const [ownActive, ownCancelled, otherActive] = [randomUUID(), randomUUID(), randomUUID()];
  const query = (params: Record<string, string> = {}) => parseCoachBookingQuery({ location, ...params });
  const ids = (rows: { id: string }[]) => rows.map((row) => row.id).sort();
  try {
    await ensureIntegrationAdminAnchor(db);
    for (const [index, client] of [coachA, coachB].entries()) {
      const email = `${marker}-${index}@example.test`;
      const auth = await db.auth.admin.createUser({ email, password, email_confirm: true });
      expect(auth.error).toBeNull(); users.push(auth.data.user!.id);
      expect((await db.from("user_roles").insert({ user_id: users[index], role_code: "coach" })).error).toBeNull();
      expect((await client.auth.signInWithPassword({ email, password })).error).toBeNull();
    }
    const [a, b] = users;
    await database.query(`INSERT INTO public.coaching_programs(id,name,description,program_type,court_rental_included,is_active)
      VALUES($1,'Coach list private','','private',false,true)`, [program]);
    await database.query(`INSERT INTO public.coach_profiles(user_id,display_name,bio,qualifications,specialties,languages,is_public)
      VALUES($1,'Coach A','','','{}','{}',true),($2,'Coach B','','','{}','{}',true)`, [a, b]);
    expect((await db.from("locations").insert({ id: location, name: "Coach list club", slug: marker, timezone: "UTC", currency: "RON",
      is_active: true, archived_at: null })).error).toBeNull();
    expect((await db.from("courts").insert({ id: court, location_id: location, name: "Court C", slug: "c", environment: "outdoor",
      surface: "clay", is_active: true })).error).toBeNull();
    const open = { cancelled_at: null, cancelled_by_user_id: null, reason: null, created_by_user_id: null };
    const coachFor = { aConfirmed: a, aCancelled: a, aPending: a, bConfirmed: b, court: null };
    expect((await db.from("court_reservations").insert([
      ...lessonKeys.map((key, index) => ({ ...open, id: lessonReservations[key], court_id: court, booking_date: "2099-04-01",
        starts_at_minute: 480 + index * 60, ends_at_minute: 540 + index * 60, coach_user_id: coachFor[key],
        status: key === "aCancelled" ? "cancelled" : "active", ...(key === "aCancelled" ? { cancelled_at: "2026-09-01T10:00:00Z", cancelled_by_user_id: a } : {}) })),
      { ...open, id: ownActive, court_id: court, booking_date: "2099-04-02", starts_at_minute: 600, ends_at_minute: 720, coach_user_id: null,
        reason: "A clinic", created_by_user_id: a, status: "active" },
      { ...open, id: ownCancelled, court_id: court, booking_date: "2099-04-02", starts_at_minute: 720, ends_at_minute: 780, coach_user_id: null,
        reason: "A old plan", created_by_user_id: a, status: "cancelled", cancelled_at: "2026-09-02T10:00:00Z", cancelled_by_user_id: a },
      { ...open, id: otherActive, court_id: court, booking_date: "2099-04-03", starts_at_minute: 600, ends_at_minute: 660, coach_user_id: null,
        reason: "B clinic", created_by_user_id: b, status: "active" },
    ])).error).toBeNull();
    const status = { aConfirmed: "confirmed", aCancelled: "cancelled", aPending: "pending_payment", bConfirmed: "confirmed", court: "confirmed" };
    expect((await insertBookingFixture(db, lessonKeys.map((key) => ({ id: lessons[key], reservation_id: lessonReservations[key],
      account_user_id: null, customer_name: `${marker} ${key}`, customer_email: `${key}@example.test`, customer_phone: "+40 700",
      status: status[key], total_amount_minor: 12000, currency: "RON", cancellation_notice_minutes: 120, payment_method: "online",
      ...(coachFor[key] ? { coaching: { coach_user_id: coachFor[key], coaching_program_id: program,
        coach_name: key.startsWith("a") ? "Coach A" : "Coach B", coaching_program_name: "Coach list private" } } : {}) })))).error).toBeNull();

    // Coach A: own confirmed and cancelled lessons and own staff reservations only.
    const own = await listCoachBookings(query(), coachA);
    expect(own.total).toBe(4);
    expect(ids(own.rows)).toEqual([lessons.aConfirmed, lessons.aCancelled, ownActive, ownCancelled].sort());
    for (const row of own.rows) {
      expect(row).not.toHaveProperty("total_amount_minor"); expect(row).not.toHaveProperty("account_user_id");
    }
    expect(own.rows.find((row) => row.id === lessons.aConfirmed)).toMatchObject({ kind: "booking", status: "confirmed",
      customer_name: `${marker} aConfirmed`, coach_name: "Coach A", coaching_program_name: "Coach list private" });
    expect(ids((await listCoachBookings(query({ type: "coaching" }), coachA)).rows)).toEqual([lessons.aConfirmed, lessons.aCancelled].sort());
    expect(ids((await listCoachBookings(query({ type: "reservation" }), coachA)).rows)).toEqual([ownActive, ownCancelled].sort());
    expect(ids((await listCoachBookings(query({ status: "active" }), coachA)).rows)).toEqual([ownActive]);
    expect(ids((await listCoachBookings(query({ status: "cancelled" }), coachA)).rows)).toEqual([lessons.aCancelled, ownCancelled].sort());
    // Forged scope widening: court type, Coach filter or checkout statuses never reach other records.
    expect((await listCoachBookings(query({ type: "court" }), coachA)).total).toBe(4);
    expect((await listCoachBookings(query({ type: "coaching", coach: b }), coachA)).total).toBe(2);
    expect((await listCoachBookings(query({ status: "pending_payment" }), coachA)).total).toBe(4);
    expect((await listCoachBookings(parseCoachBookingQuery({ q: lessons.bConfirmed }), coachA)).total).toBe(0);
    expect((await listCoachBookings(parseCoachBookingQuery({ q: "B CLINIC" }), coachA)).total).toBe(0);
    expect(ids((await listCoachBookings(parseCoachBookingQuery({ q: `${marker} ACONF` }), coachA)).rows)).toEqual([lessons.aConfirmed]);
    expect((await listCoachBookings(query({ sort: "scheduled", dir: "asc" }), coachA)).rows.map((row) => row.id))
      .toEqual([lessons.aConfirmed, lessons.aCancelled, ownActive, ownCancelled]);

    // Coach B sees only their own lesson and reservation.
    expect(ids((await listCoachBookings(query(), coachB)).rows)).toEqual([lessons.bConfirmed, otherActive].sort());

    // Calendar: full occupancy, own lesson contact only, and nothing about other customers or the other Coach's lessons.
    const calendar = { id: location, name: "Coach list club", timezone: "UTC", courts: [{ id: court, name: "Court C" }] };
    const occupied = (start: number) => ({ kind: "occupied", id: `occupied:${court}:${start}`, court_id: court, booking_date: "2099-04-01",
      starts_at_minute: start, ends_at_minute: start + 60 });
    const lessonFor = (key: "aConfirmed" | "bConfirmed", coach: string, start: number, name: string) => ({ kind: "lesson", id: lessons[key], court_id: court,
      booking_date: "2099-04-01", starts_at_minute: start, ends_at_minute: start + 60, coach_user_id: coach, coach_name: name,
      coaching_program_name: "Coach list private", customer_name: `${marker} ${key}`, customer_email: `${key}@example.test`, customer_phone: "+40 700" });
    const calendarNow = new Date("2026-10-01T00:00:00Z");
    for (const [client, own, ownStart, name, other, otherStart] of [[coachA, "aConfirmed", 480, "Coach A", "bConfirmed", 660],
      [coachB, "bConfirmed", 660, "Coach B", "aConfirmed", 480]] as const) {
      const day = await getReservationDay(calendar, "2099-04-01", calendarNow, client);
      expect(day.occupancy.map((item) => item.starts_at_minute)).toEqual([480, 600, 660, 720]);
      expect(day.adminOccupancy).toEqual(expect.arrayContaining([lessonFor(own, own === "aConfirmed" ? a : b, ownStart, name),
        occupied(otherStart), occupied(720)]));
      const response = JSON.stringify(day);
      for (const leaked of [lessons[other], lessons.court, `${marker} ${other}`, `${other}@example.test`, `${marker} court`, "court@example.test",
        "online", "12000", "RON", "payment", "total_amount_minor", "account_user_id", other === "bConfirmed" ? b : a])
        expect(response).not.toContain(leaked);
    }

    // Details: own records only; another Coach's records, checkout state and court bookings are not found.
    expect(await getCoachLesson(lessons.aConfirmed, coachA)).toMatchObject({ id: lessons.aConfirmed, customer_phone: "+40 700",
      location_name: "Coach list club", court_name: "Court C", starts_at_minute: 480 });
    expect(await getCoachLesson(lessons.aCancelled, coachA)).toMatchObject({ status: "cancelled" });
    for (const id of [lessons.bConfirmed, lessons.aPending, lessons.court, ownActive]) expect(await getCoachLesson(id, coachA)).toBeNull();
    expect(await getCoachDirectReservation(ownActive, coachA, new Date("2099-04-02T11:00:00Z")))
      .toMatchObject({ reservation: { id: ownActive, reason: "A clinic" }, started: true, editable: true, cancellable: true });
    for (const id of [otherActive, lessonReservations.aConfirmed, lessons.aConfirmed]) expect(await getCoachDirectReservation(id, coachA)).toBeNull();

    // Actions keep the existing ownership rules; the Admin command stays Admin-only.
    expect(await cancelOwnDirectReservation(otherActive, coachA)).toMatchObject({ ok: false });
    await expect(cancelDirectReservationAsAdmin(otherActive, coachA)).rejects.toThrow();
    expect(await getCoachDirectReservation(otherActive, coachB)).toMatchObject({ reservation: { status: "active" } });
    expect(await cancelOwnDirectReservation(ownActive, coachA)).toEqual({ ok: true });
    expect(ids((await listCoachBookings(query({ type: "reservation", status: "cancelled" }), coachA)).rows)).toEqual([ownActive, ownCancelled].sort());
    expect(await getCoachDirectReservation(ownActive, coachA)).toMatchObject({ reservation: { status: "cancelled", cancelled_by_user_id: a },
      editable: false, cancellable: false });

    // Without the coach role, every Coach read is denied.
    expect((await db.from("user_roles").delete().eq("user_id", a).eq("role_code", "coach")).error).toBeNull();
    await expect(listCoachBookings(query(), coachA)).rejects.toThrow();
    await expect(getCoachLesson(lessons.aConfirmed, coachA)).rejects.toThrow();
    await expect(getCoachDirectReservation(ownCancelled, coachA)).rejects.toThrow();
  } finally {
    await cleanupBookingFixtures({ bookingIds: Object.values(lessons) });
    await db.from("court_reservations").delete().in("id", [...Object.values(lessonReservations), ownActive, ownCancelled, otherActive]);
    await database.query("DELETE FROM public.coach_profiles WHERE user_id=ANY($1::uuid[])", [users]);
    await database.query("DELETE FROM public.coaching_programs WHERE id=$1", [program]);
    await db.from("courts").delete().eq("id", court); await db.from("locations").delete().eq("id", location);
    await cleanupAuthFixtures(db, users);
  }
}, 30000);
