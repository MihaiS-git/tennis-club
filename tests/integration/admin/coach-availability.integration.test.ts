import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { afterAll, assert, expect, test } from "vitest";
import { getDataSource } from "../../../src/lib/db/data-source";
import { saveCoachProfile } from "../../../src/lib/coaching/admin";
import {
  changeCoachAvailability, changeOwnCoachAvailability, loadAdminCoachAvailability, loadOwnCoachAvailability,
} from "../../../src/lib/coaching/availability";
import { resolveCoachAvailability } from "../../../src/lib/coaching/availability-schedule";
import { listCoachDayAvailability } from "@/lib/db/repositories/coach-availability.repository";
import { localToday } from "../../../src/lib/courts/local-time";
import { cleanupAuthFixtures, localFixtureClient } from "../auth-fixtures";
import { ensureIntegrationAdminAnchor } from "../admin-anchor";
import { insertOpeningHoursFixture } from "../opening-hours-fixtures";

const service = localFixtureClient();
const password = "availability-integration-password-123";
const userIds: string[] = [];
// A: Europe/Bucharest, B: UTC, C: assigned to nobody.
const [locationA, locationB, locationC] = [randomUUID(), randomUUID(), randomUUID()];
const courtIds: string[] = [];
const locationIds = [locationA, locationB, locationC];
const publicClient = () => createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_PUBLISHABLE_KEY!, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});

