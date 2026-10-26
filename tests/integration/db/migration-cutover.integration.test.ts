import { insertBookingRecords } from "../../local/booking-fixtures";
import { appendBookingContractFixture } from "../checkout-fixtures";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import sharp from "sharp";
import { afterAll, beforeAll, expect, onTestFinished, test } from "vitest";
import type { DataSource } from "typeorm";
import { getDataSource } from "@/lib/db/data-source";
import { localFixtureClient } from "../auth-fixtures";
import { deleteMailpitMessagesTo } from "../../local/mailpit";
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
  try {
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
  } finally {
    await database.destroy();
  }
});

test("registered migrations match application metadata without schema changes", async () => {
  expect((await database.query("SELECT name FROM public.migrations ORDER BY timestamp")).map((row: { name: string }) => row.name))
    .toEqual(["InitialApplicationSchema1791462257924", "ApplicationNativeIntegrity1791462257925", "SupabaseAuthStorage1791462257926"]);
  expect(await database.query("SELECT to_regclass('public.job_leases') AS job_leases")).toEqual([{ job_leases: null }]);
  expect(await database.query(`SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='public'
    AND column_name='recovery_version'`)).toEqual([]);
  const diff = await database.driver.createSchemaBuilder().log();
  expect(diff.upQueries).toEqual([]);
  expect(diff.downQueries).toEqual([]);
  expect(database.getMetadata("auth.users").synchronize).toBe(false);
  expect(database.getMetadata("public.payment_refunds").findColumnWithPropertyName("capturedAmountMinor"))
    .toMatchObject({ databaseName: "captured_amount_minor", isNullable: false });
  const booking = database.getMetadata("public.bookings");
  expect(booking.findColumnWithPropertyName("accountUserId")).toMatchObject({ databaseName: "account_user_id", isNullable: true });
  expect(booking.foreignKeys.find(key => key.name === "bookings_account_user_id_fkey"))
    .toMatchObject({ onDelete: "RESTRICT" });
});

test("the fresh baseline defines one coaching price table: lesson price/person per program, duration, count, currency and scope", async () => {
  expect(await database.query(`SELECT column_name,is_nullable FROM information_schema.columns
    WHERE table_schema='public' AND table_name='coaching_prices' ORDER BY column_name`)).toEqual([
    ["amount_minor", "NO"], ["coach_user_id", "YES"], ["created_at", "NO"], ["currency", "NO"], ["duration_minutes", "NO"],
    ["id", "NO"], ["participant_count", "NO"], ["program_id", "NO"], ["updated_at", "NO"],
  ].map(([column_name, is_nullable]) => ({ column_name, is_nullable })));
  // No pricing unit and no separate participant rate table exist.
  expect(await database.query(`SELECT column_name FROM information_schema.columns
    WHERE table_schema='public' AND table_name='coaching_programs' AND column_name='pricing_unit'`)).toEqual([]);
  expect(await database.query("SELECT to_regclass('public.coaching_participant_prices') AS rates")).toEqual([{ rates: null }]);
  expect(await database.query(`SELECT conname FROM pg_constraint WHERE conname LIKE '%pricing_unit%' OR conname LIKE 'coaching_participant_prices%'`)).toEqual([]);
  const indexes: { indexname: string; indexdef: string }[] = await database.query(`SELECT indexname,indexdef FROM pg_indexes
    WHERE schemaname='public' AND tablename='coaching_prices' AND indexname IN ('coaching_prices_club_default','coaching_prices_coach_override') ORDER BY indexname`);
  expect(indexes).toHaveLength(2);
  for (const index of indexes) {
    expect(index.indexdef).toContain("UNIQUE INDEX");
    expect(index.indexdef).toContain("program_id, duration_minutes, participant_count, currency");
    expect(index.indexdef).toContain(index.indexname === "coaching_prices_club_default" ? "coach_user_id IS NULL" : "coach_user_id IS NOT NULL");
  }
  const runner = database.createQueryRunner();
  await runner.startTransaction();
  try {
    const rejects = async (sql: string, code: string, constraint: string) => {
      await runner.query("SAVEPOINT prices");
      try { await expect(runner.query(sql)).rejects.toMatchObject({ driverError: { code, constraint } }); }
      finally { await runner.query("ROLLBACK TO SAVEPOINT prices"); }
    };
    const program = randomUUID();
    await runner.query(`INSERT INTO public.coaching_programs(id,name,description,program_type,court_rental_included,is_active,min_participants,max_participants)
      VALUES($1,$2,'','group',false,false,3,6)`, [program, `Prices ${program}`]);
    await runner.query("INSERT INTO public.coaching_program_durations(program_id,duration_minutes) VALUES($1,90)", [program]);
    const insert = (count: number, amount: number, currency = "RON", duration = 90) => `INSERT INTO public.coaching_prices(program_id,duration_minutes,participant_count,amount_minor,currency)
      VALUES('${program}',${duration},${count},${amount},'${currency}')`;
    await runner.query(insert(3, 6000));
    await rejects(insert(3, 5000), "23505", "coaching_prices_club_default");
    await runner.query(insert(3, 1500, "EUR"));
    await rejects(insert(4, 0), "23514", "coaching_prices_amount_check");
    await rejects(insert(0, 100), "23514", "coaching_prices_participants_check");
    await rejects(insert(4, 100, "JPY"), "23514", "coaching_prices_currency_check");
    // A price exists only for one of the program's explicit durations.
    await rejects(insert(4, 100, "RON", 60), "23503", "coaching_prices_duration_fkey");
    // A coach override needs the coach's assignment to the program.
    await rejects(`INSERT INTO public.coaching_prices(program_id,duration_minutes,participant_count,coach_user_id,amount_minor,currency)
      VALUES('${program}',90,3,'${randomUUID()}',100,'RON')`, "23503", "coaching_prices_coach_program_fkey");
    await rejects(`DELETE FROM public.coaching_program_durations WHERE program_id='${program}'`, "23503", "coaching_prices_duration_fkey");
  } finally { await runner.rollbackTransaction(); await runner.release(); }
});

