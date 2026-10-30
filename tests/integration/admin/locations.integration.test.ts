import { insertOpeningHoursFixture } from "../opening-hours-fixtures";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { assert, expect, test } from "vitest";
import { listAdminLocations, listAdminLocationsWithReadiness, readAdminLocationCurrencyChange, saveAdminLocation, setAdminLocationArchived, setAdminLocationPublication } from "../../../src/lib/admin/locations";
import { listPublicLocationsWithCourts } from "../../../src/lib/courts/public";
import { cleanupAuthFixtures, localFixtureClient } from "../auth-fixtures";
import { ensureIntegrationAdminAnchor } from "../admin-anchor";
import { cleanupBookingFixtures, insertBookingFixture, insertCheckoutFixture, readBookingContracts } from "../checkout-fixtures";
import { bounded, deferred } from "../concurrency";
import { getDataSource } from "../../../src/lib/db/data-source";
import { inTransaction } from "../../../src/lib/db/transaction";
import { lockConfigurationForRead, lockLocations } from "../../../src/lib/db/repositories/clubs.repository";

// Tests that change provider selection own and restore it.
async function clearOnlineProvider() {
  const database = await getDataSource();
  const [row] = await database.query("SELECT active_provider FROM public.payment_provider_settings WHERE id=true");
  await database.query("UPDATE public.payment_provider_settings SET active_provider=NULL WHERE id=true");
  return row.active_provider as string | null;
}
async function restoreOnlineProvider(provider: string | null) {
  await (await getDataSource()).query("UPDATE public.payment_provider_settings SET active_provider=$1 WHERE id=true", [provider]);
}

