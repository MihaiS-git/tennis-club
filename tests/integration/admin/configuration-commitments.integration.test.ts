import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { assert, expect, test } from "vitest";
import { saveAdminCourt } from "../../../src/lib/admin/courts";
import { saveAdminLocation, setAdminLocationArchived } from "../../../src/lib/admin/locations";
import { cleanupAuthFixtures, localFixtureClient } from "../auth-fixtures";
import { ensureIntegrationAdminAnchor } from "../admin-anchor";
import { cleanupBookingFixtures, insertBookingFixture, insertCheckoutFixture, readBookingContracts } from "../checkout-fixtures";
import { bounded, deferred } from "../concurrency";
import { getDataSource } from "../../../src/lib/db/data-source";
import { inTransaction } from "../../../src/lib/db/transaction";
import { lockConfigurationForRead, lockLocations } from "../../../src/lib/db/repositories/clubs.repository";

// Timezone, deactivation, archive and court moves must not hide or move occupancy that has not ended.
test("location and court changes are refused while future bookings, reservations, lessons or checkout holds remain", async () => {
  const service = localFixtureClient(), database = await getDataSource();
  await ensureIntegrationAdminAnchor(service);
  const userIds: string[] = [], password = "configuration-commitments-password-123", marker = `commitments-${randomUUID()}`;
  const [locationId, otherLocationId, court, spareCourt, program] = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  const gate = deferred(), fenced = deferred();
  let writer: Promise<unknown> | undefined;
  try {
    const email = `${marker}@example.test`;
    const created = await service.auth.admin.createUser({ email, password, email_confirm: true });
    assert.strictEqual(created.error, null); userIds.push(created.data.user!.id);
    const adminId = created.data.user!.id;
    assert.strictEqual((await service.from("user_roles").insert([{ user_id: adminId, role_code: "admin" }, { user_id: adminId, role_code: "coach" }])).error, null);
    const admin = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_PUBLISHABLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
    assert.strictEqual((await admin.auth.signInWithPassword({ email, password })).error, null);

    await database.query(`INSERT INTO public.locations(id,name,slug,timezone,currency,is_active) VALUES
      ($1::uuid,$3,($1::uuid)::text,'Europe/Bucharest','RON',true),($2::uuid,'Other location',($2::uuid)::text,'UTC','RON',false)`, [locationId, otherLocationId, marker]);
    // A historical destination must not anchor this single current location's zone.
    await database.query("UPDATE public.locations SET archived_at=now() WHERE id=$1", [otherLocationId]);
    assert.strictEqual((await service.from("courts").insert([
      { id: court, location_id: locationId, name: "Booked court", slug: "booked", surface: "clay", environment: "outdoor" },
      { id: spareCourt, location_id: locationId, name: "Spare court", slug: "spare", surface: "clay", environment: "outdoor" },
    ])).error, null);
    const fields = { name: marker, address_line1: "", address_line2: "", city: "", postal_code: "", country_code: "RO",
      timezone: "Europe/Bucharest", currency: "RON", is_active: true, is_public: false, display_order: 1, customer_cancellation_notice_minutes: 120 };
    const courtFields = { location_id: locationId, name: "Booked court", surface: "clay", environment: "outdoor", has_lighting: false, is_active: true };
    const saveLocation = (changes: Partial<typeof fields>) => saveAdminLocation({ id: locationId, fields: { ...fields, ...changes } }, admin);
    const saveCourt = (id: string, changes: Partial<typeof courtFields>) => saveAdminCourt({ id, fields: { ...courtFields,
      name: id === court ? "Booked court" : "Spare court", ...changes } }, admin);
    const archive = (archived: boolean) => setAdminLocationArchived({ id: locationId, archived }, admin);
    const locationRow = async () => (await database.query("SELECT name,timezone,is_active,archived_at FROM public.locations WHERE id=$1", [locationId]))[0];
    const courtRow = async (id: string) => (await database.query("SELECT name,location_id,is_active FROM public.courts WHERE id=$1", [id]))[0];
    const occupied = (text: string) => ({ ok: false, reason: "occupied", message: expect.stringContaining(text) });

    // A: without commitments every change remains available.
    expect(await saveLocation({ timezone: "Europe/London" })).toEqual({ ok: true, id: locationId });
    expect(await saveLocation({})).toEqual({ ok: true, id: locationId });
    expect(await saveLocation({ is_active: false })).toEqual({ ok: true, id: locationId });
    expect(await saveLocation({})).toEqual({ ok: true, id: locationId });
    expect(await saveCourt(court, { is_active: false })).toEqual({ ok: true, id: court });
    expect(await saveCourt(court, { location_id: otherLocationId })).toEqual({ ok: true, id: court });
    expect(await saveCourt(court, {})).toEqual({ ok: true, id: court });
    expect(await locationRow()).toMatchObject({ timezone: "Europe/Bucharest", is_active: true, archived_at: null });
    expect(await courtRow(court)).toMatchObject({ location_id: locationId, is_active: true });

    // B: a future court booking, coaching lesson and staff reservation on one court.
    await database.query(`INSERT INTO public.coaching_programs(id,name,description,program_type,court_rental_included,is_active)
      VALUES($1,$2,'','private',false,true)`, [program, marker]);
    await database.query(`INSERT INTO public.coach_profiles(user_id,display_name,bio,qualifications,specialties,languages)
      VALUES($1,'Commitments coach','','','{}','{}')`, [adminId]);
    const [courtReservation, lessonReservation, staffReservation] = [randomUUID(), randomUUID(), randomUUID()];
    const [courtBooking, lessonBooking] = [randomUUID(), randomUUID()];
    assert.strictEqual((await service.from("court_reservations").insert([
      { id: courtReservation, court_id: court, booking_date: "2099-05-01", starts_at_minute: 480, ends_at_minute: 540 },
      { id: lessonReservation, court_id: court, booking_date: "2099-05-01", starts_at_minute: 600, ends_at_minute: 660, coach_user_id: adminId },
      { id: staffReservation, court_id: court, booking_date: "2099-05-02", starts_at_minute: 600, ends_at_minute: 720, reason: "Clinic", created_by_user_id: adminId },
    ])).error, null);
    const terms = { account_user_id: null, customer_email: "commitments@example.test", customer_phone: "+40 700", status: "confirmed",
      total_amount_minor: 12000, currency: "RON", cancellation_notice_minutes: 120, payment_method: "pay_at_club" };
    await insertBookingFixture([{ ...terms, id: courtBooking, reservation_id: courtReservation, customer_name: "Court customer" },
      { ...terms, id: lessonBooking, reservation_id: lessonReservation, customer_name: "Lesson customer",
        coaching: { coach_user_id: adminId, coaching_program_id: program, coach_name: "Commitments coach", coaching_program_name: marker } }]);
    const contracts = await readBookingContracts(service, { ids: [courtBooking, lessonBooking] });
    const reservations = async () => database.query(`SELECT id,court_id,booking_date::text,starts_at_minute,ends_at_minute,status
      FROM public.court_reservations WHERE id=ANY($1::uuid[]) ORDER BY id`, [[courtReservation, lessonReservation, staffReservation]]);
    const reservationsBefore = await reservations();
    const remaining = "(1 court booking, 1 coaching booking, 1 staff reservation)";

    // Each refusal names the commitments and rolls back the whole update, including other fields.
    expect(await saveLocation({ name: `Renamed ${marker}`, timezone: "Europe/London" }))
      .toEqual(occupied(`The timezone cannot be changed while this location has unfinished bookings ${remaining}`));
    expect(await saveLocation({ name: `Renamed ${marker}`, is_active: false }))
      .toEqual(occupied(`This location cannot be deactivated while it has unfinished bookings ${remaining}`));
    expect(await archive(true)).toEqual(occupied(`This location cannot be archived while it has unfinished bookings ${remaining}`));
    expect(await locationRow()).toEqual({ name: marker, timezone: "Europe/Bucharest", is_active: true, archived_at: null });
    expect(await saveCourt(court, { name: "Renamed court", is_active: false }))
      .toEqual(occupied(`This court cannot be deactivated while it has unfinished bookings ${remaining}`));
    expect(await saveCourt(court, { name: "Renamed court", location_id: otherLocationId }))
      .toEqual(occupied(`This court cannot be moved to another location while it has unfinished bookings ${remaining}`));
    expect(await courtRow(court)).toEqual({ name: "Booked court", location_id: locationId, is_active: true });

    // Unrelated edits, and changes to a court without commitments, still save.
    expect(await saveLocation({ name: `Renamed ${marker}`, customer_cancellation_notice_minutes: 60 })).toEqual({ ok: true, id: locationId });
    fields.name = `Renamed ${marker}`; fields.customer_cancellation_notice_minutes = 60;
    expect(await saveCourt(court, { has_lighting: true })).toEqual({ ok: true, id: court });
    courtFields.has_lighting = true;
    expect(await saveCourt(spareCourt, { is_active: false })).toEqual({ ok: true, id: spareCourt });
    expect(await saveCourt(spareCourt, { location_id: otherLocationId, is_active: false })).toEqual({ ok: true, id: spareCourt });
    expect(await courtRow(spareCourt)).toMatchObject({ location_id: otherLocationId, is_active: false });
    expect(await readBookingContracts(service, { ids: [courtBooking, lessonBooking] })).toEqual(contracts);
    expect(await reservations()).toEqual(reservationsBefore);

    // C: ended bookings are history and no longer block; their records are preserved.
    await database.query("UPDATE public.court_reservations SET booking_date='2020-05-01' WHERE id=ANY($1::uuid[])", [[courtReservation, lessonReservation]]);
    await database.query("UPDATE public.court_reservations SET status='cancelled',cancelled_at=now(),cancelled_by_user_id=$2 WHERE id=$1", [staffReservation, adminId]);

    // D: a live checkout hold blocks too, with the unresolved payment for a timezone change.
    const checkout = await insertCheckoutFixture({ courtId: court, bookingDate: "2099-05-03", startMinute: 480, endMinute: 540, accountUserId: null,
      customerName: "Checkout customer", customerEmail: "checkout@example.test", customerPhone: "+40 700", totalAmountMinor: 6000,
      currency: "RON", paymentMethod: "online", provider: "stripe", holdSeconds: 600 });
    const timezoneRefusal = await saveLocation({ timezone: "Europe/London" });
    expect(timezoneRefusal).toEqual(occupied("unfinished bookings (1 pending checkout)"));
    expect(timezoneRefusal).toEqual(occupied("before changing the timezone"));
    expect(await saveCourt(court, { is_active: false })).toEqual(occupied("This court cannot be deactivated while it has unfinished bookings (1 pending checkout)"));
    expect(await archive(true)).toEqual(occupied("(1 pending checkout)"));
    expect(await locationRow()).toMatchObject({ timezone: "Europe/Bucharest", is_active: true, archived_at: null });
    expect((await service.from("checkout_records").select("status").eq("id", checkout.booking_id).single()).data?.status).toBe("pending_payment");

    // The expired unpaid hold is released by the update itself; then the change commits.
    await inTransaction(async (manager) => {
      await manager.query("ALTER TABLE public.payment_attempts DISABLE TRIGGER payment_attempts_immutable");
      await manager.query("UPDATE public.payment_attempts SET expires_at=now()-interval '1 minute' WHERE id=$1", [checkout.payment_attempt_id]);
      await manager.query("ALTER TABLE public.payment_attempts ENABLE TRIGGER payment_attempts_immutable");
      await manager.query("UPDATE public.court_reservations SET hold_expires_at=now()-interval '1 minute' WHERE id=$1", [checkout.reservation_id]);
    });
    expect(await saveLocation({ timezone: "Europe/London" })).toEqual({ ok: true, id: locationId });
    expect((await service.from("checkout_records").select("status").eq("id", checkout.booking_id).single()).data?.status).toBe("expired");
    expect(await saveLocation({})).toEqual({ ok: true, id: locationId });
    expect(await saveCourt(court, { is_active: false })).toEqual({ ok: true, id: court });
    expect(await saveCourt(court, {})).toEqual({ ok: true, id: court });
    expect(await readBookingContracts(service, { ids: [courtBooking, lessonBooking] })).toEqual(contracts);

    // E: a booking writer holding the shared configuration fence serializes the court decision.
    writer = inTransaction(async (manager) => {
      await lockConfigurationForRead(manager);
      await lockLocations(manager, [locationId]);
      await manager.query(`INSERT INTO public.court_reservations(court_id,booking_date,starts_at_minute,ends_at_minute,reason,created_by_user_id)
        VALUES($1,'2099-06-01',480,540,'Concurrent',$2)`, [court, adminId]);
      fenced.resolve();
      await gate.promise;
    });
    await bounded(fenced.promise, "concurrent reservation");
    const change = saveCourt(court, { is_active: false });
    let decided = false;
    void change.then(() => { decided = true; }, () => { decided = true; });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(decided).toBe(false);
    gate.resolve();
    await bounded(writer, "concurrent reservation commit");
    expect(await bounded(change, "court decision")).toEqual(occupied("(1 staff reservation)"));
    expect(await courtRow(court)).toMatchObject({ is_active: true });

    // F: once the reservation is cancelled the location archives; history keeps its contracts.
    await database.query("UPDATE public.court_reservations SET status='cancelled',cancelled_at=now(),cancelled_by_user_id=$2 WHERE court_id=$1 AND reason='Concurrent'", [court, adminId]);
    expect(await archive(true)).toEqual({ ok: true, id: locationId });
    expect(await locationRow()).toMatchObject({ is_active: false, archived_at: expect.any(Date) });
    expect(await readBookingContracts(service, { ids: [courtBooking, lessonBooking] })).toEqual(contracts);
  } finally {
    gate.resolve();
    await writer?.catch(() => {});
    await cleanupBookingFixtures({ courtIds: [court, spareCourt] });
    await database.query("DELETE FROM public.court_reservations WHERE court_id=ANY($1::uuid[])", [[court, spareCourt]]);
    await database.query("DELETE FROM public.courts WHERE id=ANY($1::uuid[])", [[court, spareCourt]]);
    await database.query("DELETE FROM public.locations WHERE id=ANY($1::uuid[])", [[locationId, otherLocationId]]);
    await database.query("DELETE FROM public.coach_profiles WHERE user_id=ANY($1::uuid[])", [userIds]);
    await database.query("DELETE FROM public.coaching_programs WHERE id=$1", [program]);
    await cleanupAuthFixtures(service, userIds);
  }
}, 30000);