test("initial schema defines disabled club email settings, suppression evidence and canonical coaching durations", async () => {
  expect(await database.query("SELECT id,official_email,sender_name,emails_enabled FROM public.club_settings"))
    .toEqual([{ id: true, official_email: "", sender_name: "", emails_enabled: false }]);
  expect(await database.query(`SELECT is_nullable,data_type FROM information_schema.columns
    WHERE table_schema='public' AND table_name='email_deliveries' AND column_name='suppressed_at'`))
    .toEqual([{ is_nullable: "YES", data_type: "timestamp with time zone" }]);
  expect(await database.query(`SELECT has_table_privilege('anon','public.club_settings','SELECT') AS anon,
    has_table_privilege('authenticated','public.club_settings','SELECT') AS authenticated`))
    .toEqual([{ anon: false, authenticated: false }]);
  const runner = database.createQueryRunner();
  await runner.startTransaction();
  try {
    const rejects = async (sql: string, code: string, constraint: string) => {
      await runner.query("SAVEPOINT initial_schema");
      try { await expect(runner.query(sql)).rejects.toMatchObject({ driverError: { code, constraint } }); }
      finally { await runner.query("ROLLBACK TO SAVEPOINT initial_schema"); }
    };
    await rejects("INSERT INTO public.club_settings(id) VALUES (true)", "23505", "club_settings_pkey");
    await rejects("INSERT INTO public.club_settings(id) VALUES (false)", "23514", "club_settings_singleton");
    await rejects("UPDATE public.club_settings SET emails_enabled=true", "23514", "club_settings_sender");
    for (const minutes of [45, 75, 150])
      await rejects(`INSERT INTO public.coaching_program_durations(program_id,duration_minutes) VALUES ('${randomUUID()}',${minutes})`,
        "23514", "coaching_program_durations_minutes_check");
    // Canonical durations pass the check and reach the program foreign key.
    for (const minutes of [60, 90, 120])
      await rejects(`INSERT INTO public.coaching_program_durations(program_id,duration_minutes) VALUES ('${randomUUID()}',${minutes})`,
        "23503", "coaching_program_durations_program_id_fkey");
  } finally { await runner.rollbackTransaction(); await runner.release(); }
});