test("admin location workflow uses Next.js authorization, denied browser grants and persistence", async () => {
  const service = localFixtureClient();
  await ensureIntegrationAdminAnchor(service);
  const userIds: string[] = [];
  const locationIds: string[] = [];
  const password = "locations-integration-password-123";
  const publicClient = () => createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_PUBLISHABLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  async function account(role?: "admin" | "coach") {
    const email = `locations-${randomUUID()}@example.test`;
    const { data, error } = await service.auth.admin.createUser({ email, password, email_confirm: true });
    assert.strictEqual(error, null); assert.ok(data.user);
    userIds.push(data.user.id);
    if (role) assert.strictEqual((await service.from("user_roles").insert({ user_id: data.user.id, role_code: role })).error, null);
    const client = publicClient();
    assert.strictEqual((await client.auth.signInWithPassword({ email, password })).error, null);
    return { client, id: data.user.id };
  }
  const fields = { name: `Location ${randomUUID()}`, address_line1: "Street 1", address_line2: "", city: "Cluj",
    postal_code: "400000", country_code: "RO", timezone: "Europe/Bucharest", currency: "EUR", is_active: true, is_public: false, display_order: 1, customer_cancellation_notice_minutes: 1440 };
  try {
    const admin = await account("admin");
    const member = await account();
    const coach = await account("coach");
    const result = await saveAdminLocation({ fields: { ...fields, is_public: true } }, admin.client);
    assert.ok(result.ok); locationIds.push(result.id);
    const original = (await listAdminLocations(admin.client)).find((row) => row.id === result.id);
    assert.ok(original);
    expect(original).toMatchObject({ name: fields.name, is_public: false, currency: "EUR", address_line2: null, customer_cancellation_notice_minutes: 1440 });

    expect(await saveAdminLocation({ fields }, admin.client)).toEqual({ ok: false, reason: "duplicate-slug" });
    expect(await saveAdminLocation({ fields: { ...fields, currency: "CAD" } }, admin.client)).toMatchObject({ ok: false, reason: "invalid-input" });

    for (const notice of [-1, 43201, 1.5]) {
      expect(await saveAdminLocation({ id: result.id, fields: { ...fields,
        customer_cancellation_notice_minutes: notice } }, admin.client)).toMatchObject({ ok: false, reason: "invalid-input" });
    }
    const selected = await saveAdminLocation({ fields: { ...fields, name: `Selected ${randomUUID()}`,
      customer_cancellation_notice_minutes: 0 } }, admin.client);
    assert.ok(selected.ok); locationIds.push(selected.id);
    expect((await listAdminLocations(admin.client)).find((row) => row.id === selected.id))
      .toMatchObject({ customer_cancellation_notice_minutes: 0 });

    // An old timestamp makes the application update contract deterministic.
    assert.strictEqual((await service.from("locations").update({ updated_at: "2000-01-01T00:00:00Z" }).eq("id", result.id)).error, null);
    for (const is_active of [false, true]) {
      expect(await saveAdminLocation({ id: result.id, fields: { ...fields, name: "Renamed location", currency: "RON", display_order: 4, customer_cancellation_notice_minutes: 120, is_active } }, admin.client))
        .toEqual({ ok: true, id: result.id });
      const saved = (await listAdminLocations(admin.client)).find((row) => row.id === result.id);
      expect(saved).toMatchObject({ name: "Renamed location", slug: original.slug, currency: "RON", display_order: 4, customer_cancellation_notice_minutes: 120, is_active });
      expect(Date.parse(saved!.updated_at)).toBeGreaterThan(Date.parse("2000-01-01T00:00:00Z"));
      const visible = await publicClient().from("locations").select("id").eq("id", result.id);
      expect(visible.error?.code).toBe("42501");
    }

    for (const session of [member.client, coach.client, publicClient()]) {
      await expect(saveAdminLocation({ fields }, session)).rejects.toThrow();
      await expect(saveAdminLocation({ id: result.id, fields }, session)).rejects.toThrow();
      await expect(listAdminLocations(session)).rejects.toThrow();
      expect((await session.from("locations").insert({ name: "Spoof", slug: `spoof-${randomUUID()}`, timezone: "UTC" })).error?.code).toBe("42501");
    }
    const suspended = await account("admin");
    assert.strictEqual((await service.from("users").update({ status: "suspended" }).eq("id", suspended.id)).error, null);
    await expect(saveAdminLocation({ id: result.id, fields }, suspended.client)).rejects.toThrow();

    expect((await listAdminLocationsWithReadiness("current", result.id, admin.client))[0].missing)
      .toEqual(["opening hours", "an active court"]);
    expect(await setAdminLocationPublication({ id: result.id, is_public: true }, admin.client))
      .toMatchObject({ ok: false, reason: "not-ready", message: expect.stringContaining("opening hours") });
    await expect(setAdminLocationPublication({ id: result.id, is_public: true }, member.client)).rejects.toThrow();

    // Public discovery still requires an active court.
    expect((await listPublicLocationsWithCourts()).some((row) => row.id === result.id)).toBe(false);
    // A stale publication value in Details must neither publish nor validate readiness.
    expect(await saveAdminLocation({ id: result.id, fields: { ...fields, is_public: true } }, admin.client))
      .toEqual({ ok: true, id: result.id });
    expect((await listAdminLocations(admin.client)).find((row) => row.id === result.id)?.is_public).toBe(false);
    const court = await service.from("courts").insert({ location_id: result.id, name: "Public fixture court",
      slug: "public-fixture", surface: "clay", environment: "outdoor" }).select("id").single();
    assert.strictEqual(court.error, null);
    expect((await insertOpeningHoursFixture(service, { location_id: result.id, weekday: 0,
      opens_at_minute: 480, closes_at_minute: 1200 })).error).toBeNull();
    const editedFields = { ...fields, name: "Renamed location", address_line1: "Updated street",
      address_line2: "Building 2", city: "Brasov", postal_code: "500000", country_code: "GB",
      timezone: "Europe/Bucharest", currency: "RON", customer_cancellation_notice_minutes: 120,
      allow_pay_at_club: true };
    expect(await saveAdminLocation({ id: result.id, fields: { ...editedFields, timezone: "Europe/London" } }, admin.client))
      .toMatchObject({ ok: false, reason: "invalid-input", fieldErrors: { timezone: expect.stringContaining("same IANA timezone") } });
    for (const update of [
      { ...fields, name: editedFields.name, address_line1: editedFields.address_line1 },
      editedFields,
    ]) {
      expect(await saveAdminLocation({ id: result.id, fields: update }, admin.client)).toEqual({ ok: true, id: result.id });
      expect((await listAdminLocations(admin.client)).find((row) => row.id === result.id))
        .toMatchObject({ ...update, address_line2: update.address_line2 || null, is_public: false });
    }
    expect(await saveAdminLocation({ id: result.id, fields: { ...editedFields, name: "Retry location", timezone: "Invalid/Zone" } }, admin.client))
      .toMatchObject({ ok: false, reason: "invalid-input" });
    expect((await listAdminLocations(admin.client)).find((row) => row.id === result.id)?.name).toBe(editedFields.name);
    expect(await saveAdminLocation({ id: result.id, fields: { ...editedFields, name: "Retry location" } }, admin.client))
      .toEqual({ ok: true, id: result.id });
    expect((await listAdminLocations(admin.client)).find((row) => row.id === result.id)?.name).toBe("Retry location");
    expect(await saveAdminLocation({ id: result.id, fields: editedFields }, admin.client)).toEqual({ ok: true, id: result.id });
    expect(await setAdminLocationPublication({ id: result.id, is_public: true }, admin.client))
      .toMatchObject({ ok: false, reason: "not-ready", message: expect.stringContaining("pricing") });
    expect((await listAdminLocations(admin.client)).find((row) => row.id === result.id)?.is_public).toBe(false);
    const ruleSet = await service.from("pricing_rule_sets").insert({ location_id: result.id }).select("id").single();
    assert.strictEqual(ruleSet.error, null);
    expect((await service.from("location_pricing_rules").insert({ location_id: result.id, rule_set_id: ruleSet.data!.id,
      court_id: court.data!.id, court_state: "outdoor", weekday: 0, starts_at_minute: 480,
      ends_at_minute: 1200, price_per_hour_minor: 5000 })).error).toBeNull();
    expect((await listAdminLocationsWithReadiness("current", result.id, admin.client))[0].missing).toEqual([]);
    expect(await setAdminLocationPublication({ id: result.id, is_public: true }, admin.client)).toEqual({ ok: true, id: result.id });
    expect((await listAdminLocations(admin.client)).find((row) => row.id === result.id))
      .toMatchObject({ name: "Renamed location", currency: "RON", is_public: true, customer_cancellation_notice_minutes: 120 });
    expect((await listPublicLocationsWithCourts()).some((row) => row.id === result.id)).toBe(true);
    // Readiness can become incomplete after publication; ordinary edits still work.
    expect((await service.from("location_pricing_rules").delete().eq("location_id", result.id)).error).toBeNull();
    expect((await listAdminLocationsWithReadiness("current", result.id, admin.client))[0].missing)
      .toContain("pricing for every active court");
    for (const is_public of [true, false]) {
      expect(await saveAdminLocation({ id: result.id, fields: { ...editedFields, is_public, city: "Updated city" } }, admin.client))
        .toEqual({ ok: true, id: result.id });
      expect((await listAdminLocations(admin.client)).find((row) => row.id === result.id))
        .toMatchObject({ city: "Updated city", is_public: true });
    }
    expect(await setAdminLocationPublication({ id: result.id, is_public: false }, admin.client)).toEqual({ ok: true, id: result.id });
    expect((await listPublicLocationsWithCourts()).some((row) => row.id === result.id)).toBe(false);
    // Payment settings do not prevent a currency change.
    expect(await saveAdminLocation({ id: result.id, fields: { ...fields, is_public: true, currency: "GBP" } }, admin.client))
      .toEqual({ ok: true, id: result.id });
    expect(await saveAdminLocation({ id: result.id, fields: { ...fields, is_public: true, currency: "RON" } }, admin.client)).toEqual({ ok: true, id: result.id });
    expect((await listAdminLocations(admin.client)).find((row) => row.id === result.id)).toMatchObject({ currency: "RON", is_public: false, allow_pay_at_club: false });
    expect(await setAdminLocationArchived({ id: result.id, archived: true }, admin.client)).toEqual({ ok: true, id: result.id });
    expect((await listAdminLocations(admin.client)).some((row) => row.id === result.id)).toBe(false);
    expect((await listAdminLocations(admin.client, "archived")).find((row) => row.id === result.id)).toMatchObject({ is_active: false, archived_at: expect.any(String) });
    expect((await service.from("locations").select("id, is_active, archived_at").eq("id", result.id).single()).data)
      .toMatchObject({ id: result.id, is_active: false, archived_at: expect.any(String) });
    expect((await publicClient().from("locations").select("id").eq("id", result.id)).error?.code).toBe("42501");
    expect((await publicClient().from("courts").select("id").eq("location_id", result.id)).error?.code).toBe("42501");
    expect((await listPublicLocationsWithCourts()).some((row) => row.id === result.id)).toBe(false);
    expect(await setAdminLocationArchived({ id: result.id, archived: false }, admin.client)).toEqual({ ok: true, id: result.id });
    expect((await listAdminLocations(admin.client)).find((row) => row.id === result.id)).toMatchObject({ is_active: false, archived_at: null });
    expect((await listAdminLocations(admin.client, "archived")).some((row) => row.id === result.id)).toBe(false);
    for (const session of [member.client, coach.client, publicClient()]) {
      await expect(setAdminLocationArchived({ id: result.id, archived: true }, session)).rejects.toThrow();
    }
    expect(await saveAdminLocation({ id: result.id, fields: { ...fields, is_active: false } }, admin.client)).toEqual({ ok: true, id: result.id });
    expect((await listPublicLocationsWithCourts()).some((row) => row.id === result.id)).toBe(false);
  } finally {
    if (locationIds.length) {
      assert.strictEqual((await service.from("location_pricing_rules").delete().in("location_id", locationIds)).error, null);
      assert.strictEqual((await service.from("pricing_rule_sets").delete().in("location_id", locationIds)).error, null);
      assert.strictEqual((await service.from("location_opening_hours").delete().in("location_id", locationIds)).error, null);
      assert.strictEqual((await service.from("courts").delete().in("location_id", locationIds)).error, null);
      assert.strictEqual((await service.from("locations").delete().in("id", locationIds)).error, null);
    }
    await cleanupAuthFixtures(service, userIds);
  }
}, 30000);

