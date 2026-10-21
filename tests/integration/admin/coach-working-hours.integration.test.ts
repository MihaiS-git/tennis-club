import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, assert, beforeAll, expect, test, vi } from "vitest";
import type { DataSource } from "typeorm";
import { mutateAdminOpeningHours } from "../../../src/lib/admin/opening-hours";
import { saveCoachProfile } from "../../../src/lib/coaching/admin";
import { changeCoachAvailability, changeOwnCoachAvailability } from "../../../src/lib/coaching/availability";
import { resolveCoachAvailability } from "../../../src/lib/coaching/availability-schedule";
import { localToday } from "../../../src/lib/courts/local-time";
import { getDataSource } from "../../../src/lib/db/data-source";
import * as coachAvailability from "../../../src/lib/db/repositories/coach-availability.repository";
import * as clubs from "../../../src/lib/db/repositories/clubs.repository";
import { mondayWeekday } from "../../../src/lib/pricing/resolution";
import { cleanupAuthFixtures, localFixtureClient } from "../auth-fixtures";
import { ensureIntegrationAdminAnchor } from "../admin-anchor";

// Coach working hours always lie inside their location's effective-dated opening hours.
// Location A (Europe/Bucharest): Mon–Fri 07:00–22:00, Sat 08:00–20:00, Sun closed.
// Location B (Europe/Bucharest): open around the clock. Coach 1 works at A and B, coach 2 at A.
const service = localFixtureClient();
const password = "working-hours-integration-password-123";
const userIds: string[] = [];
const [locationA, locationB] = [randomUUID(), randomUUID()];
const court = randomUUID();
let database: DataSource;
let admin: SupabaseClient, coach1: { id: string; client: SupabaseClient }, coach2: { id: string; client: SupabaseClient };
let today: string;

const publicClient = () => createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_PUBLISHABLE_KEY!, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});

async function account(roles: ("admin" | "coach")[]) {
  const email = `working-hours-${randomUUID()}@example.test`;
  const { data, error } = await service.auth.admin.createUser({ email, password, email_confirm: true });
  assert.strictEqual(error, null); assert.ok(data.user);
  userIds.push(data.user.id);
  for (const role of roles) assert.strictEqual((await service.from("user_roles").insert({ user_id: data.user.id, role_code: role })).error, null);
  const client = publicClient();
  assert.strictEqual((await client.auth.signInWithPassword({ email, password })).error, null);
  return { client, id: data.user.id };
}

function addDays(date: string, days: number) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}
// The first date after `date` falling on the Monday-first weekday.
const nextWeekday = (date: string, weekday: number) => addDays(date, (weekday - mondayWeekday(date) + 6) % 7 + 1);

const addWeekly = (location_id: string, weekdays: number[], start_minute: number, end_minute: number, dates: { valid_from?: string; valid_until?: string | null } = {}) =>
  ({ operation: "add-weekly", fields: { location_id, weekdays, start_minute, end_minute, ...dates } });

type Row = { id: string; coach: string; weekday: number; start: number; end: number; from: string; until: string | null; updated_at: string };
async function hoursAt(location: string): Promise<Row[]> {
  return database.query(`SELECT id,coach_user_id AS coach,weekday,start_minute AS start,end_minute AS end,valid_from::text AS from,valid_until::text AS until,
    updated_at::text FROM public.coach_weekly_availability WHERE location_id=$1 ORDER BY coach_user_id,weekday,valid_from,start_minute`, [location]);
}
const shape = (rows: readonly Row[], coach: string) => rows.filter((row) => row.coach === coach).map(({ weekday, start, end, from, until }) => [weekday, start, end, from, until]);

async function baseline(location: string) {
  const schedule = (await clubs.listOpeningHoursSchedules(database.manager, location)).find((row) => row.startsOn === "0001-01-01");
  assert.ok(schedule);
  return schedule;
}