test("booking ownership is permanent for guests and accounts, without blocking aggregate updates", async () => {
  const owners: string[] = [];
  for (let i = 0; i < 2; i++) {
    const created = await localFixtureClient().auth.admin.createUser({
      email: `ownership-${randomUUID()}@example.test`, password: "ownership-integrity-password-123", email_confirm: true,
    });
    expect(created.error).toBeNull(); expect(created.data.user).toBeTruthy();
    owners.push(created.data.user!.id); userIds.push(created.data.user!.id);
  }
  const runner = database.createQueryRunner();
  await runner.startTransaction();
  try {
    const location = randomUUID(), court = randomUUID();
    const guest = randomUUID(), member = randomUUID(), guestReservation = randomUUID(), memberReservation = randomUUID();
    await runner.query("INSERT INTO public.locations(id,name,slug,timezone) VALUES($1,'Ownership integrity',$2,'UTC')", [location, `ownership-${location}`]);
    await runner.query("INSERT INTO public.courts(id,location_id,name,slug,surface,environment) VALUES($1,$2,'Court','court','hard','outdoor')", [court, location]);
    await runner.query(`INSERT INTO public.court_reservations(id,court_id,booking_date,starts_at_minute,ends_at_minute)
      VALUES($1,$3,'2099-10-15',600,660),($2,$3,'2099-10-15',660,720)`, [guestReservation, memberReservation, court]);
    for (const [id, reservationId, owner] of [[guest, guestReservation, null], [member, memberReservation, owners[0]]] as const)
      await insertBookingRecords(runner.manager, { id, reservation_id: reservationId, account_user_id: owner,
        customer_name: "Customer", customer_email: "ownership@example.test", customer_phone: "123", total_amount_minor: 5000,
        currency: "EUR", payment_method: "pay_at_club", cancellation_notice_minutes: 1440 });
    await runner.query("SET CONSTRAINTS ALL IMMEDIATE");
    await runner.query("SET CONSTRAINTS ALL DEFERRED");
    const snapshot = async () => ({
      bookings: await runner.query("SELECT * FROM public.bookings WHERE id=ANY($1::uuid[]) ORDER BY id", [[guest, member]]),
      revisions: await runner.query("SELECT * FROM public.booking_revisions WHERE booking_id=ANY($1::uuid[]) ORDER BY booking_id,revision_number", [[guest, member]]),
      occupancy: await runner.query("SELECT * FROM public.court_reservations WHERE id=ANY($1::uuid[]) ORDER BY id", [[guestReservation, memberReservation]]),
    });
    const before = await snapshot();
    // Reject every transfer direction after provisional revision/occupancy writes.
    // Savepoint rollback must restore the entire aggregate, including its head.
    for (const [id, reservationId, replacement] of [
      [guest, guestReservation, owners[0]], [member, memberReservation, null], [member, memberReservation, owners[1]],
    ] as const) {
      await runner.query("SAVEPOINT ownership_change");
      try {
        await appendBookingContractFixture(id, { booking_date: "2099-10-16", total_amount_minor: 6000 }, runner.manager);
        expect(await runner.query("SELECT booking_date::text FROM public.court_reservations WHERE id=$1", [reservationId]))
          .toEqual([{ booking_date: "2099-10-16" }]);
        await expect(runner.query("UPDATE public.bookings SET account_user_id=$2,status='cancelled',updated_at=clock_timestamp() WHERE id=$1", [id, replacement]))
          .rejects.toMatchObject({ driverError: { code: "23514", message: "Booking ownership is immutable" } });
      } finally { await runner.query("ROLLBACK TO SAVEPOINT ownership_change"); }
      expect(await snapshot()).toEqual(before);
    }
    // Explicitly rewriting the same owner (including NULL) still permits status,
    // immutable revision-head and occupancy changes in the same transaction.
    for (const [id, reservationId, owner] of [[guest, guestReservation, null], [member, memberReservation, owners[0]]] as const) {
      await appendBookingContractFixture(id, { booking_date: "2099-10-16" }, runner.manager);
      await runner.query("UPDATE public.bookings SET account_user_id=$2,status='cancelled',updated_at=clock_timestamp() WHERE id=$1", [id, owner]);
      await runner.query("UPDATE public.court_reservations SET status='cancelled',cancelled_at=clock_timestamp(),cancelled_by_user_id=$2 WHERE id=$1", [reservationId, owners[1]]);
      expect(await runner.query("SELECT account_user_id,status FROM public.bookings WHERE id=$1", [id]))
        .toEqual([{ account_user_id: owner, status: "cancelled" }]);
      expect(await runner.query("SELECT revision_number,booking_date::text FROM public.booking_revisions WHERE id=(SELECT current_revision_id FROM public.bookings WHERE id=$1)", [id]))
        .toEqual([{ revision_number: 2, booking_date: "2099-10-16" }]);
    }
    await runner.query("SET CONSTRAINTS ALL IMMEDIATE");
    await runner.query("SAVEPOINT owner_delete");
    try {
      await expect(runner.query("DELETE FROM public.users WHERE id=$1", [owners[0]]))
        .rejects.toMatchObject({ driverError: { code: "23503", constraint: "bookings_account_user_id_fkey" } });
    } finally { await runner.query("ROLLBACK TO SAVEPOINT owner_delete"); }
  } finally { await runner.rollbackTransaction(); await runner.release(); }
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

smoke("public-schema default privileges expose no future migration-role objects to browser roles", async () => {
  // Migrations run as postgres. Supabase's stock supabase_admin defaults grant browser roles
  // everything, cannot be altered by postgres, and stay harmless only while it owns nothing here.
  expect(await database.query("SELECT current_user AS actor")).toEqual([{ actor: "postgres" }]);
  expect(await database.query(`SELECT c.relname AS name FROM pg_class c WHERE c.relnamespace='public'::regnamespace
    AND c.relowner<>current_user::regrole UNION ALL SELECT p.proname FROM pg_proc p
    WHERE p.pronamespace='public'::regnamespace AND p.proowner<>current_user::regrole`)).toEqual([]);
  // Global entries combine with schema entries, so a schema-level REVOKE cannot cancel them.
  const defaults = (grantees: string) => database.query(`SELECT DISTINCT d.defaclobjtype AS type FROM pg_default_acl d
    CROSS JOIN aclexplode(d.defaclacl) a WHERE d.defaclrole=current_user::regrole AND d.defaclobjtype IN ('r','S')
    AND d.defaclnamespace IN (0::oid,'public'::regnamespace::oid)
    AND (CASE a.grantee WHEN 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END)=ANY($1::text[]) ORDER BY 1`, [grantees]);
  expect(await defaults("{PUBLIC,anon,authenticated}")).toEqual([]);
  expect(await defaults("{service_role}")).toEqual([{ type: "S" }, { type: "r" }]);
  expect(await database.query(`SELECT role, has_schema_privilege(role,'public','USAGE') AS usage,
    has_schema_privilege(role,'public','CREATE') AS create FROM unnest(ARRAY['anon','authenticated','service_role']) role`))
    .toEqual(["anon", "authenticated", "service_role"].map((role) => ({ role, usage: true, create: false })));
  expect(await database.query(`SELECT p.proname AS name, role FROM pg_proc p, unnest(ARRAY['public','anon','authenticated']) role
    WHERE p.pronamespace='public'::regnamespace AND has_function_privilege(role,p.oid,'EXECUTE') ORDER BY 1,2`))
    .toEqual([{ name: "has_active_avatar_account", role: "authenticated" }]);
  const runner = database.createQueryRunner();
  await runner.startTransaction();
  try {
    await runner.query("CREATE TABLE public.cutover_default_acl_probe(id integer GENERATED ALWAYS AS IDENTITY, note text)");
    const grantees = (relation: string) => runner.query(`SELECT array_agg(grantee::text ORDER BY grantee) AS grantees FROM (SELECT DISTINCT
      pg_get_userbyid(a.grantee) AS grantee FROM pg_class c CROSS JOIN aclexplode(c.relacl) a WHERE c.oid=$1::regclass) g`, [relation]);
    const sequence = "public.cutover_default_acl_probe_id_seq";
    expect(await grantees("public.cutover_default_acl_probe")).toEqual([{ grantees: ["postgres", "service_role"] }]);
    expect(await grantees(sequence)).toEqual([{ grantees: ["postgres", "service_role"] }]);
    expect(await runner.query(`SELECT role FROM unnest(ARRAY['public','anon','authenticated']) role
      WHERE has_table_privilege(role,'public.cutover_default_acl_probe','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      OR has_any_column_privilege(role,'public.cutover_default_acl_probe','SELECT,INSERT,UPDATE,REFERENCES')
      OR has_sequence_privilege(role,'${sequence}','USAGE,SELECT,UPDATE')`)).toEqual([]);
    for (const role of ["anon", "authenticated"]) {
      await runner.query("SAVEPOINT browser_probe");
      try {
        await runner.query(`SET LOCAL ROLE ${role}`);
        await expect(runner.query("SELECT * FROM public.cutover_default_acl_probe")).rejects.toMatchObject({ driverError: { code: "42501" } });
      } finally { await runner.query("ROLLBACK TO SAVEPOINT browser_probe"); }
    }
    await runner.query("SET LOCAL ROLE service_role");
    await runner.query("INSERT INTO public.cutover_default_acl_probe(note) VALUES ('server')");
    expect(await runner.query("SELECT note FROM public.cutover_default_acl_probe")).toEqual([{ note: "server" }]);
  } finally { await runner.rollbackTransaction(); await runner.release(); }
  expect(await database.query("SELECT to_regclass('public.cutover_default_acl_probe') AS probe")).toEqual([{ probe: null }]);
});

smoke("real Auth signup/email sync and private active-account Storage work without application grants", async () => {
  const owner = client(), anonymous = client(), service = localFixtureClient();
  const email = `cutover-${randomUUID()}@example.test`, password = "cutover-storage-password-123";
  // Signup mails a confirmation to this recipient; remove only its messages, after any outcome.
  onTestFinished(() => deleteMailpitMessagesTo(email));
  const signup = await owner.auth.signUp({ email, password });
  if (signup.data.user) userIds.push(signup.data.user.id);
  expect(signup.error).toBeNull(); expect(signup.data.user).toBeTruthy();
  const id = signup.data.user!.id;
  if (!signup.data.session) {
    expect((await service.auth.admin.updateUserById(id, { email_confirm: true })).error).toBeNull();
    expect((await owner.auth.signInWithPassword({ email, password })).error).toBeNull();
  }
  const original = await database.query("SELECT email,status,updated_at::text FROM public.users WHERE id=$1", [id]);
  expect(original[0]).toMatchObject({ email, status: "active" });
  expect(await database.query("SELECT * FROM public.user_roles WHERE user_id=$1", [id])).toEqual([]);
  const changedEmail = `changed-${randomUUID()}@example.test`;
  onTestFinished(() => deleteMailpitMessagesTo(changedEmail));
  expect((await service.auth.admin.updateUserById(id, { email: changedEmail })).error).toBeNull();
  const changed = await database.query("SELECT email,updated_at::text FROM public.users WHERE id=$1", [id]);
  expect(changed[0].email).toBe(changedEmail); expect(changed[0].updated_at).not.toBe(original[0].updated_at);
  expect((await anonymous.from("users").select("id")).error).toBeTruthy();
  expect((await owner.from("users").select("id")).error).toBeTruthy();
  const path = `${id}/avatar.webp`, foreignPath = `${randomUUID()}/avatar.webp`, bucket = owner.storage.from("profile-avatars");
  // Registered before any upload: removes this test's objects (including an unexpectedly accepted
  // foreign path) with the privileged client, before afterAll deletes the account.
  onTestFinished(async () => {
    expect((await service.storage.from("profile-avatars").remove([path, foreignPath])).error).toBeNull();
    expect(await database.query("SELECT name FROM storage.objects WHERE bucket_id='profile-avatars' AND name=ANY($1)", [[path, foreignPath]])).toEqual([]);
  });
  const bytes = await sharp({ create: { width: 2, height: 2, channels: 3, background: "red" } }).webp().toBuffer();
  expect((await bucket.upload(path, bytes, { contentType: "image/webp" })).error).toBeNull();
  expect((await bucket.download(path)).error).toBeNull();
  expect((await bucket.upload(path, bytes, { contentType: "image/webp", upsert: true })).error).toBeNull();
  expect((await bucket.upload(foreignPath, bytes, { contentType: "image/webp" })).error).toBeTruthy();
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
  const openingHours = await mutateAdminOpeningHours({ operation: "create", starts_on: "0001-01-01", location_id: location.id, replace_ids: [],
    rows: [{ weekdays: [0,1,2,3,4,5,6], opens_at: "08:00", closes_at: "22:00" }] }, admin);
  expect(openingHours.ok).toBe(true);
  if (!openingHours.ok || !openingHours.schedules?.[0]) throw new Error("Opening-hours fixture failed.");
  const schedule = openingHours.schedules[0];
  const pricing = await saveAdminPricingRule({ location_id: location.id, court_ids: [court.id], court_state: "outdoor",
    weekdays: [0,1,2,3,4,5,6], starts_at: "08:00", ends_at: "22:00", starts_on: "", ends_on: "", price_per_hour: "50" }, admin);
  expect(pricing.ok).toBe(true);
  expect(await setAdminLocationPublication({ id: location.id, is_public: true }, admin)).toEqual({ ok: true, id: location.id });
  expect((await listPublicLocationsWithCourts()).some((row) => row.id === location.id)).toBe(true);
  const hours = await database.query("SELECT id FROM public.location_opening_hours WHERE location_id=$1", [location.id]);
  expect((await mutateAdminOpeningHours({ operation: "update", schedule_id: schedule.id, revision: schedule.revision, location_id: location.id,
    replace_ids: hours.map((row: { id: string }) => row.id), rows: [{ weekdays: [0,1,2,3,4,5,6], opens_at: "09:00", closes_at: "22:00" }] }, admin)))
    .toMatchObject({ ok: true, pricingAdjusted: true });
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
    const hours = "WITH baseline AS (INSERT INTO public.opening_hours_schedules(location_id,starts_on) SELECT $1,DATE '0001-01-01' WHERE NOT EXISTS (SELECT 1 FROM public.opening_hours_schedules WHERE location_id=$1) RETURNING id) INSERT INTO public.location_opening_hours(schedule_id,location_id,weekday,opens_at_minute,closes_at_minute) VALUES(coalesce((SELECT id FROM public.opening_hours_schedules WHERE location_id=$1 LIMIT 1),(SELECT id FROM baseline)),$1,0,$2,$3)";
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
    await insertBookingRecords(runner.manager, { id: bookingId, reservation_id: reservationId, customer_name: "Customer", customer_email: "customer@example.test", customer_phone: "123", total_amount_minor: 5000, currency: "EUR", cancellation_notice_minutes: 1440, status: "pending_payment", payment_method: "online" });
    const attemptId = randomUUID(), providerPaymentId = `pi_cutover_${randomUUID()}`;
    const attempt = `INSERT INTO public.payment_attempts(id,booking_id,method,provider,provider_payment_id,amount_minor,currency,status,expires_at,checkout_token_hash)
      VALUES($1,$2,'online','stripe',$3,5000,'EUR','pending',clock_timestamp()+interval '10 minutes','cutover-token')`;
    await runner.query(attempt, [attemptId, bookingId, providerPaymentId]);
    await rejects(attempt, [randomUUID(), bookingId, providerPaymentId], "23505");
    await rejects("UPDATE public.payment_attempts SET amount_minor=0 WHERE id=$1", [attemptId], "23514");
    await rejects("UPDATE public.payment_attempts SET provider_payment_id='pi_changed' WHERE id=$1", [attemptId], "23514");
    await runner.query("UPDATE public.payment_attempts SET status='failed',completed_at=clock_timestamp(),updated_at=now() WHERE id=$1", [attemptId]);
    const captureId = randomUUID(), eventId = `evt_${randomUUID()}`;
    await runner.query(`INSERT INTO public.payment_capture_receipts(id,payment_attempt_id,provider,provider_payment_id,provider_capture_id,amount_minor,currency)
      VALUES($1,$2,'stripe',$3,$3,5000,'EUR')`, [captureId, attemptId, providerPaymentId]);
    await runner.query(`INSERT INTO public.payment_capture_receipts(payment_attempt_id,provider,provider_payment_id,provider_capture_id,amount_minor,currency)
      VALUES($1,'stripe',$2,$2,5000,'EUR')
      ON CONFLICT(provider,provider_capture_id) DO UPDATE SET last_observed_at=clock_timestamp()`, [attemptId, providerPaymentId]);
    expect(await runner.query("SELECT count(*)::integer AS total FROM public.payment_capture_receipts WHERE payment_attempt_id=$1", [attemptId]))
      .toEqual([{ total: 1 }]);
    await rejects("UPDATE public.payment_capture_receipts SET amount_minor=4999 WHERE id=$1", [captureId], "23514");
    await runner.query(`INSERT INTO public.payment_provider_events(provider,event_id,attempt_id,capture_receipt_id,provider_payment_id,
      outcome,settlement_result,reconciliation_required,amount_minor,currency)
      VALUES('stripe',$1,$2,$3,$4,'succeeded','failed',true,5000,'EUR')`, [eventId, attemptId, captureId, providerPaymentId]);
    await rejects("UPDATE public.payment_provider_events SET amount_minor=4999 WHERE event_id=$1", [eventId], "23514");
    await runner.query(`UPDATE public.payment_provider_events SET reconciliation_required=false,resolved_at=clock_timestamp()
      WHERE provider='stripe' AND event_id=$1`, [eventId]);
    await rejects("DELETE FROM public.payment_provider_events WHERE event_id=$1", [eventId], "23514");
    await rejects("DELETE FROM public.payment_capture_receipts WHERE id=$1", [captureId], "23514");
    await rejects("TRUNCATE public.payment_capture_receipts CASCADE", [], "23514");
    const refund = `INSERT INTO public.payment_refunds(booking_id,payment_attempt_id,provider,provider_payment_id,amount_minor,captured_amount_minor,currency,reason,context_revision_id)
      VALUES($1,$2,'stripe',$4,$3,5000,'EUR','late_capture_compensation',(SELECT current_revision_id FROM public.bookings WHERE id=$1))`;
    await rejects(refund.replace("$3,5000,'EUR'", "$3,NULL,'EUR'"), [bookingId, attemptId, 5000, providerPaymentId], "23502");
    await rejects(refund.replace("amount_minor,captured_amount_minor,", "amount_minor,")
      .replace("$3,5000,'EUR'", "$3,'EUR'"), [bookingId, attemptId, 5000, providerPaymentId], "23502");
    await rejects(refund.replace("$3,5000,'EUR'", "$3,0,'EUR'"), [bookingId, attemptId, 5000, providerPaymentId], "23514");
    await rejects(refund, [bookingId, attemptId, 5001, providerPaymentId], "23514");
    await rejects(refund, [bookingId, attemptId, 0, providerPaymentId], "23514");
    await rejects(refund, [bookingId, randomUUID(), 5000, providerPaymentId], "23503");
    await runner.query(refund, [bookingId, attemptId, 5000, providerPaymentId]);
    await rejects(refund, [bookingId, attemptId, 5000, providerPaymentId], "23505");
    await rejects("DELETE FROM public.bookings WHERE id=$1", [bookingId], "23503");
    await rejects("DELETE FROM public.payment_attempts WHERE id=$1", [attemptId], "23514");
    await rejects("UPDATE public.payment_refunds SET captured_amount_minor=4999 WHERE payment_attempt_id=$1", [attemptId], "23514");
    await rejects("UPDATE public.payment_refunds SET provider_generation=-1 WHERE payment_attempt_id=$1", [attemptId], "42703");
    await rejects("UPDATE public.payment_refunds SET provider_history='{}'::jsonb WHERE payment_attempt_id=$1", [attemptId], "42703");
    await rejects("UPDATE public.payment_refunds SET adjustment_id=$1 WHERE payment_attempt_id=$2", [randomUUID(), attemptId], "23514");
    await rejects("UPDATE public.payment_attempts SET adjustment_id=$1 WHERE id=$2", [randomUUID(), attemptId], "23514");
    await rejects("UPDATE public.court_reservations SET hold_expires_at=NULL WHERE id=$1", [reservationId], "23514");
    await rejects(reservation, [courtId, 720, 750], "23514");
    const schedule = "INSERT INTO public.opening_hours_schedules(location_id,starts_on,ends_on) VALUES($1,$2,$3)";
    await rejects(schedule, [locationId, "2099-01-01", "2099-12-31"], "23P01");
    await rejects(schedule, [locationId, "2100-12-31", "2100-01-01"], "23514");
    const adjustmentId = randomUUID();
    const adjustment = `INSERT INTO public.booking_adjustments(id,booking_id,base_revision_id,actor_id,scope,request_key,target,original_total,new_total,currency,status,expires_at)
      VALUES($1,$2,(SELECT current_revision_id FROM public.bookings WHERE id=$2),$3,'owner',$4,'{"courtName":"Court","locationName":"Location","timezone":"UTC"}',5000,6000,'EUR','pending',clock_timestamp()+interval '10 minutes')`;
    await runner.query(adjustment, [adjustmentId, bookingId, userIds[0], "first"]);
    await rejects(adjustment, [randomUUID(), bookingId, userIds[0], "first"], "23505");
    await rejects(adjustment, [randomUUID(), bookingId, userIds[0], "second"], "23505");
    for (const change of ["scope='invalid'", "target='[]'::jsonb", "original_total=0", "new_total=0", "status='invalid'", "expires_at='infinity'"]) {
      await rejects(`UPDATE public.booking_adjustments SET ${change} WHERE id=$1`, [adjustmentId], "23514");
    }
    await rejects("UPDATE public.payment_attempts SET adjustment_id=$1 WHERE id=$2", [adjustmentId, attemptId], "23514");
    await runner.query(`INSERT INTO public.payment_attempts(booking_id,adjustment_id,method,amount_minor,currency,status)
      VALUES($1,$2,'pay_at_club',1000,'EUR','due')`, [bookingId, adjustmentId]);
    await rejects(`INSERT INTO public.payment_attempts(booking_id,adjustment_id,method,amount_minor,currency,status)
      VALUES($1,$2,'pay_at_club',1000,'EUR','due')`, [bookingId, adjustmentId], "23505");
    const fragment = `INSERT INTO public.court_reservations(id,court_id,adjustment_id,booking_date,starts_at_minute,ends_at_minute,status,hold_expires_at)
      VALUES($1,$2,$3,'2099-01-01',720,750,'held',clock_timestamp()+interval '10 minutes')`;
    const fragmentId = randomUUID();
    await rejects(fragment, [fragmentId, courtId, randomUUID()], "23503");
    await runner.query(fragment, [fragmentId, courtId, adjustmentId]);
    await rejects("UPDATE public.court_reservations SET status='active',hold_expires_at=NULL WHERE id=$1", [fragmentId], "23514");
    await rejects("DELETE FROM public.booking_adjustments WHERE id=$1", [adjustmentId], "23503");
    await rejects("UPDATE public.payment_refunds SET adjustment_id=$1,captured_amount_minor=5000 WHERE payment_attempt_id=$2", [adjustmentId, attemptId], "23514");
    await runner.query(`INSERT INTO public.payment_refunds(booking_id,payment_attempt_id,adjustment_id,operation_key,provider,provider_payment_id,amount_minor,captured_amount_minor,currency,reason,context_revision_id)
      VALUES($1,$2,$3,'adjustment','stripe',$4,1000,5000,'EUR','failed_adjustment_compensation',(SELECT current_revision_id FROM public.bookings WHERE id=$1))`, [bookingId, attemptId, adjustmentId, providerPaymentId]);
    await runner.query("UPDATE public.court_reservations SET status='released',hold_expires_at=NULL WHERE id=$1", [fragmentId]);

  } finally { await runner.rollbackTransaction(); await runner.release(); }
});

test("revision history rejects cross-booking pointers, non-linear appends, orphan heads and UPDATE/DELETE/TRUNCATE", async () => {
  const runner=database.createQueryRunner();await runner.startTransaction();
  const location=randomUUID(),court=randomUUID(),first=randomUUID(),second=randomUUID(),r1=randomUUID(),r2=randomUUID();
  async function rejects(work:()=>Promise<unknown>,code:string) {
    await runner.query("SAVEPOINT invalid_revision");
    try {await expect(work()).rejects.toMatchObject({driverError:{code}});}
    finally {await runner.query("ROLLBACK TO SAVEPOINT invalid_revision");}
  }
  try {
    await runner.query("INSERT INTO public.locations(id,name,slug,timezone) VALUES($1::uuid,'Revision integrity',($1::uuid)::text,'UTC')",[location]);
    await runner.query("INSERT INTO public.courts(id,location_id,name,slug,surface,environment) VALUES($1,$2,'Court','court','hard','outdoor')",[court,location]);
    await runner.query(`INSERT INTO public.court_reservations(id,court_id,booking_date,starts_at_minute,ends_at_minute)
      VALUES($1,$3,'2099-10-15',600,660),($2,$3,'2099-10-15',660,720)`,[r1,r2,court]);
    for(const [id,reservation_id] of [[first,r1],[second,r2]]) await insertBookingRecords(runner.manager,{id,reservation_id,
      customer_name:"Customer",customer_email:"revision@example.test",customer_phone:"123",total_amount_minor:5000,currency:"EUR",payment_method:"pay_at_club",cancellation_notice_minutes:1440});
    await runner.query("SET CONSTRAINTS ALL IMMEDIATE");await runner.query("SET CONSTRAINTS ALL DEFERRED");
    const rows:{id:string;current_revision_id:string}[]=await runner.query("SELECT id,current_revision_id FROM public.bookings WHERE id=ANY($1::uuid[])",[[first,second]]);
    const head=rows.find(b=>b.id===first)!.current_revision_id,other=rows.find(b=>b.id===second)!.current_revision_id;
    await rejects(async()=>{
      await runner.query("UPDATE public.bookings SET current_revision_id=$1 WHERE id=$2",[other,first]);
      await runner.query("SET CONSTRAINTS bookings_current_revision_fkey IMMEDIATE");
    },"23503");
    for(const sql of ["UPDATE public.booking_revisions SET total_amount_minor=1 WHERE id=$1",
      "DELETE FROM public.booking_revisions WHERE id=$1","TRUNCATE public.booking_revisions CASCADE"])
      await rejects(()=>runner.query(sql,sql.startsWith("TRUNCATE") ? []:[head]),"23514");
    const append=`INSERT INTO public.booking_revisions SELECT $1,booking_id,$3,$4,'probe','probe','rescheduled','confirmed',
      location_id,court_id,location_name,court_name,timezone,booking_date,starts_at_minute,ends_at_minute,customer_name,customer_email,customer_phone,
      total_amount_minor,currency,payment_method,cancellation_notice_minutes,actor_user_id,actor_scope,recorded_at,NULL,NULL,pricing_evidence
      FROM public.booking_revisions WHERE id=$2`;
    await rejects(()=>runner.query(append,[randomUUID(),head,2,other]),"23514");
    await rejects(()=>runner.query(append,[randomUUID(),head,3,head]),"23514");
    await rejects(async()=>{
      await runner.query(append,[randomUUID(),head,2,head]);
      await runner.query("SET CONSTRAINTS ALL IMMEDIATE");
    },"23514");
    const next=randomUUID();await runner.query(append,[next,head,2,head]);
    await runner.query("UPDATE public.bookings SET current_revision_id=$1 WHERE id=$2",[next,first]);
    await runner.query("SET CONSTRAINTS ALL IMMEDIATE");await runner.query("SET CONSTRAINTS ALL DEFERRED");
    await rejects(async()=>{
      await runner.query("UPDATE public.bookings SET current_revision_id=$1 WHERE id=$2",[head,first]);
      await runner.query("SET CONSTRAINTS ALL IMMEDIATE");
    },"23514");
    await rejects(()=>runner.query("DELETE FROM public.bookings WHERE id=$1",[first]),"23503");
    expect(await runner.query("SELECT revision_number FROM public.booking_revisions WHERE booking_id=$1 ORDER BY revision_number",[first]))
      .toEqual([{revision_number:1},{revision_number:2}]);
  } finally {await runner.rollbackTransaction();await runner.release();}
});