test("location currency changes only without unfinished bookings, unresolved financial work or court prices", async () => {
  const service = localFixtureClient(), database = await getDataSource();
  await ensureIntegrationAdminAnchor(service);
  const userIds: string[] = [], password = "locations-currency-password-123", marker = `currency-${randomUUID()}`;
  const [court, program] = [randomUUID(), randomUUID()];
  let locationId: string | undefined;
  const previousProvider = await clearOnlineProvider();
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
    const fields = { name: `Currency ${marker}`, address_line1: "", address_line2: "", city: "", postal_code: "", country_code: "RO",
      timezone: "Europe/Bucharest", currency: "RON", is_active: true, is_public: false, display_order: 1, customer_cancellation_notice_minutes: 120 };
    const save = (changes: Partial<typeof fields> & { allow_pay_at_club?: boolean }) =>
      saveAdminLocation({ id: locationId, fields: { ...fields, ...changes } }, admin);
    const currency = async () => (await listAdminLocations(admin)).find((row) => row.id === locationId)?.currency;

    // A: the Admin selects the currency when creating a location.
    const location = await saveAdminLocation({ fields }, admin);
    assert.ok(location.ok); locationId = location.id;
    expect(await currency()).toBe("RON");
    // B: no bookings, unresolved financial work or court prices.
    expect(await readAdminLocationCurrencyChange(locationId, admin)).toEqual([]);
    expect(await save({ currency: "EUR" })).toEqual({ ok: true, id: locationId });
    expect(await save({ currency: "RON" })).toEqual({ ok: true, id: locationId });

    // C: a future court booking, coaching booking, staff reservation and live checkout.
    assert.strictEqual((await service.from("courts").insert({ id: court, location_id: locationId, name: "Currency court", slug: "currency",
      surface: "clay", environment: "outdoor" })).error, null);
    await database.query(`INSERT INTO public.coaching_programs(id,name,description,program_type,court_rental_included,is_active)
      VALUES($1,$2,'','private',false,true)`, [program, marker]);
    await database.query(`INSERT INTO public.coach_profiles(user_id,display_name,bio,qualifications,specialties,languages)
      VALUES($1,'Currency coach','','','{}','{}')`, [adminId]);
    const [courtReservation, lessonReservation, staffReservation] = [randomUUID(), randomUUID(), randomUUID()];
    const [courtBooking, lessonBooking] = [randomUUID(), randomUUID()];
    assert.strictEqual((await service.from("court_reservations").insert([
      { id: courtReservation, court_id: court, booking_date: "2099-05-01", starts_at_minute: 480, ends_at_minute: 540 },
      { id: lessonReservation, court_id: court, booking_date: "2099-05-01", starts_at_minute: 600, ends_at_minute: 660, coach_user_id: adminId },
      { id: staffReservation, court_id: court, booking_date: "2099-05-02", starts_at_minute: 600, ends_at_minute: 720, reason: "Clinic", created_by_user_id: adminId },
    ])).error, null);
    const terms = { account_user_id: null, customer_email: "currency@example.test", customer_phone: "+40 700", status: "confirmed",
      total_amount_minor: 12000, currency: "RON", cancellation_notice_minutes: 120, payment_method: "pay_at_club" };
    await insertBookingFixture([{ ...terms, id: courtBooking, reservation_id: courtReservation, customer_name: "Court customer" },
      { ...terms, id: lessonBooking, reservation_id: lessonReservation, customer_name: "Lesson customer",
        coaching: { coach_user_id: adminId, coaching_program_id: program, coach_name: "Currency coach", coaching_program_name: marker } }]);
    const checkout = await insertCheckoutFixture({ courtId: court, bookingDate: "2099-05-03", startMinute: 480, endMinute: 540, accountUserId: null,
      customerName: "Checkout customer", customerEmail: "checkout@example.test", customerPhone: "+40 700", totalAmountMinor: 6000,
      currency: "RON", paymentMethod: "online", provider: "stripe", holdSeconds: 600 });
    const contracts = await readBookingContracts(service, { ids: [courtBooking, lessonBooking] });
    const unfinished = { kind: "unfinished-bookings", courtBookings: 1, coachingBookings: 1, reservations: 1, checkouts: 1 };
    expect(await readAdminLocationCurrencyChange(locationId, admin)).toEqual([unfinished, { kind: "financial-operations" }]);
    expect(await save({ currency: "EUR" })).toEqual({ ok: false, reason: "currency-locked", blockers: [unfinished, { kind: "financial-operations" }] });
    // Unrelated edits still save with future bookings, an enabled payment path and court prices.
    expect(await save({ name: `Renamed ${marker}`, allow_pay_at_club: true })).toEqual({ ok: true, id: locationId });
    fields.name = `Renamed ${marker}`;

    // Bookings complete or are cancelled; the expired unpaid checkout is released by the update itself.
    await database.query("UPDATE public.court_reservations SET booking_date='2020-05-01' WHERE id=ANY($1::uuid[])", [[courtReservation, lessonReservation]]);
    await database.query("UPDATE public.court_reservations SET status='cancelled',cancelled_at=now(),cancelled_by_user_id=$2 WHERE id=$1", [staffReservation, adminId]);
    await inTransaction(async (manager) => {
      await manager.query("ALTER TABLE public.payment_attempts DISABLE TRIGGER payment_attempts_immutable");
      await manager.query("UPDATE public.payment_attempts SET expires_at=now()-interval '1 minute' WHERE id=$1", [checkout.payment_attempt_id]);
      await manager.query("ALTER TABLE public.payment_attempts ENABLE TRIGGER payment_attempts_immutable");
      await manager.query("UPDATE public.court_reservations SET hold_expires_at=now()-interval '1 minute' WHERE id=$1", [checkout.reservation_id]);
    });
    // D: neither payment setting blocks currency changes or needs to be disabled.
    await restoreOnlineProvider("stripe");
    expect(await readAdminLocationCurrencyChange(locationId, admin)).toEqual([]);
    expect(await save({ currency: "EUR", allow_pay_at_club: true })).toEqual({ ok: true, id: locationId });
    expect((await listAdminLocations(admin)).find(row => row.id === locationId)?.allow_pay_at_club).toBe(true);
    expect((await database.query("SELECT active_provider FROM public.payment_provider_settings WHERE id=true"))[0].active_provider).toBe("stripe");
    expect(await save({ currency: "RON", allow_pay_at_club: true })).toEqual({ ok: true, id: locationId });

    // A payment that may still settle at this location is unresolved financial work.
    const late = await insertCheckoutFixture({ courtId: court, bookingDate: "2020-05-04", startMinute: 480, endMinute: 540, accountUserId: null,
      customerName: "Late customer", customerEmail: "late@example.test", customerPhone: "+40 700", totalAmountMinor: 6000,
      currency: "RON", paymentMethod: "online", provider: "stripe", holdSeconds: 600 });
    await database.query("UPDATE public.court_reservations SET status='released',hold_expires_at=NULL WHERE id=$1", [late.reservation_id]);
    expect(await save({ currency: "EUR" })).toEqual({ ok: false, reason: "currency-locked", blockers: [{ kind: "financial-operations" }] });
    await database.query("UPDATE public.payment_attempts SET provider_payment_id=$2 WHERE id=$1", [late.payment_attempt_id, `pi_${randomUUID()}`]);
    for (const status of ["expired", "failed"]) {
      await database.query("UPDATE public.payment_attempts SET status=$2,completed_at=now() WHERE id=$1", [late.payment_attempt_id, status]);
      expect(await readAdminLocationCurrencyChange(locationId, admin)).toEqual([{ kind: "financial-operations" }]);
      expect(await save({ currency: "EUR" })).toEqual({ ok: false, reason: "currency-locked", blockers: [{ kind: "financial-operations" }] });
    }
    // Moving a court must not move the original booking's financial obligations.
    const movedTo = randomUUID();
    await database.query("INSERT INTO public.locations(id,name,slug,timezone,currency) VALUES($1,'Moved court',$2,'UTC','RON')", [movedTo, movedTo]);
    try {
      await database.query("UPDATE public.courts SET location_id=$2 WHERE id=$1", [court, movedTo]);
      expect(await readAdminLocationCurrencyChange(locationId, admin)).toEqual([{ kind: "financial-operations" }]);
      expect(await readAdminLocationCurrencyChange(movedTo, admin)).toEqual([]);
    } finally {
      await database.query("UPDATE public.courts SET location_id=$2 WHERE id=$1", [court, locationId]);
      await database.query("DELETE FROM public.locations WHERE id=$1", [movedTo]);
    }
    // Verified cancellation is terminal; local expiry alone was not.
    await database.query("UPDATE public.payment_attempts SET status='cancelled' WHERE id=$1", [late.payment_attempt_id]);

    // E: court prices have no currency and must be removed first.
    const ruleSet = await service.from("pricing_rule_sets").insert({ location_id: locationId }).select("id").single();
    assert.strictEqual(ruleSet.error, null);
    assert.strictEqual((await service.from("location_pricing_rules").insert({ location_id: locationId, rule_set_id: ruleSet.data!.id,
      court_id: court, court_state: "outdoor", weekday: 0, starts_at_minute: 480, ends_at_minute: 1200, price_per_hour_minor: 5000 })).error, null);
    expect(await save({ currency: "EUR" })).toEqual({ ok: false, reason: "currency-locked", blockers: [{ kind: "court-pricing" }] });
    expect(await currency()).toBe("RON");
    assert.strictEqual((await service.from("pricing_rule_sets").delete().eq("id", ruleSet.data!.id)).error, null);

    // F: every prerequisite holds; only the location currency changes.
    expect(await readAdminLocationCurrencyChange(locationId, admin)).toEqual([]);
    expect(await save({ currency: "EUR" })).toEqual({ ok: true, id: locationId });
    expect(await currency()).toBe("EUR");
    expect((await service.from("checkout_records").select("status").eq("id", checkout.booking_id).single()).data?.status).toBe("expired");
    // Historical contracts and payment evidence keep their original currency and amounts.
    expect(await readBookingContracts(service, { ids: [courtBooking, lessonBooking] })).toEqual(contracts);
    expect((await readBookingContracts(service, { ids: [checkout.booking_id] }))[0]).toMatchObject({ total_amount_minor: 6000, currency: "RON" });
    expect((await service.from("payment_attempts").select("amount_minor,currency").in("booking_id", [checkout.booking_id, late.booking_id])).data)
      .toEqual([{ amount_minor: 6000, currency: "RON" }, { amount_minor: 6000, currency: "RON" }]);

    // A booking writer holding the shared configuration fence serializes the currency decision.
    writer = inTransaction(async (manager) => {
      await lockConfigurationForRead(manager);
      await lockLocations(manager, [locationId!]);
      await manager.query(`INSERT INTO public.court_reservations(court_id,booking_date,starts_at_minute,ends_at_minute,reason,created_by_user_id)
        VALUES($1,'2099-06-01',480,540,'Concurrent',$2)`, [court, adminId]);
      fenced.resolve();
      await gate.promise;
    });
    await bounded(fenced.promise, "concurrent reservation");
    const change = save({ currency: "RON" });
    let decided = false;
    void change.then(() => { decided = true; }, () => { decided = true; });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(decided).toBe(false);
    gate.resolve();
    await bounded(writer, "concurrent reservation commit");
    expect(await bounded(change, "currency decision")).toEqual({ ok: false, reason: "currency-locked", blockers: [{ kind: "unfinished-bookings", courtBookings: 0, coachingBookings: 0, reservations: 1, checkouts: 0 }] });
    expect(await currency()).toBe("EUR");
  } finally {
    gate.resolve();
    await writer?.catch(() => {});
    if (locationId) {
      await cleanupBookingFixtures({ courtIds: [court] });
      await database.query("DELETE FROM public.court_reservations WHERE court_id=$1", [court]);
      await database.query("DELETE FROM public.location_pricing_rules WHERE location_id=$1", [locationId]);
      await database.query("DELETE FROM public.pricing_rule_sets WHERE location_id=$1", [locationId]);
      await database.query("DELETE FROM public.courts WHERE id=$1", [court]);
      await database.query("DELETE FROM public.locations WHERE id=$1", [locationId]);
    }
    await database.query("DELETE FROM public.coach_profiles WHERE user_id=ANY($1::uuid[])", [userIds]);
    await database.query("DELETE FROM public.coaching_programs WHERE id=$1", [program]);
    await restoreOnlineProvider(previousProvider);
    await cleanupAuthFixtures(service, userIds);
  }
}, 30000);