// Replaces the baseline schedule's intervals on the given weekdays.
async function replaceHours(location: string, weekdays: number[], rows: { weekdays: number[]; opens_at: string; closes_at: string }[]) {
  const schedule = await baseline(location);
  const replace_ids = (await clubs.listLocationOpeningHours(database.manager, location))
    .filter((row) => row.scheduleId === schedule.id && weekdays.includes(row.weekday)).map((row) => row.id);
  return mutateAdminOpeningHours({ operation: "update", location_id: location, schedule_id: schedule.id, revision: schedule.revision, replace_ids, rows }, admin);
}

beforeAll(async () => {
  expect(process.env.TEST_SUPABASE_PROJECT).toBe("tennis-club-tests");
  await ensureIntegrationAdminAnchor(service);
  database = await getDataSource();
  admin = (await account(["admin"])).client;
  coach1 = await account(["coach"]);
  coach2 = await account(["coach"]);
  assert.strictEqual((await service.from("locations").insert([
    { id: locationA, name: "Working hours A", slug: `working-hours-a-${locationA}`, timezone: "Europe/Bucharest" },
    { id: locationB, name: "Working hours B", slug: `working-hours-b-${locationB}`, timezone: "Europe/Bucharest" },
  ])).error, null);
  await database.query("INSERT INTO public.courts(id,location_id,name,slug,surface,environment) VALUES($1,$2,'Working hours court',$3,'clay','outdoor')",
    [court, locationA, `working-hours-${court}`]);
  assert.ok((await mutateAdminOpeningHours({ operation: "create", starts_on: "0001-01-01", location_id: locationA, replace_ids: [], rows: [
    { weekdays: [0, 1, 2, 3, 4], opens_at: "07:00", closes_at: "22:00" }, { weekdays: [5], opens_at: "08:00", closes_at: "20:00" },
  ] }, admin)).ok);
  assert.ok((await mutateAdminOpeningHours({ operation: "create", starts_on: "0001-01-01", location_id: locationB, replace_ids: [],
    rows: [{ weekdays: [0, 1, 2, 3, 4, 5, 6], opens_at: "00:00", closes_at: "24:00" }] }, admin)).ok);
  const fields = (location_ids: string[]) => ({ display_name: "Working Hours Coach", bio: "", qualifications: "", specialties: [], languages: [],
    location_ids, program_ids: [], is_public: false });
  expect(await saveCoachProfile({ user_id: coach1.id, create: true, fields: fields([locationA, locationB]) }, admin)).toEqual({ ok: true, id: coach1.id });
  expect(await saveCoachProfile({ user_id: coach2.id, create: true, fields: fields([locationA]) }, admin)).toEqual({ ok: true, id: coach2.id });
  today = localToday("Europe/Bucharest", new Date());
});

afterAll(async () => {
  if (!database) return;
  try {
    await database.query("DELETE FROM public.court_reservations WHERE court_id=$1", [court]);
    await database.query("DELETE FROM public.courts WHERE id=$1", [court]);
    await database.query("DELETE FROM public.coach_weekly_availability WHERE coach_user_id=ANY($1::uuid[])", [userIds]);
    await database.query("DELETE FROM public.coach_profiles WHERE user_id=ANY($1::uuid[])", [userIds]);
    await database.query("DELETE FROM public.pricing_rule_sets WHERE location_id=ANY($1::uuid[])", [[locationA, locationB]]);
    await database.query("DELETE FROM public.location_opening_hours WHERE location_id=ANY($1::uuid[])", [[locationA, locationB]]);
    await database.query("DELETE FROM public.opening_hours_schedules WHERE location_id=ANY($1::uuid[])", [[locationA, locationB]]);
    await database.query("DELETE FROM public.locations WHERE id=ANY($1::uuid[])", [[locationA, locationB]]);
    await cleanupAuthFixtures(service, userIds);
  } finally {
    await database.destroy();
  }
});

