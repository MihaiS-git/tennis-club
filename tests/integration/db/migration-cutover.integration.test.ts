import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import sharp from "sharp";
import { afterAll, beforeAll, expect, test } from "vitest";
import type { DataSource } from "typeorm";
import { getDataSource } from "@/lib/db/data-source";
import { localFixtureClient } from "../auth-fixtures";
import { saveAdminLocation, setAdminLocationPublication } from "@/lib/admin/locations";
import { saveAdminCourt } from "@/lib/admin/courts";
import { mutateAdminOpeningHours } from "@/lib/admin/opening-hours";
import { saveAdminPricingRule } from "@/lib/admin/pricing";
import { listPublicLocationsWithCourts } from "@/lib/courts/public";

// Native integrity and security checks run only against the isolated test stack.
let database: DataSource;
const userIds: string[] = [], locationIds: string[] = [];
const client = () => createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_PUBLISHABLE_KEY!, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});

beforeAll(async () => {
  const db = new URL(process.env.DATABASE_URL!);
  const api = new URL(process.env.SUPABASE_URL!);
  expect(["127.0.0.1", "localhost"]).toContain(db.hostname);
  expect(["127.0.0.1", "localhost"]).toContain(api.hostname);
  expect(process.env.NODE_ENV).not.toBe("production");
  expect(process.env.TEST_SUPABASE_PROJECT).toBe("tennis-club-tests");
  expect(db.port).toBe("55322");
  expect(api.port).toBe("55321");
  expect(db.pathname).toBe("/postgres");
  database = await getDataSource();
});

afterAll(async () => {
  if (!database) return;
  for (const id of locationIds) {
    await database.query("DELETE FROM public.location_pricing_rules WHERE location_id=$1", [id]);
    await database.query("DELETE FROM public.pricing_rule_sets WHERE location_id=$1", [id]);
    await database.query("DELETE FROM public.location_opening_hours WHERE location_id=$1", [id]);
    await database.query("DELETE FROM public.courts WHERE location_id=$1", [id]);
    await database.query("DELETE FROM public.locations WHERE id=$1", [id]);
  }
  for (const id of userIds) {
    await database.query("DELETE FROM public.user_roles WHERE user_id=$1", [id]);
    await database.query("DELETE FROM public.users WHERE id=$1", [id]);
    expect((await localFixtureClient().auth.admin.deleteUser(id)).error).toBeNull();
  }
  await database.destroy();
});