async function account(roles: ("admin" | "coach")[] = []) {
  const email = `availability-${randomUUID()}@example.test`;
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

const weekly = (location_id: string, weekday: number, start_minute: number, end_minute: number) =>
  ({ operation: "save-weekly", fields: { location_id, weekday, start_minute, end_minute } });
const addWeekly = (location_id: string, weekdays: number[], start_minute: number, end_minute: number) =>
  ({ operation: "add-weekly", fields: { location_id, weekdays, start_minute, end_minute } });
const absence = (date: string, start_minute: number | null = null, end_minute: number | null = null) =>
  ({ operation: "save-exception", fields: { date, kind: "unavailable", location_id: null, start_minute, end_minute, note: "Vacation" } });
const extra = (date: string, location_id: string, start_minute: number, end_minute: number) =>
  ({ operation: "save-exception", fields: { date, kind: "available", location_id, start_minute, end_minute, note: "" } });
const coachFields = (location_ids: string[]) => ({ display_name: "Availability Coach", bio: "", qualifications: "", specialties: [], languages: [],
  location_ids, program_ids: [], is_public: false });

afterAll(async () => {
  const database = await getDataSource();
  try {
    await database.query("DELETE FROM public.court_reservations WHERE court_id = ANY($1::uuid[])", [courtIds]);
    await database.query("DELETE FROM public.courts WHERE id = ANY($1::uuid[])", [courtIds]);
    await database.query("DELETE FROM public.coach_availability_exceptions WHERE coach_user_id = ANY($1::uuid[])", [userIds]);
    await database.query("DELETE FROM public.coach_weekly_availability WHERE coach_user_id = ANY($1::uuid[])", [userIds]);
    await database.query("DELETE FROM public.coach_profiles WHERE user_id = ANY($1::uuid[])", [userIds]);
    await database.query("DELETE FROM public.location_opening_hours WHERE location_id = ANY($1::uuid[])", [locationIds]);
    await database.query("DELETE FROM public.opening_hours_schedules WHERE location_id = ANY($1::uuid[])", [locationIds]);
    await database.query("DELETE FROM public.locations WHERE id = ANY($1::uuid[])", [locationIds]);
    await cleanupAuthFixtures(service, userIds);
  } finally {
    await database.destroy();
  }
});

test("coach availability enforces ownership, Admin authorization, eligibility, schedules and database constraints", async () => {
  await ensureIntegrationAdminAnchor(service);
  assert.strictEqual((await service.from("locations").insert([
    { id: locationA, name: "Availability East", slug: `availability-east-${locationA}`, timezone: "Europe/Bucharest" },
    { id: locationB, name: "Availability West", slug: `availability-west-${locationB}`, timezone: "UTC" },
    { id: locationC, name: "Availability North", slug: `availability-north-${locationC}`, timezone: "UTC" },
  ])).error, null);
  // Open around the clock: containment in opening hours is covered by coach-working-hours.
  for (const location_id of [locationA, locationB]) {
    assert.strictEqual((await insertOpeningHoursFixture(service, Array.from({ length: 7 }, (_, weekday) => ({
      location_id, weekday, opens_at_minute: 0, closes_at_minute: 1440 })))).error, null);
  }
  const admin = await account(["admin"]);
  const coach = await account(["coach"]);
  const otherCoach = await account(["coach"]);
  const adminCoach = await account(["admin", "coach"]);
  const profileless = await account(["coach"]);
  const member = await account();
  const database = await getDataSource();
  for (const [id, locations] of [[coach.id, [locationA, locationB]], [otherCoach.id, [locationA]], [adminCoach.id, [locationB]]] as const) {
    expect(await saveCoachProfile({ user_id: id, create: true, fields: coachFields([...locations]) }, admin.client)).toEqual({ ok: true, id });
  }
  const rows = async (coachId: string) => database.query(`SELECT location_id,weekday,start_minute,end_minute FROM public.coach_weekly_availability
    WHERE coach_user_id=$1 ORDER BY weekday,start_minute`, [coachId]);

  // Members, anonymous visitors and Admins without the Coach role have no Coach area;
  // only Admins manage other coaches.
  for (const session of [member.client, publicClient(), admin.client]) {
    await expect(loadOwnCoachAvailability(session)).rejects.toThrow();
    await expect(changeOwnCoachAvailability(weekly(locationA, 0, 540, 720), session)).rejects.toThrow();
  }
  for (const session of [member.client, publicClient(), coach.client]) {
    await expect(loadAdminCoachAvailability(coach.id, session)).rejects.toThrow();
    await expect(changeCoachAvailability({ coach_user_id: coach.id, change: weekly(locationA, 0, 540, 720) }, session)).rejects.toThrow();
  }
  expect(await rows(coach.id)).toEqual([]);
  // A coach without a profile has no assigned locations to schedule.
  expect(await loadOwnCoachAvailability(profileless.client)).toBeNull();
  expect(await changeOwnCoachAvailability(weekly(locationA, 0, 540, 720), profileless.client)).toEqual({ ok: false, reason: "not-eligible" });

  // Weekly CRUD: multiple intervals per day and multiple locations.
  const mondayMorning = await changeOwnCoachAvailability(weekly(locationA, 0, 540, 720), coach.client);
  const mondayEvening = await changeOwnCoachAvailability(weekly(locationA, 0, 900, 1140), coach.client);
  const tuesday = await changeOwnCoachAvailability(weekly(locationB, 1, 600, 840), coach.client);
  assert.ok(mondayMorning.ok && mondayEvening.ok && tuesday.ok);
  expect(await changeOwnCoachAvailability({ operation: "save-weekly", id: tuesday.id, fields: { location_id: locationB, weekday: 1, start_minute: 600, end_minute: 780 } }, coach.client))
    .toEqual({ ok: true, id: tuesday.id });
  expect(await rows(coach.id)).toEqual([
    { location_id: locationA, weekday: 0, start_minute: 540, end_minute: 720 },
    { location_id: locationA, weekday: 0, start_minute: 900, end_minute: 1140 },
    { location_id: locationB, weekday: 1, start_minute: 600, end_minute: 780 },
  ]);
  // Overlaps are rejected at the same and at other locations; adjacent intervals are allowed.
  expect(await changeOwnCoachAvailability(weekly(locationB, 0, 660, 780), coach.client)).toEqual({ ok: false, reason: "overlap" });
  expect(await changeOwnCoachAvailability(weekly(locationA, 0, 600, 660), coach.client)).toEqual({ ok: false, reason: "overlap" });
  expect(await changeOwnCoachAvailability({ operation: "save-weekly", id: mondayEvening.id, fields: { location_id: locationA, weekday: 0, start_minute: 690, end_minute: 1140 } }, coach.client))
    .toEqual({ ok: false, reason: "overlap" });
  const adjacent = await changeOwnCoachAvailability(weekly(locationB, 0, 720, 780), coach.client);
  assert.ok(adjacent.ok);
  expect(await changeOwnCoachAvailability({ operation: "remove-weekly", id: adjacent.id }, coach.client)).toEqual({ ok: true, id: adjacent.id });
  // Only assigned locations; zero-length and misaligned intervals never reach the database.
  expect(await changeOwnCoachAvailability(weekly(locationC, 2, 540, 600), coach.client)).toEqual({ ok: false, reason: "invalid-location" });
  expect(await changeOwnCoachAvailability(weekly(randomUUID(), 2, 540, 600), coach.client)).toEqual({ ok: false, reason: "invalid-location" });
  expect(await changeOwnCoachAvailability(weekly(locationA, 2, 540, 540), coach.client)).toMatchObject({ ok: false, reason: "invalid-input" });
  expect(await changeOwnCoachAvailability(weekly(locationA, 2, 545, 600), coach.client)).toMatchObject({ ok: false, reason: "invalid-input" });

  // Ownership: another coach can neither see nor change these intervals.
  expect(await changeOwnCoachAvailability({ operation: "save-weekly", id: mondayMorning.id, fields: { location_id: locationA, weekday: 3, start_minute: 0, end_minute: 60 } }, otherCoach.client))
    .toEqual({ ok: false, reason: "not-found" });
  expect(await changeOwnCoachAvailability({ operation: "remove-weekly", id: mondayMorning.id }, otherCoach.client)).toEqual({ ok: false, reason: "not-found" });
  expect((await loadOwnCoachAvailability(otherCoach.client))?.weekly).toEqual([]);
  expect(await rows(coach.id)).toHaveLength(3);

  // Admins manage the same schedule; an Admin who coaches uses both areas.
  const byAdmin = await changeCoachAvailability({ coach_user_id: coach.id, change: weekly(locationB, 4, 480, 600) }, admin.client);
  assert.ok(byAdmin.ok);
  expect(await changeCoachAvailability({ coach_user_id: coach.id, change: weekly(locationA, 4, 540, 660) }, admin.client)).toEqual({ ok: false, reason: "overlap" });
  expect(await changeCoachAvailability({ coach_user_id: member.id, change: weekly(locationA, 4, 540, 660) }, admin.client)).toEqual({ ok: false, reason: "not-found" });
  const adminView = await loadAdminCoachAvailability(coach.id, admin.client);
  expect(adminView.selected?.coach).toEqual({ user_id: coach.id, display_name: "Availability Coach", ineligibility: null });
  expect(adminView.selected?.weekly.map((row) => row.id)).toEqual([mondayMorning.id, mondayEvening.id, tuesday.id, byAdmin.id]);
  expect(adminView.selected?.locations.map((location) => [location.id, location.timezone]).sort())
    .toEqual([[locationA, "Europe/Bucharest"], [locationB, "UTC"]].sort());
  const own = await changeOwnCoachAvailability(weekly(locationB, 5, 540, 600), adminCoach.client);
  assert.ok(own.ok);
  expect(await changeCoachAvailability({ coach_user_id: coach.id, change: { operation: "remove-weekly", id: byAdmin.id } }, adminCoach.client))
    .toEqual({ ok: true, id: byAdmin.id });

  // Multi-day additions: any weekday combination, all-or-nothing, preserving other hours.
  const before = await rows(coach.id);
  const multi = await changeOwnCoachAvailability(addWeekly(locationA, [6, 2, 4], 1200, 1320), coach.client);
  assert.ok(multi.ok && multi.ids);
  expect(multi.ids).toHaveLength(3);
  const added = await rows(coach.id);
  expect(added.filter((row: { start_minute: number }) => row.start_minute === 1200))
    .toEqual([2, 4, 6].map((weekday) => ({ location_id: locationA, weekday, start_minute: 1200, end_minute: 1320 })));
  expect(added.filter((row: { start_minute: number }) => row.start_minute !== 1200)).toEqual(before);
  // Conflicts on Monday (17:00–19:00) and Friday (20:00–22:00) name both days and save nothing.
  expect(await changeOwnCoachAvailability(addWeekly(locationB, [0, 3, 4, 5], 1080, 1260), coach.client))
    .toEqual({ ok: false, reason: "overlap", weekdays: [0, 4] });
  expect(await rows(coach.id)).toEqual(added);
  expect(await changeOwnCoachAvailability(addWeekly(locationC, [3], 1200, 1260), coach.client)).toEqual({ ok: false, reason: "invalid-location" });
  expect(await changeOwnCoachAvailability(addWeekly(locationA, [], 1200, 1260), coach.client)).toMatchObject({ ok: false, reason: "invalid-input" });
  expect(await changeOwnCoachAvailability(addWeekly(locationA, [3], 1205, 1260), coach.client)).toMatchObject({ ok: false, reason: "invalid-input" });
  expect(await rows(coach.id)).toEqual(added);
  // One day, at a different location, through the same operation.
  const single = await changeOwnCoachAvailability(addWeekly(locationB, [3], 1200, 1260), coach.client);
  assert.ok(single.ok);
  expect(single.ids).toEqual([single.id]);
  // Coaches only add to their own schedule at their own locations; Admins add for any coach.
  expect(await changeOwnCoachAvailability(addWeekly(locationB, [1], 1320, 1380), otherCoach.client)).toEqual({ ok: false, reason: "invalid-location" });
  expect(await changeOwnCoachAvailability({ ...addWeekly(locationA, [1], 1320, 1380), coach_user_id: coach.id }, otherCoach.client))
    .toMatchObject({ ok: false, reason: "invalid-input" });
  for (const session of [member.client, publicClient(), coach.client]) {
    await expect(changeCoachAvailability({ coach_user_id: coach.id, change: addWeekly(locationA, [1], 1320, 1380) }, session)).rejects.toThrow();
  }
  const byAdminMulti = await changeCoachAvailability({ coach_user_id: coach.id, change: addWeekly(locationB, [1, 5], 1320, 1380) }, admin.client);
  assert.ok(byAdminMulti.ok && byAdminMulti.ids);
  expect((await loadOwnCoachAvailability(otherCoach.client))?.weekly).toEqual([]);
  // Concurrent overlapping multi-day additions: one wins whole, the other saves nothing.
  const racedMulti = await Promise.all([
    changeOwnCoachAvailability(addWeekly(locationA, [2, 3], 60, 120), coach.client),
    changeCoachAvailability({ coach_user_id: coach.id, change: addWeekly(locationB, [3, 4], 90, 150) }, admin.client),
  ]);
  const winner = racedMulti.find((result) => result.ok);
  assert.ok(winner?.ok && winner.ids);
  expect(racedMulti.filter((result) => !result.ok)).toEqual([{ ok: false, reason: "overlap", weekdays: [3] }]);
  expect((await rows(coach.id)).filter((row: { start_minute: number }) => row.start_minute < 540)).toHaveLength(2);
  for (const id of [...multi.ids, single.id, ...byAdminMulti.ids, ...winner.ids]) {
    expect(await changeOwnCoachAvailability({ operation: "remove-weekly", id }, coach.client)).toEqual({ ok: true, id });
  }
  expect(await rows(coach.id)).toEqual(before);

  // Concurrent overlapping writes for one coach: exactly one succeeds.
  const raced = await Promise.all([
    changeOwnCoachAvailability(weekly(locationA, 6, 540, 660), coach.client),
    changeCoachAvailability({ coach_user_id: coach.id, change: weekly(locationB, 6, 600, 720) }, admin.client),
  ]);
  expect(raced.filter((result) => result.ok)).toHaveLength(1);
  expect(raced.filter((result) => !result.ok)).toEqual([{ ok: false, reason: "overlap" }]);

  // Date exceptions: whole-day and interval absences, one-off additional hours.
  const today = localToday("Europe/Bucharest", new Date()) < localToday("UTC", new Date())
    ? localToday("Europe/Bucharest", new Date()) : localToday("UTC", new Date());
  const day = addDays(today, 14);
  const vacation = await changeOwnCoachAvailability(absence(day), coach.client);
  assert.ok(vacation.ok);
  expect(await changeOwnCoachAvailability(absence(day, 600, 660), coach.client)).toEqual({ ok: false, reason: "overlap" });
  expect(await changeOwnCoachAvailability(extra(day, locationA, 1200, 1260), coach.client)).toEqual({ ok: false, reason: "overlap" });
  const appointment = await changeOwnCoachAvailability(absence(addDays(day, 1), 600, 660), coach.client);
  const special = await changeOwnCoachAvailability(extra(addDays(day, 1), locationB, 1200, 1320), coach.client);
  assert.ok(appointment.ok && special.ok);
  expect(await changeOwnCoachAvailability(extra(addDays(day, 1), locationB, 630, 720), coach.client)).toEqual({ ok: false, reason: "overlap" });
  expect(await changeOwnCoachAvailability(extra(addDays(day, 2), locationC, 600, 660), coach.client)).toEqual({ ok: false, reason: "invalid-location" });
  expect(await changeOwnCoachAvailability(absence(addDays(today, -1)), coach.client)).toEqual({ ok: false, reason: "out-of-range" });
  expect(await changeOwnCoachAvailability(absence(addDays(today, 400)), coach.client)).toEqual({ ok: false, reason: "out-of-range" });
  expect(await changeOwnCoachAvailability({ ...absence(addDays(day, 1), 540, 660), id: appointment.id }, coach.client)).toEqual({ ok: true, id: appointment.id });
  expect(await changeOwnCoachAvailability({ operation: "remove-exception", id: vacation.id }, otherCoach.client)).toEqual({ ok: false, reason: "not-found" });
  // Inclusive periods persist once, resolve on both boundaries, and edit/delete as a whole.
  const from = addDays(today, 40), until = addDays(today, 61);
  const period = (start = from, end = until) => ({ ...absence(start), fields: { ...absence(start).fields, until_date: end } });
  const holiday = await changeOwnCoachAvailability(period(), coach.client);
  assert.ok(holiday.ok);
  expect(await database.query("SELECT exception_date::text,until_date::text FROM public.coach_availability_exceptions WHERE id=$1", [holiday.id]))
    .toEqual([{ exception_date: from, until_date: until }]);
  for (const date of [from, addDays(from, 10), until]) {
    expect((await listCoachDayAvailability(database.manager, coach.id, date)).exceptions).toHaveLength(1);
  }
  for (const date of [addDays(from, -1), addDays(until, 1)]) {
    expect((await listCoachDayAvailability(database.manager, coach.id, date)).exceptions).toEqual([]);
  }
  expect(await changeOwnCoachAvailability(period(), coach.client)).toEqual({ ok: false, reason: "overlap" });
  expect(await changeOwnCoachAvailability(period(until, addDays(until, 1)), coach.client)).toEqual({ ok: false, reason: "overlap" });
  expect(await changeOwnCoachAvailability({ ...period(), id: holiday.id }, otherCoach.client)).toEqual({ ok: false, reason: "not-found" });
  expect(await changeCoachAvailability({ coach_user_id: coach.id, change: { ...period(from, addDays(until, 1)), id: holiday.id } }, admin.client))
    .toEqual({ ok: true, id: holiday.id });
  expect(await changeOwnCoachAvailability({ operation: "remove-exception", id: holiday.id }, coach.client)).toEqual({ ok: true, id: holiday.id });
  expect((await listCoachDayAvailability(database.manager, coach.id, from)).exceptions).toEqual([]);

  // Confirmed occupancy and live holds reject time off without altering the booking.
  const court = randomUUID(); courtIds.push(court);
  await database.query("INSERT INTO public.courts(id,location_id,name,slug,surface,environment) VALUES($1,$2,'Availability court',$3,'clay','outdoor')", [court, locationA, `availability-${court}`]);
  const [{ id: reservation }] = await database.query(`INSERT INTO public.court_reservations(court_id,coach_user_id,booking_date,starts_at_minute,ends_at_minute)
    VALUES($1,$2,$3,600,660) RETURNING id`, [court, coach.id, addDays(from, 10)]);
  expect(await changeOwnCoachAvailability(period(), coach.client)).toEqual({ ok: false, reason: "booking-conflict" });
  expect(await database.query("SELECT status,booking_date::text FROM public.court_reservations WHERE id=$1", [reservation]))
    .toEqual([{ status: "active", booking_date: addDays(from, 10) }]);
  expect(await changeOwnCoachAvailability(extra(addDays(from, 10), locationB, 600, 660), coach.client)).toEqual({ ok: false, reason: "booking-conflict" });
  await database.query("UPDATE public.court_reservations SET status='held',hold_expires_at=now()+interval '5 minutes' WHERE id=$1", [reservation]);
  expect(await changeOwnCoachAvailability(period(), coach.client)).toEqual({ ok: false, reason: "booking-conflict" });
  await database.query("UPDATE public.court_reservations SET hold_expires_at=now()-interval '1 minute' WHERE id=$1", [reservation]);
  const afterExpiry = await changeOwnCoachAvailability(period(), coach.client);
  assert.ok(afterExpiry.ok);
  await changeOwnCoachAvailability({ operation: "remove-exception", id: afterExpiry.id }, coach.client);
  await database.query("DELETE FROM public.court_reservations WHERE id=$1", [reservation]);

  // A past exception can only be removed.
  const [{ id: past }] = await database.query(`INSERT INTO public.coach_availability_exceptions(coach_user_id,exception_date,until_date,kind)
    VALUES ($1,$2,$2,'unavailable') RETURNING id`, [coach.id, addDays(today, -3)]);
  expect(await changeOwnCoachAvailability({ ...absence(addDays(today, 3)), id: past }, coach.client)).toEqual({ ok: false, reason: "out-of-range" });
  expect(await changeOwnCoachAvailability({ operation: "remove-exception", id: past }, coach.client)).toEqual({ ok: true, id: past });

  // Resolution from stored facts, in each location's timezone.
  const view = await loadOwnCoachAvailability(coach.client);
  assert.ok(view);
  expect(view.exceptions.map((row) => [row.date, row.kind, row.location_id, row.start_minute, row.end_minute])).toEqual([
    [day, "unavailable", null, null, null],
    [addDays(day, 1), "unavailable", null, 540, 660],
    [addDays(day, 1), "available", locationB, 1200, 1320],
  ]);
  const timezones = new Map(view.locations.map((location) => [location.id, location.timezone]));
  const resolve = (date: string) => resolveCoachAvailability({ date, weekly: view.weekly, exceptions: view.exceptions, timezones });
  const weekday = (date: string) => (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7;
  expect(resolve(day).length).toBe(0);
  const next = resolve(addDays(day, 1));
  expect(next.filter((window) => window.source === "exception"))
    .toEqual([expect.objectContaining({ location_id: locationB, starts_at: `${addDays(day, 1)}T20:00:00.000Z`, ends_at: `${addDays(day, 1)}T22:00:00.000Z` })]);
  // The 09:00–11:00 absence removes any Monday-morning interval on that date.
  if (weekday(addDays(day, 1)) === 0) expect(next.some((window) => window.start_minute < 660 && window.end_minute > 540)).toBe(false);

  // Suspended or former coaches: no self-service; Admins may only remove.
  assert.strictEqual((await service.from("users").update({ status: "suspended" }).eq("id", coach.id)).error, null);
  try {
    await expect(changeOwnCoachAvailability(weekly(locationA, 2, 540, 600), coach.client)).rejects.toThrow();
    expect(await changeCoachAvailability({ coach_user_id: coach.id, change: weekly(locationA, 2, 540, 600) }, admin.client)).toEqual({ ok: false, reason: "not-eligible" });
    expect((await loadAdminCoachAvailability(coach.id, admin.client)).selected?.coach.ineligibility).toBe("suspended");
    expect(await changeCoachAvailability({ coach_user_id: coach.id, change: { operation: "remove-exception", id: special.id } }, admin.client))
      .toEqual({ ok: true, id: special.id });
  } finally {
    assert.strictEqual((await service.from("users").update({ status: "active" }).eq("id", coach.id)).error, null);
  }
  assert.strictEqual((await service.from("user_roles").delete().eq("user_id", otherCoach.id).eq("role_code", "coach")).error, null);
  await expect(loadOwnCoachAvailability(otherCoach.client)).rejects.toThrow();
  expect(await changeCoachAvailability({ coach_user_id: otherCoach.id, change: weekly(locationA, 2, 540, 600) }, admin.client)).toEqual({ ok: false, reason: "not-eligible" });

  // Assignments: availability blocks removing its location; archived locations accept no new availability.
  expect(await saveCoachProfile({ user_id: coach.id, create: false, fields: coachFields([locationA]) }, admin.client)).toEqual({ ok: false, reason: "has-availability" });
  await database.query("UPDATE public.locations SET is_active=false,archived_at=now() WHERE id=$1", [locationB]);
  expect(await changeOwnCoachAvailability(weekly(locationB, 2, 540, 600), coach.client)).toEqual({ ok: false, reason: "invalid-location" });
  expect((await loadOwnCoachAvailability(coach.client))?.locations.find((location) => location.id === locationB)?.archived).toBe(true);
  expect(await changeOwnCoachAvailability({ operation: "remove-weekly", id: tuesday.id }, coach.client)).toEqual({ ok: true, id: tuesday.id });

  // Native range integrity: ordering and whole-day-only multi-day rows.
  for (const [start, end, minute] of [[addDays(today, 80), addDays(today, 79), null], [addDays(today, 80), addDays(today, 81), 600]] as const) {
    await expect(database.query(`INSERT INTO public.coach_availability_exceptions(coach_user_id,exception_date,until_date,kind,start_minute,end_minute)
      VALUES($1,$2,$3,'unavailable',$4,$5)`, [coach.id, start, end, minute, minute === null ? null : 660]))
      .rejects.toMatchObject({ driverError: { code: "23514", constraint: "coach_availability_exceptions_dates_check" } });
  }

  // PostgreSQL constraints back the TypeScript rules.
  const insertWeekly = (coachId: string, location: string, weekdayValue: number, start: number, end: number) => database.query(
    "INSERT INTO public.coach_weekly_availability(coach_user_id,location_id,weekday,start_minute,end_minute,valid_from) VALUES ($1,$2,$3,$4,$5,'2000-01-01')",
    [coachId, location, weekdayValue, start, end]);
  await expect(insertWeekly(coach.id, locationB, 0, 600, 660)).rejects.toMatchObject({ driverError: { code: "23P01", constraint: "coach_weekly_availability_no_overlap" } });
  await expect(insertWeekly(coach.id, locationC, 3, 600, 660)).rejects.toMatchObject({ driverError: { code: "23503", constraint: "coach_weekly_availability_coach_location_fkey" } });
  for (const [start, end, weekdayValue] of [[600, 600, 3], [615, 660, 3], [600, 1470, 3], [600, 660, 7]]) {
    await expect(insertWeekly(coach.id, locationA, weekdayValue, start, end)).rejects.toMatchObject({ driverError: { code: "23514" } });
  }
  const insertException = (values: string) => database.query(`INSERT INTO public.coach_availability_exceptions(coach_user_id,exception_date,until_date,kind,location_id,start_minute,end_minute)
    VALUES ($1,$2,$2,${values})`, [coach.id, addDays(day, 3)]);
  await expect(insertException(`'available',NULL,600,660`)).rejects.toMatchObject({ driverError: { code: "23514", constraint: "coach_availability_exceptions_kind_check" } });
  await expect(insertException(`'unavailable','${locationA}',600,660`)).rejects.toMatchObject({ driverError: { code: "23514", constraint: "coach_availability_exceptions_kind_check" } });
  await expect(insertException(`'available','${locationA}',NULL,NULL`)).rejects.toMatchObject({ driverError: { code: "23514" } });
  await expect(insertException(`'unavailable',NULL,600,NULL`)).rejects.toMatchObject({ driverError: { code: "23514", constraint: "coach_availability_exceptions_minutes_check" } });
  await expect(insertException(`'available','${locationC}',600,660`)).rejects.toMatchObject({ driverError: { code: "23503", constraint: "coach_availability_exceptions_coach_location_fkey" } });
  await insertException(`'unavailable',NULL,NULL,NULL`);
  await expect(insertException(`'available','${locationA}',600,660`)).rejects.toMatchObject({ driverError: { code: "23P01", constraint: "coach_availability_exceptions_no_overlap" } });
  await expect(database.query("DELETE FROM public.coach_locations WHERE coach_user_id=$1 AND location_id=$2", [coach.id, locationA]))
    .rejects.toMatchObject({ driverError: { code: "23503" } });
  expect(await database.query(`SELECT bool_or(has_table_privilege(r, t, 'SELECT,INSERT,UPDATE,DELETE')) AS granted
    FROM unnest(ARRAY['anon','authenticated']) r, unnest(ARRAY['public.coach_weekly_availability','public.coach_availability_exceptions']) t`))
    .toEqual([{ granted: false }]);
});