test("coach hours follow opening-hour validation, shrinkage, extension and future schedules", async () => {
  {
    // Inside: Monday and Tuesday 08:00–21:00, from today without an end.
    const inside = await changeOwnCoachAvailability(addWeekly(locationA, [0, 1], 480, 1260), coach1.client);
    assert.ok(inside.ok);
    expect(shape(await hoursAt(locationA), coach1.id)).toEqual([[0, 480, 1260, today, null], [1, 480, 1260, today, null]]);
    // Each weekday is validated independently; one invalid day saves nothing.
    expect(await changeOwnCoachAvailability(addWeekly(locationA, [2, 5, 6], 540, 720), coach1.client))
      .toEqual({ ok: false, reason: "outside-opening-hours", weekdays: [6] });
    expect(await changeOwnCoachAvailability(addWeekly(locationA, [2, 5], 420, 540), coach1.client))
      .toEqual({ ok: false, reason: "outside-opening-hours", weekdays: [5] });
    expect(await changeCoachAvailability({ coach_user_id: coach1.id, change: { operation: "save-weekly",
      fields: { location_id: locationA, weekday: 2, start_minute: 1260, end_minute: 1380 } } }, admin))
      .toEqual({ ok: false, reason: "outside-opening-hours", weekdays: [2] });
    // An edit is revalidated too.
    const tuesday = (await hoursAt(locationA)).find((row) => row.coach === coach1.id && row.weekday === 1);
    assert.ok(tuesday);
    expect(await changeOwnCoachAvailability({ operation: "save-weekly", id: tuesday.id,
      fields: { location_id: locationA, weekday: 1, start_minute: 360, end_minute: 1260 } }, coach1.client))
      .toEqual({ ok: false, reason: "outside-opening-hours", weekdays: [1] });
    expect(shape(await hoursAt(locationA), coach1.id)).toHaveLength(2);
    // Dates are validated: no past start and an ordered range.
    expect(await changeOwnCoachAvailability(addWeekly(locationA, [2], 540, 600, { valid_from: addDays(today, -1) }), coach1.client))
      .toMatchObject({ ok: false, reason: "invalid-input", fieldErrors: { valid_from: expect.any(String) } });
    expect(await changeOwnCoachAvailability(addWeekly(locationA, [2], 540, 600, { valid_from: addDays(today, 5), valid_until: addDays(today, 4) }), coach1.client))
      .toMatchObject({ ok: false, reason: "invalid-input" });

    // Another location has its own opening hours.
    assert.ok((await changeOwnCoachAvailability(addWeekly(locationB, [2, 6], 1260, 1380), coach1.client)).ok);
    // Coach 2: Monday 10:00–20:00, Friday 20:00–22:00, Saturday 10:00–12:00, and a
    // Thursday interval that has applied since 2000 (history before today).
    assert.ok((await changeCoachAvailability({ coach_user_id: coach2.id, change: addWeekly(locationA, [0], 600, 1200) }, admin)).ok);
    assert.ok((await changeCoachAvailability({ coach_user_id: coach2.id, change: addWeekly(locationA, [4], 1200, 1320) }, admin)).ok);
    assert.ok((await changeCoachAvailability({ coach_user_id: coach2.id, change: addWeekly(locationA, [5], 600, 720) }, admin)).ok);
    await database.query(`INSERT INTO public.coach_weekly_availability(coach_user_id,location_id,weekday,start_minute,end_minute,valid_from)
      VALUES($1,$2,3,420,1320,'2000-01-03')`, [coach2.id, locationA]);
  }
  {
    const monday = nextWeekday(today, 0);
    const lesson = (start: number, end: number) => database.query(`INSERT INTO public.court_reservations(court_id,coach_user_id,booking_date,starts_at_minute,ends_at_minute)
      VALUES($1,$2,$3,$4,$5) RETURNING id`, [court, coach1.id, monday, start, end]).then(([row]: { id: string }[]) => row.id);
    const [early, inside] = [await lesson(480, 540), await lesson(600, 660)];
    const booking = async () => database.query("SELECT to_jsonb(r) AS row FROM public.court_reservations r WHERE id=ANY($1::uuid[]) ORDER BY id", [[early, inside]]);
    const atB = await hoursAt(locationB);
    const before = await hoursAt(locationA);
    const schedule = await baseline(locationA);
    const openingHours = await clubs.listLocationOpeningHours(database.manager, locationA);

    // A live coaching lesson that the new hours would exclude rejects the whole change.
    const unchangedBooking = await booking();
    expect(await replaceHours(locationA, [0, 1, 2, 3, 4, 5], [{ weekdays: [0, 1, 2, 3, 4], opens_at: "09:00", closes_at: "20:00" }]))
      .toEqual({ ok: false, reason: "booking-conflict", dates: [monday] });
    expect(await booking()).toEqual(unchangedBooking);
    expect(await hoursAt(locationA)).toEqual(before);
    expect(await clubs.listLocationOpeningHours(database.manager, locationA)).toEqual(openingHours);
    expect((await baseline(locationA)).revision).toBe(schedule.revision);
    // Once that lesson is cancelled (its record stays), the change can proceed.
    await database.query("UPDATE public.court_reservations SET status='cancelled',cancelled_at=now(),cancelled_by_user_id=$2 WHERE id=$1", [early, coach1.id]);
    const bookingBefore = await booking();

    // A failure after reconciliation rolls everything back.
    const replace = coachAvailability.replaceCoachWeeklyAvailability;
    const failure = vi.spyOn(coachAvailability, "replaceCoachWeeklyAvailability").mockImplementationOnce(async (...args) => {
      await replace(...args);
      throw new Error("Injected reconciliation failure");
    });
    try {
      await expect(replaceHours(locationA, [0, 1, 2, 3, 4, 5], [{ weekdays: [0, 1, 2, 3, 4], opens_at: "09:00", closes_at: "20:00" }]))
        .rejects.toThrow("Unable to change opening hours.");
    } finally { failure.mockRestore(); }
    expect(await hoursAt(locationA)).toEqual(before);
    expect((await baseline(locationA)).revision).toBe(schedule.revision);

    // Mon–Fri 07:00–22:00 → 09:00–20:00 and Saturday closes.
    const result = await replaceHours(locationA, [0, 1, 2, 3, 4, 5], [{ weekdays: [0, 1, 2, 3, 4], opens_at: "09:00", closes_at: "20:00" }]);
    expect(result).toMatchObject({ ok: true, workingHoursAdjusted: true });
    const after = await hoursAt(locationA);
    // Coach 1: 08:00–21:00 → 09:00–20:00, keeping the row identity.
    expect(shape(after, coach1.id)).toEqual([[0, 540, 1200, today, null], [1, 540, 1200, today, null]]);
    expect(after.filter((row) => row.coach === coach1.id).map((row) => row.id)).toEqual(before.filter((row) => row.coach === coach1.id).map((row) => row.id));
    // Coach 2: inside unchanged; entirely outside removed; closed Saturday removed; the
    // interval since 2000 keeps its history before today and is trimmed from today.
    expect(shape(after, coach2.id)).toEqual([
      [0, 600, 1200, today, null],
      [3, 420, 1320, "2000-01-03", addDays(today, -1)], [3, 540, 1200, today, null],
    ]);
    const unchanged = before.find((row) => row.coach === coach2.id && row.weekday === 0);
    expect(after.find((row) => row.id === unchanged?.id)).toEqual(unchanged);
    // Other locations, bookings and their records are untouched.
    expect(await hoursAt(locationB)).toEqual(atB);
    expect(await booking()).toEqual(bookingBefore);
    // Booking availability resolves the reconciled hours.
    const day = await coachAvailability.listCoachDayAvailability(database.manager, coach1.id, monday);
    expect(day.weekly).toEqual([{ location_id: locationA, weekday: 0, start_minute: 540, end_minute: 1200 }]);
    expect(resolveCoachAvailability({ date: monday, weekly: day.weekly, exceptions: day.exceptions, timezones: new Map([[locationA, "Europe/Bucharest"]]) })
      .map((window) => [window.start_minute, window.end_minute])).toEqual([[540, 1200]]);
  }
  {
    const before = await hoursAt(locationA);
    const result = await replaceHours(locationA, [0, 1, 2, 3, 4], [{ weekdays: [0, 1, 2, 3, 4, 5], opens_at: "07:00", closes_at: "22:00" }]);
    expect(result).toMatchObject({ ok: true, workingHoursAdjusted: false });
    expect(await hoursAt(locationA)).toEqual(before);
    // Only an explicit change extends them.
    const monday = before.find((row) => row.coach === coach1.id && row.weekday === 0);
    assert.ok(monday);
    expect(await changeOwnCoachAvailability({ operation: "save-weekly", id: monday.id,
      fields: { location_id: locationA, weekday: 0, start_minute: 480, end_minute: 1260 } }, coach1.client)).toEqual({ ok: true, id: monday.id });
  }
  {
    const atB = await hoursAt(locationB);
    const starts = addDays(today, 70);
    const created = await mutateAdminOpeningHours({ operation: "create", location_id: locationA, starts_on: starts, replace_ids: [],
      rows: [{ weekdays: [0, 1, 2, 3, 4, 5], opens_at: "10:00", closes_at: "18:00" }] }, admin);
    expect(created).toMatchObject({ ok: true, workingHoursAdjusted: true });
    const until = addDays(starts, -1);
    expect(shape(await hoursAt(locationA), coach1.id)).toEqual([
      [0, 480, 1260, today, until], [0, 600, 1080, starts, null],
      [1, 540, 1200, today, until], [1, 600, 1080, starts, null],
    ]);
    expect(shape(await hoursAt(locationA), coach2.id)).toEqual([
      [0, 600, 1200, today, until], [0, 600, 1080, starts, null],
      [3, 420, 1320, "2000-01-03", addDays(today, -1)], [3, 540, 1200, today, until], [3, 600, 1080, starts, null],
    ]);
    expect(await hoursAt(locationB)).toEqual(atB);
    // Booking availability uses the hours valid on each date.
    const day = async (date: string) => (await coachAvailability.listCoachDayAvailability(database.manager, coach1.id, date)).weekly
      .filter((row) => row.location_id === locationA).map((row) => [row.start_minute, row.end_minute]);
    expect(await day(nextWeekday(today, 0))).toEqual([[480, 1260]]);
    expect(await day(nextWeekday(until, 0))).toEqual([[600, 1080]]);
    // New hours are checked against the period they apply in.
    expect(await changeOwnCoachAvailability(addWeekly(locationA, [2], 480, 1260), coach1.client))
      .toEqual({ ok: false, reason: "outside-opening-hours", weekdays: [2] });
    const bounded = await changeOwnCoachAvailability(addWeekly(locationA, [2], 480, 1260, { valid_until: until }), coach1.client);
    assert.ok(bounded.ok);

    // Deleting the future schedule leaves its dates without opening hours: the hours
    // that applied there are removed, earlier dates keep theirs.
    const schedule = created.ok ? created.schedules?.find((row) => row.id === created.scheduleId) : undefined;
    assert.ok(schedule);
    expect(await mutateAdminOpeningHours({ operation: "delete", location_id: locationA, schedule_id: schedule.id, revision: schedule.revision }, admin))
      .toMatchObject({ ok: true, workingHoursAdjusted: true });
    expect(shape(await hoursAt(locationA), coach1.id)).toEqual([[0, 480, 1260, today, until], [1, 540, 1200, today, until], [2, 480, 1260, today, until]]);
    expect(await day(nextWeekday(until, 0))).toEqual([]);
    expect(await hoursAt(locationB)).toEqual(atB);
  }
});