const smoke = test;
smoke("browser database roles have no application table or column privileges, including future tables", async () => {
  for (const role of ["anon", "authenticated"]) {
    const privileges = await database.query(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relkind IN ('r','S') AND
      (CASE WHEN c.relkind='S' THEN has_sequence_privilege($1,c.oid,'USAGE,SELECT,UPDATE')
      ELSE has_table_privilege($1,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        OR has_any_column_privilege($1,c.oid,'SELECT,INSERT,UPDATE,REFERENCES') END)`, [role]);
    expect(privileges).toEqual([]);
    const runner = database.createQueryRunner();
    await runner.startTransaction();
    try {
      await runner.query(`SET LOCAL ROLE ${role}`);
      await expect(runner.query("SELECT * FROM public.users")).rejects.toMatchObject({ driverError: { code: "42501" } });
    } finally { await runner.rollbackTransaction(); await runner.release(); }
  }
  const runner = database.createQueryRunner();
  await runner.startTransaction();
  try {
    await runner.query("CREATE TABLE public.cutover_permission_probe(id integer)");
    expect(await runner.query(`SELECT has_table_privilege('anon','public.cutover_permission_probe','SELECT,INSERT,UPDATE,DELETE') AS anon,
      has_table_privilege('authenticated','public.cutover_permission_probe','SELECT,INSERT,UPDATE,DELETE') AS authenticated`))
      .toEqual([{ anon: false, authenticated: false }]);
  } finally { await runner.rollbackTransaction(); await runner.release(); }
});

smoke("real Auth signup/email sync and private active-account Storage work without application grants", async () => {
  const owner = client(), anonymous = client(), service = localFixtureClient();
  const email = `cutover-${randomUUID()}@example.test`, password = "cutover-storage-password-123";
  const signup = await owner.auth.signUp({ email, password });
  expect(signup.error).toBeNull(); expect(signup.data.user).toBeTruthy();
  const id = signup.data.user!.id; userIds.push(id);
  if (!signup.data.session) {
    expect((await service.auth.admin.updateUserById(id, { email_confirm: true })).error).toBeNull();
    expect((await owner.auth.signInWithPassword({ email, password })).error).toBeNull();
  }
  const original = await database.query("SELECT email,status,updated_at::text FROM public.users WHERE id=$1", [id]);
  expect(original[0]).toMatchObject({ email, status: "active" });
  expect(await database.query("SELECT * FROM public.user_roles WHERE user_id=$1", [id])).toEqual([]);
  const changedEmail = `changed-${randomUUID()}@example.test`;
  expect((await service.auth.admin.updateUserById(id, { email: changedEmail })).error).toBeNull();
  const changed = await database.query("SELECT email,updated_at::text FROM public.users WHERE id=$1", [id]);
  expect(changed[0].email).toBe(changedEmail); expect(changed[0].updated_at).not.toBe(original[0].updated_at);
  expect((await anonymous.from("users").select("id")).error).toBeTruthy();
  expect((await owner.from("users").select("id")).error).toBeTruthy();
  const path = `${id}/avatar.webp`, bucket = owner.storage.from("profile-avatars");
  const bytes = await sharp({ create: { width: 2, height: 2, channels: 3, background: "red" } }).webp().toBuffer();
  expect((await bucket.upload(path, bytes, { contentType: "image/webp" })).error).toBeNull();
  expect((await bucket.download(path)).error).toBeNull();
  expect((await bucket.upload(path, bytes, { contentType: "image/webp", upsert: true })).error).toBeNull();
  expect((await bucket.upload(`${randomUUID()}/avatar.webp`, bytes, { contentType: "image/webp" })).error).toBeTruthy();
  expect((await bucket.upload(path, bytes, { contentType: "image/png", upsert: true })).error).toBeTruthy();
  expect((await anonymous.storage.from("profile-avatars").download(path)).error).toBeTruthy();
  const publicResponse = await fetch(`${process.env.SUPABASE_URL}/storage/v1/object/public/profile-avatars/${path}`);
  expect(publicResponse.ok).toBe(false);
  await database.query("UPDATE public.users SET status='suspended' WHERE id=$1", [id]);
  expect((await bucket.download(path)).error).toBeTruthy();
  expect((await bucket.upload(path, bytes, { contentType: "image/webp", upsert: true })).error).toBeTruthy();
  // Storage DELETE may return an empty successful response for rows hidden by RLS.
  await bucket.remove([path]);
  expect((await service.storage.from("profile-avatars").download(path)).error).toBeNull();
  await database.query("UPDATE public.users SET status='active' WHERE id=$1", [id]);
  expect((await bucket.remove([path])).error).toBeNull();
  expect((await bucket.download(path)).error).toBeTruthy();
  expect(await database.query("SELECT public,file_size_limit,allowed_mime_types FROM storage.buckets WHERE id='profile-avatars'"))
    .toEqual([{ public: false, file_size_limit: "5242880", allowed_mime_types: ["image/webp"] }]);
});

smoke("Admin configuration services persist and publication readiness still gates discovery", async () => {
  const admin = client(), service = localFixtureClient(), email = `configuration-${randomUUID()}@example.test`;
  const password = "configuration-password-123";
  const created = await service.auth.admin.createUser({ email, password, email_confirm: true });
  expect(created.error).toBeNull(); const userId = created.data.user!.id; userIds.push(userId);
  await database.query("INSERT INTO public.user_roles(user_id,role_code) VALUES($1,'admin')", [userId]);
  expect((await admin.auth.signInWithPassword({ email, password })).error).toBeNull();
  const location = await saveAdminLocation({ fields: {
    name: `Cutover ${randomUUID()}`, address_line1: "1 Tennis Street", address_line2: "", city: "Bucharest",
    postal_code: "010101", country_code: "RO", timezone: "Europe/Bucharest", currency: "RON",
    is_active: true, is_public: false, display_order: 0, customer_cancellation_notice_minutes: 1440, allow_pay_at_club: true,
  } }, admin);
  expect(location, JSON.stringify(location)).toMatchObject({ ok: true }); if (!location.ok) throw new Error(JSON.stringify(location));
  locationIds.push(location.id);
  expect((await setAdminLocationPublication({ id: location.id, is_public: true }, admin)).ok).toBe(false);
  const court = await saveAdminCourt({ fields: { location_id: location.id, name: "Court 1", surface: "clay",
    environment: "outdoor", has_lighting: false, is_active: true } }, admin);
  expect(court.ok).toBe(true); if (!court.ok) throw new Error(JSON.stringify(court));
  expect((await mutateAdminOpeningHours({ location_id: location.id, weekdays: [0,1,2,3,4,5,6], replace_ids: [],
    intervals: [{ opens_at: "08:00", closes_at: "22:00" }] }, admin)).ok).toBe(true);
  const pricing = await saveAdminPricingRule({ location_id: location.id, court_ids: [court.id], court_state: "outdoor",
    weekdays: [0,1,2,3,4,5,6], starts_at: "08:00", ends_at: "22:00", starts_on: "", ends_on: "", price_per_hour: "50" }, admin);
  expect(pricing.ok).toBe(true);
  expect(await setAdminLocationPublication({ id: location.id, is_public: true }, admin)).toEqual({ ok: true, id: location.id });
  expect((await listPublicLocationsWithCourts()).some((row) => row.id === location.id)).toBe(true);
  const hours = await database.query("SELECT id FROM public.location_opening_hours WHERE location_id=$1", [location.id]);
  expect((await mutateAdminOpeningHours({ location_id: location.id, weekdays: [0,1,2,3,4,5,6],
    replace_ids: hours.map((row: { id: string }) => row.id), intervals: [{ opens_at: "09:00", closes_at: "22:00" }] }, admin)))
    .toMatchObject({ ok: false, reason: "pricing-conflict" });
});

smoke("native overlap, partial payment uniqueness and refund constraints reject invalid persistence", async () => {
  const runner = database.createQueryRunner();
  await runner.startTransaction();
  async function rejects(sql: string, parameters: unknown[], code: string) {
    await runner.query("SAVEPOINT invalid_input");
    try { await expect(runner.query(sql, parameters)).rejects.toMatchObject({ driverError: { code } }); }
    finally { await runner.query("ROLLBACK TO SAVEPOINT invalid_input"); }
  }
  try {
    const locationId = randomUUID(), courtId = randomUUID(), setId = randomUUID(), reservationId = randomUUID(), bookingId = randomUUID();
    await runner.query("INSERT INTO public.locations(id,name,slug,timezone) VALUES($1,'Integrity',$2,'UTC')", [locationId, `integrity-${locationId}`]);
    await runner.query("INSERT INTO public.courts(id,location_id,name,slug,surface,environment) VALUES($1,$2,'Court','court','clay','outdoor')", [courtId, locationId]);
    const hours = "INSERT INTO public.location_opening_hours(location_id,weekday,opens_at_minute,closes_at_minute) VALUES($1,0,$2,$3)";
    await runner.query(hours, [locationId, 480, 600]);
    await rejects(hours, [locationId, 540, 660], "23P01");
    await runner.query(hours, [locationId, 600, 720]);
    const coverage = "INSERT INTO public.court_coverage_periods(court_id,starts_on,ends_on) VALUES($1,$2,$3)";
    await runner.query(coverage, [courtId, "2099-01-01", "2099-01-31"]);
    await rejects(coverage, [courtId, "2099-01-31", "2099-02-28"], "23P01");
    await runner.query(coverage, [courtId, "2099-02-01", "2099-02-28"]);
    await runner.query("INSERT INTO public.pricing_rule_sets(id,location_id) VALUES($1,$2)", [setId, locationId]);
    const pricing = `INSERT INTO public.location_pricing_rules(location_id,rule_set_id,court_id,court_state,weekday,starts_at_minute,ends_at_minute,price_per_hour_minor)
      VALUES($1,$2,$3,'outdoor',0,$4,$5,5000)`;
    await runner.query(pricing, [locationId, setId, courtId, 480, 600]);
    await rejects(pricing, [locationId, setId, courtId, 540, 660], "23P01");
    await runner.query(pricing, [locationId, setId, courtId, 600, 720]);
    await runner.query(`INSERT INTO public.court_reservations(id,court_id,booking_date,starts_at_minute,ends_at_minute,status,hold_expires_at)
      VALUES($1,$2,'2099-01-01',480,600,'held',clock_timestamp()+interval '10 minutes')`, [reservationId, courtId]);
    const reservation = "INSERT INTO public.court_reservations(court_id,booking_date,starts_at_minute,ends_at_minute) VALUES($1,'2099-01-01',$2,$3)";
    await rejects(reservation, [courtId, 540, 660], "23P01");
    await runner.query(reservation, [courtId, 600, 720]);
    await runner.query(`INSERT INTO public.bookings(id,reservation_id,customer_name,customer_email,customer_phone,total_amount_minor,currency,cancellation_notice_minutes,status,payment_method)
      VALUES($1,$2,'Customer','customer@example.test','123',5000,'EUR',1440,'pending_payment','online')`, [bookingId, reservationId]);
    const attemptId = randomUUID();
    const attempt = `INSERT INTO public.payment_attempts(id,booking_id,method,provider,provider_payment_id,amount_minor,currency,status,expires_at,checkout_token_hash)
      VALUES($1,$2,'online','stripe','pi_cutover_integrity',5000,'EUR','pending',clock_timestamp()+interval '10 minutes','cutover-token')`;
    await runner.query(attempt, [attemptId, bookingId]);
    await rejects(attempt, [randomUUID(), bookingId], "23505");
    await rejects("UPDATE public.payment_attempts SET amount_minor=0 WHERE id=$1", [attemptId], "23514");
    const refund = `INSERT INTO public.payment_refunds(booking_id,payment_attempt_id,provider,provider_payment_id,amount_minor,currency)
      VALUES($1,$2,'stripe','pi_cutover_integrity',$3,'EUR')`;
    await rejects(refund, [bookingId, attemptId, 0], "23514");
    await rejects(refund, [bookingId, randomUUID(), 5000], "23503");
    await runner.query(refund, [bookingId, attemptId, 5000]);
    await rejects(refund, [bookingId, attemptId, 5000], "23505");
  } finally { await runner.rollbackTransaction(); await runner.release(); }
});