test("PostgreSQL keeps dated intervals ordered and lets one coach's periods follow each other", async () => {
  const insert = (weekday: number, from: string, until: string | null) => database.query(`INSERT INTO public.coach_weekly_availability(coach_user_id,location_id,weekday,start_minute,end_minute,valid_from,valid_until)
    VALUES($1,$2,$3,0,60,$4,$5)`, [coach1.id, locationB, weekday, from, until]);
  await expect(insert(4, "2030-02-01", "2030-01-31")).rejects.toMatchObject({ driverError: { code: "23514", constraint: "coach_weekly_availability_dates_check" } });
  await insert(4, "2030-01-01", "2030-01-31");
  await insert(4, "2030-02-01", null);
  await expect(insert(4, "2030-01-31", "2030-02-01")).rejects.toMatchObject({ driverError: { code: "23P01", constraint: "coach_weekly_availability_no_overlap" } });
});

test("split-day weekday batches remain independent, with atomic overlap and validity protection", async () => {
  const coach = await account(["coach"]);
  expect(await saveCoachProfile({ user_id: coach.id, create: true, fields: {
    display_name: "Split Day Coach", bio: "", qualifications: "", specialties: [], languages: [],
    location_ids: [locationA, locationB], program_ids: [], is_public: false,
  } }, admin)).toEqual({ ok: true, id: coach.id });
  expect(await replaceHours(locationA, [0, 1, 2, 3, 4], [
    { weekdays: [0, 1, 2, 3, 4], opens_at: "08:00", closes_at: "12:00" },
    { weekdays: [0, 1, 2, 3, 4], opens_at: "14:00", closes_at: "21:00" },
  ])).toMatchObject({ ok: true });
  const weekdays = [0, 1, 2, 3, 4];
  const dates = { valid_from: today, valid_until: addDays(today, 28) };
  const change = (location: string, days: number[], start: number, end: number, validity = dates) =>
    changeCoachAvailability({ coach_user_id: coach.id, change: addWeekly(location, days, start, end, validity) }, admin);
  const morning = await change(locationA, weekdays, 480, 720);
  const afternoon = await change(locationA, weekdays, 840, 1260);
  assert.ok(morning.ok && afternoon.ok);
  expect(morning.ids).toHaveLength(5);
  expect(afternoon.ids).toHaveLength(5);
  const saved = (await hoursAt(locationA)).filter((row) => row.coach === coach.id);
  expect(shape(saved, coach.id)).toEqual(weekdays.flatMap((day) => [
    [day, 480, 720, today, dates.valid_until], [day, 840, 1260, today, dates.valid_until],
  ]));
  // One conflicting day rejects the whole batch, including its free Saturday.
  expect(await change(locationA, [0, 5], 660, 900)).toEqual({ ok: false, reason: "overlap", weekdays: [0] });
  expect(await change(locationB, [0, 5], 660, 900)).toEqual({ ok: false, reason: "overlap", weekdays: [0] });
  expect(await change(locationA, weekdays, 720, 840)).toEqual({ ok: false, reason: "outside-opening-hours", weekdays });
  expect((await hoursAt(locationA)).filter((row) => row.coach === coach.id)).toEqual(saved);
  expect((await hoursAt(locationB)).filter((row) => row.coach === coach.id)).toEqual([]);
  // Inclusive validity dates can follow each other without sharing any date.
  expect(await change(locationA, weekdays, 480, 720,
    { valid_from: addDays(today, 29), valid_until: addDays(today, 56) })).toMatchObject({ ok: true });
  // Adjacent hours at the continuously open second location are independent too.
  expect(await change(locationB, [5], 480, 720)).toMatchObject({ ok: true });
  expect(await change(locationB, [5], 720, 960)).toMatchObject({ ok: true });
  const monday = nextWeekday(today, 0);
  const day = await coachAvailability.listCoachDayAvailability(database.manager, coach.id, monday);
  expect(day.weekly).toEqual([
    { location_id: locationA, weekday: 0, start_minute: 480, end_minute: 720 },
    { location_id: locationA, weekday: 0, start_minute: 840, end_minute: 1260 },
  ]);
  // Bypass the service to verify PostgreSQL still rejects real cross-location overlap.
  await expect(database.query(`INSERT INTO public.coach_weekly_availability
    (coach_user_id,location_id,weekday,start_minute,end_minute,valid_from,valid_until)
    VALUES($1,$2,0,660,900,$3,$4)`, [coach.id, locationB, today, dates.valid_until]))
    .rejects.toMatchObject({ driverError: { code: "23P01", constraint: "coach_weekly_availability_no_overlap" } });
});
