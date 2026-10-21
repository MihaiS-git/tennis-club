import { readCoachingBookingOptions } from "@/lib/coaching/booking-options";
import { readPublicCoaching } from "@/lib/coaching/public";
import { listPublicLocationsWithCourts } from "@/lib/courts/public";
import { randomUUID } from "node:crypto";
import { afterAll, assert, beforeAll, expect, test } from "vitest";
import type { DataSource } from "typeorm";
import { readPublicCoachingLessonAvailability } from "@/lib/coaching/lesson-availability";
import { getDataSource } from "@/lib/db/data-source";
import { listCoachDayAvailability } from "@/lib/db/repositories/coach-availability.repository";
import { listCoachDayOccupancy } from "@/lib/db/repositories/reservations.repository";
import { mondayWeekday } from "@/lib/pricing/resolution";
import { cleanupAuthFixtures, localFixtureClient } from "./auth-fixtures";

// Public lesson availability from real PostgreSQL facts: one public location in
// Europe/Bucharest (A, two courts at different rates) and a second location (B)
// where the coach also teaches.
const service = localFixtureClient();
let database: DataSource;
const userIds: string[] = [];
const [locationA, locationB] = [randomUUID(), randomUUID()];
const [courtA1, courtA2, courtB1] = [randomUUID(), randomUUID(), randomUUID()];
const [program, inactiveProgram] = [randomUUID(), randomUUID()];
let coach: string, member: string, memberEmail: string;
const date = "2099-11-02";
// 00:30 in Bucharest on the lesson date (22:30 UTC on the previous day).
const beforeOpening = new Date("2099-11-01T22:30:00Z");

async function account(roles: "coach"[] = []) {
  const email = `lesson-availability-${randomUUID()}@example.test`;
  const { data, error } = await service.auth.admin.createUser({ email, password: "lesson-availability-password-123", email_confirm: true });
  assert.strictEqual(error, null); assert.ok(data.user);
  userIds.push(data.user.id);
  for (const role of roles) assert.strictEqual((await service.from("user_roles").insert({ user_id: data.user.id, role_code: role })).error, null);
  return { id: data.user.id, email };
}

async function reserve(court: string, start: number, end: number, options: { coach?: string; status?: "active" | "held"; expired?: boolean } = {}) {
  await database.query(`INSERT INTO public.court_reservations(id,court_id,booking_date,starts_at_minute,ends_at_minute,status,hold_expires_at,coach_user_id,created_by_user_id)
    VALUES($1,$2,$3,$4,$5,$6::public.court_reservation_status,
      CASE WHEN $6::text='held' THEN clock_timestamp()+CASE WHEN $7 THEN interval '-1 minute' ELSE interval '1 hour' END END,$8,$9)`,
  [randomUUID(), court, date, start, end, options.status ?? "active", options.expired ?? false, options.coach ?? null, member]);
}

const read = (overrides: Record<string, unknown> = {}, now = beforeOpening) =>
  readPublicCoachingLessonAvailability({ locationId: locationA, programId: program, coachId: coach, date, ...overrides }, now);

beforeAll(async () => {
  expect(process.env.TEST_SUPABASE_PROJECT).toBe("tennis-club-tests");
  database = await getDataSource();
  coach = (await account(["coach"])).id;
  ({ id: member, email: memberEmail } = await account());
  await database.query(`INSERT INTO public.locations(id,name,slug,timezone,currency,is_active,is_public) VALUES
    ($1,'Lesson availability A',($1::uuid)::text,'Europe/Bucharest','RON',true,true),
    ($2,'Lesson availability B',($2::uuid)::text,'UTC','RON',true,false)`, [locationA, locationB]);
  await database.query(`INSERT INTO public.courts(id,location_id,name,slug,surface,environment,is_active) VALUES
    ($1,$4,'A1','a1','clay','outdoor',true),($2,$4,'A2','a2','clay','outdoor',true),($3,$5,'B1','b1','clay','outdoor',true)`,
  [courtA1, courtA2, courtB1, locationA, locationB]);
  for (const location of [locationA, locationB]) {
    const [schedule] = await database.query(`INSERT INTO public.opening_hours_schedules(location_id,starts_on) VALUES($1,'2000-01-01') RETURNING id`, [location]);
    await database.query(`INSERT INTO public.location_opening_hours(location_id,schedule_id,weekday,opens_at_minute,closes_at_minute)
      SELECT $1,$2,weekday,0,1440 FROM generate_series(0,6) AS weekday`, [location, schedule.id]);
  }
  const [ruleSet] = await database.query("INSERT INTO public.pricing_rule_sets(location_id) VALUES($1) RETURNING id", [locationA]);
  await database.query(`INSERT INTO public.location_pricing_rules(location_id,rule_set_id,court_id,court_state,weekday,starts_at_minute,ends_at_minute,price_per_hour_minor)
    SELECT $1,$2,court.id,'outdoor',weekday,0,1440,court.rate FROM generate_series(0,6) AS weekday,
      (VALUES($3::uuid,5000),($4::uuid,7000)) AS court(id,rate)`, [locationA, ruleSet.id, courtA1, courtA2]);

  await database.query(`INSERT INTO public.coaching_programs(id,name,description,program_type,court_rental_included,is_active) VALUES
    ($1,'Availability private','','private',false,true),($2,'Availability retired','','private',false,false)`, [program, inactiveProgram]);
  await database.query(`INSERT INTO public.coaching_program_durations(program_id,duration_minutes)
    VALUES($1,60),($1,90),($1,120),($2,60)`, [program, inactiveProgram]);
  await database.query(`INSERT INTO public.coach_profiles(user_id,display_name,bio,qualifications,specialties,languages,is_public)
    VALUES($1,'Availability Coach','Private bio','Private qualifications','{}','{}',true)`, [coach]);
  await database.query("INSERT INTO public.coach_locations(coach_user_id,location_id) VALUES($1,$2),($1,$3)", [coach, locationA, locationB]);
  await database.query("INSERT INTO public.coach_programs(coach_user_id,program_id) VALUES($1,$2),($1,$3)", [coach, program, inactiveProgram]);
  // Club rates for 60 and 90 minutes, the coach's own 90-minute rate, nothing for 120.
  await database.query(`INSERT INTO public.coaching_prices(program_id,duration_minutes,location_id,coach_user_id,amount_minor,currency) VALUES
    ($1,60,$2,NULL,10000,'RON'),($1,90,$2,NULL,14000,'RON'),($1,90,$2,$3,16000,'RON'),($4,60,$2,NULL,9000,'RON')`,
  [program, locationA, coach, inactiveProgram]);
  await database.query(`INSERT INTO public.coach_weekly_availability(coach_user_id,location_id,weekday,start_minute,end_minute,valid_from)
    VALUES($1,$2,$3,540,900,'2000-01-01')`, [coach, locationA, mondayWeekday(date)]);
  await database.query(`INSERT INTO public.coach_availability_exceptions(coach_user_id,exception_date,until_date,kind,start_minute,end_minute,note)
    VALUES($1,$2,$2,'unavailable',840,900,'Private dentist note')`, [coach, date]);

  // Court A1: a live customer hold 10:00–11:00. Court A2: an expired hold 10:00–11:00
  // and a member's active booking 11:00–12:00.
  await reserve(courtA1, 600, 660, { status: "held" });
  await reserve(courtA2, 600, 660, { status: "held", expired: true });
  await reserve(courtA2, 660, 720);
  // The coach teaches on A1 12:00–13:00 and at location B 13:00–14:00 (live hold).
  // An expired coach hold at B 09:00–10:00 no longer occupies the coach.
  await reserve(courtA1, 720, 780, { coach });
  await reserve(courtB1, 780, 840, { coach, status: "held" });
  await reserve(courtB1, 540, 600, { coach, status: "held", expired: true });
});

afterAll(async () => {
  if (!database) return;
  try {
    const locations = [locationA, locationB];
    await database.query("DELETE FROM public.court_reservations WHERE court_id=ANY($1::uuid[])", [[courtA1, courtA2, courtB1]]);
    await database.query("DELETE FROM public.coach_availability_exceptions WHERE coach_user_id=$1", [coach]);
    await database.query("DELETE FROM public.coach_weekly_availability WHERE coach_user_id=$1", [coach]);
    await database.query("DELETE FROM public.coaching_prices WHERE location_id=ANY($1::uuid[])", [locations]);
    await database.query("DELETE FROM public.coach_programs WHERE coach_user_id=$1", [coach]);
    await database.query("DELETE FROM public.coach_locations WHERE coach_user_id=$1", [coach]);
    await database.query("DELETE FROM public.coach_profiles WHERE user_id=$1", [coach]);
    await database.query("DELETE FROM public.coaching_programs WHERE id=ANY($1::uuid[])", [[program, inactiveProgram]]);
    await database.query("DELETE FROM public.location_pricing_rules WHERE location_id=ANY($1::uuid[])", [locations]);
    await database.query("DELETE FROM public.pricing_rule_sets WHERE location_id=ANY($1::uuid[])", [locations]);
    await database.query("DELETE FROM public.location_opening_hours WHERE location_id=ANY($1::uuid[])", [locations]);
    await database.query("DELETE FROM public.opening_hours_schedules WHERE location_id=ANY($1::uuid[])", [locations]);
    await database.query("DELETE FROM public.courts WHERE location_id=ANY($1::uuid[])", [locations]);
    await database.query("DELETE FROM public.locations WHERE id=ANY($1::uuid[])", [locations]);
    await cleanupAuthFixtures(service, userIds);
  } finally { await database.destroy(); }
});

const starts = (availability: Awaited<ReturnType<typeof read>>, durationMinutes: number) =>
  availability?.durations.find((duration) => duration.durationMinutes === durationMinutes)?.starts
    .map((start) => [start.startMinute, start.courts.map((court) => [court.name, court.totalAmountMinor])]);

test("lists every free court per start with exact prices from real occupancy, availability and pricing", async () => {
  const availability = await read();
  expect(availability).toMatchObject({
    location: { id: locationA, name: "Lesson availability A", timezone: "Europe/Bucharest" },
    coach: { id: coach, displayName: "Availability Coach" },
    program: { id: program, name: "Availability private", courtRentalIncluded: false }, date, currency: "RON",
  });
  // 120 minutes has no applicable price and is not offered.
  expect(availability?.durations.map((duration) => duration.durationMinutes)).toEqual([60, 90]);
  // 09:00 both courts at their own rates; A1 is held 10:00–11:00 (live), A2's
  // expired hold is free, A2 is booked 11:00–12:00; from 12:00 the coach is
  // teaching on A1 or at location B, and 14:00–15:00 is a coach absence.
  expect(starts(availability, 60)).toEqual([
    [540, [["A1", 15000], ["A2", 17000]]], [570, [["A2", 17000]]], [600, [["A2", 17000]]], [660, [["A1", 15000]]],
  ]);
  // The coach's own 90-minute rate applies; A2 at 7000/h adds 10500.
  expect(starts(availability, 90)).toEqual([[540, [["A2", 26500]]], [570, [["A2", 26500]]]]);
  const first = availability!.durations[0].starts[0];
  expect(first).toMatchObject({ startMinute: 540, endMinute: 600, startsAt: "2099-11-02T07:00:00.000Z", endsAt: "2099-11-02T08:00:00.000Z" });
  expect(first.courts[0]).toEqual({ id: courtA1, name: "A1", coachingAmountMinor: 10000, courtAmountMinor: 5000, totalAmountMinor: 15000 });

  // No customer, booking, account or private coach facts are exposed.
  const serialized = JSON.stringify(availability);
  for (const hidden of [member, memberEmail, "Private bio", "Private qualifications", "Private dentist note", "evidence", "@"])
    expect(serialized).not.toContain(hidden);
  expect((await listCoachDayAvailability(database.manager, coach, date)).exceptions).toEqual([
    { date, until_date: date, kind: "unavailable", location_id: null, start_minute: 840, end_minute: 900 },
  ]);
  expect(await listCoachDayOccupancy(database.manager, coach, date)).toEqual([
    { booking_date: date, starts_at_minute: 720, ends_at_minute: 780 }, { booking_date: date, starts_at_minute: 780, ends_at_minute: 840 },
  ]);
});

test("uses the location's local date and time, not the server's", async () => {
  // 09:45 in Bucharest (07:45 UTC): the 09:00 and 09:30 starts have passed.
  expect(starts(await read({}, new Date("2099-11-02T07:45:00Z")), 60)).toEqual([[600, [["A2", 17000]]], [660, [["A1", 15000]]]]);
  // The next local day in Bucharest: the whole date is in the past.
  expect(starts(await read({}, new Date("2099-11-02T22:30:00Z")), 60)).toEqual([]);
});

test("guests and members receive the same identity-free availability, and ineligible requests none", async () => {
  // The read takes no session or account input; repeated reads are identical.
  expect(await read()).toEqual(await read());
  for (const input of [{ programId: inactiveProgram }, { programId: randomUUID() }, { coachId: member }, { coachId: "not-a-uuid" },
    { locationId: locationB }, { locationId: randomUUID() }, { date: "2099-02-30" }])
    expect(await read(input)).toBeNull();

  const toggles = [
    ["UPDATE public.coaching_programs SET is_active=false WHERE id=$1", "UPDATE public.coaching_programs SET is_active=true WHERE id=$1", program],
    ["UPDATE public.coach_profiles SET is_public=false WHERE user_id=$1", "UPDATE public.coach_profiles SET is_public=true WHERE user_id=$1", coach],
    ["UPDATE public.users SET status='suspended' WHERE id=$1", "UPDATE public.users SET status='active' WHERE id=$1", coach],
    ["UPDATE public.locations SET is_public=false WHERE id=$1", "UPDATE public.locations SET is_public=true WHERE id=$1", locationA],
  ] as const;
  for (const [disable, restore, id] of toggles) {
    await database.query(disable, [id]);
    try { expect(await read()).toBeNull(); } finally { await database.query(restore, [id]); }
  }
  expect(starts(await read(), 60)).toHaveLength(4);
});


test("semi-private uses the same public availability and complete-session prices", async () => {
  await database.query("UPDATE public.coaching_programs SET program_type='semi_private',min_participants=2,max_participants=2 WHERE id=$1", [program]);
  try {
    const availability = await read();
    expect(availability?.program).toMatchObject({ id: program, participantCount: 2, courtRentalIncluded: false });
    expect(availability?.durations.map(d => d.durationMinutes)).toEqual([60, 90]);
    expect(starts(availability, 60)).toEqual([
      [540, [["A1", 15000], ["A2", 17000]]], [570, [["A2", 17000]]], [600, [["A2", 17000]]], [660, [["A1", 15000]]],
    ]);
    expect(starts(availability, 90)).toEqual([[540, [["A2", 26500]]], [570, [["A2", 26500]]]]);
  } finally {
    await database.query("UPDATE public.coaching_programs SET program_type='private',min_participants=NULL,max_participants=NULL WHERE id=$1", [program]);
  }
});

test("isolates two coaches' schedules and exceptions while retaining all court conflicts", async () => {
  const other = (await account(["coach"])).id;
  const reservations: string[] = [];
  const atNine = (availability: Awaited<ReturnType<typeof read>>) =>
    availability?.durations.find(d => d.durationMinutes === 60)?.starts.find(s => s.startMinute === 540)?.courts.map(c => c.id) ?? [];
  const occupy = async (courtId: string, coachId: string, start = 540) => {
    const id = randomUUID(); reservations.push(id);
    await database.query(`INSERT INTO public.court_reservations(id,court_id,booking_date,starts_at_minute,ends_at_minute,status,coach_user_id)
      VALUES($1,$2,$3,$5,$6,'active',$4)`, [id, courtId, date, coachId, start, start + 60]);
    return id;
  };
  try {
    await database.query("INSERT INTO public.coach_profiles(user_id,display_name,bio,qualifications,specialties,languages,is_public) VALUES($1,'Other private coach','','','{}','{}',true)", [other]);
    await database.query("INSERT INTO public.coach_locations(coach_user_id,location_id) VALUES($1,$2)", [other, locationA]);
    await database.query("INSERT INTO public.coach_programs(coach_user_id,program_id) VALUES($1,$2)", [other, program]);
    await database.query(`INSERT INTO public.coach_weekly_availability(coach_user_id,location_id,weekday,start_minute,end_minute,valid_from)
      VALUES($1,$2,$3,900,1020,'2000-01-01')`, [other, locationA, mondayWeekday(date)]);
    await database.query(`INSERT INTO public.coach_availability_exceptions(coach_user_id,exception_date,until_date,kind,start_minute,end_minute,note)
      VALUES($1,$2,$2,'unavailable',540,600,'Other private exception')`, [other, date]);
    expect(atNine(await read())).toEqual([courtA1, courtA2]);
    expect(atNine(await read({ coachId: other }))).toEqual([]);
    expect((await read({ coachId: other }))?.durations[0].starts.some(s => s.startMinute === 900)).toBe(true);
    // Switching back restores the first coach's full offers.
    expect(atNine(await read())).toEqual([courtA1, courtA2]);
    const otherLesson = await occupy(courtA2, other);
    expect(atNine(await read())).toEqual([courtA1]);
    const serialized = JSON.stringify(await read());
    for (const hidden of [other, 'Other private coach', 'Other private exception', otherLesson]) expect(serialized).not.toContain(hidden);
    await database.query("DELETE FROM public.court_reservations WHERE id=$1", [otherLesson]);
    const sameCourt = await occupy(courtA1, other);
    expect(atNine(await read())).toEqual([courtA2]);
    await database.query("DELETE FROM public.court_reservations WHERE id=$1", [sameCourt]);
    expect((await read())?.durations[0].starts.find(s => s.startMinute === 660)?.courts.map(c => c.id)).toEqual([courtA1]);
    await occupy(courtB1, coach, 660);
    expect((await read())?.durations[0].starts.some(s => s.startMinute === 660)).toBe(false);
  } finally {
    await database.query("DELETE FROM public.court_reservations WHERE id=ANY($1::uuid[])", [reservations]);
    await database.query("DELETE FROM public.coach_availability_exceptions WHERE coach_user_id=$1", [other]);
    await database.query("DELETE FROM public.coach_weekly_availability WHERE coach_user_id=$1", [other]);
    await database.query("DELETE FROM public.coach_programs WHERE coach_user_id=$1", [other]);
    await database.query("DELETE FROM public.coach_locations WHERE coach_user_id=$1", [other]);
    await database.query("DELETE FROM public.coach_profiles WHERE user_id=$1", [other]);
  }
});


test("a persisted multi-day absence removes public lesson offers on its inclusive dates", async () => {
  // Extend the existing partial-day fixture instead of inserting an overlapping row.
  try {
    await database.query(`UPDATE public.coach_availability_exceptions SET exception_date='2099-10-31',until_date='2099-11-02',
      start_minute=NULL,end_minute=NULL WHERE coach_user_id=$1`, [coach]);
    expect(starts(await read(), 60)).toEqual([]);
    await database.query("UPDATE public.coach_availability_exceptions SET until_date='2099-11-01' WHERE coach_user_id=$1", [coach]);
    expect((starts(await read(), 60) ?? []).length).toBeGreaterThan(0);
  } finally {
    await database.query(`UPDATE public.coach_availability_exceptions SET exception_date=$2,until_date=$2,
      start_minute=840,end_minute=900 WHERE coach_user_id=$1`, [coach, date]);
  }
});

test("public lessons include both working intervals and exclude the lunch break", async () => {
  // Exact split-day hours: 08:00–12:00 and 14:00–21:00. The existing
  // 14:00–15:00 absence still applies, so afternoon offers start at 15:00.
  await database.query("UPDATE public.coach_weekly_availability SET start_minute=480,end_minute=720 WHERE coach_user_id=$1", [coach]);
  const [interval]: { id: string }[] = await database.query(`INSERT INTO public.coach_weekly_availability
    (coach_user_id,location_id,weekday,start_minute,end_minute,valid_from,valid_until)
    VALUES($1,$2,$3,840,1260,$4,$4) RETURNING id`, [coach, locationA, mondayWeekday(date), date]);
  try {
    const availability = await read();
    const offers = availability?.durations.find((duration) => duration.durationMinutes === 60)?.starts ?? [];
    expect(offers.some((offer) => offer.startMinute === 480)).toBe(true);
    expect(offers.some((offer) => offer.startMinute === 900)).toBe(true);
    expect(offers.some((offer) => offer.startMinute === 1200)).toBe(true);
    expect(offers.some((offer) => offer.startMinute < 840 && offer.endMinute > 720)).toBe(false);
    expect((await listCoachDayAvailability(database.manager, coach, date)).weekly).toHaveLength(2);
    // The bounded interval does not leak into another occurrence of the weekday.
    expect((await listCoachDayAvailability(database.manager, coach, "2099-11-09")).weekly).toHaveLength(1);
  } finally {
    await database.query("DELETE FROM public.coach_weekly_availability WHERE id=$1", [interval.id]);
    await database.query("UPDATE public.coach_weekly_availability SET start_minute=540,end_minute=900 WHERE coach_user_id=$1", [coach]);
  }
});


test("public selector uses local effective working hours, keeps booked coaches and preserves public eligibility checks", async () => {
  const location = (await listPublicLocationsWithCourts()).find(row => row.id === locationA)!;
  const options = async () => readCoachingBookingOptions(await readPublicCoaching([location]), location, beforeOpening);
  const includesCoach = async () => (await options()).some(option => option.coach.id === coach);
  // Current-day occupancy does not control selector eligibility.
  expect(await includesCoach()).toBe(true);
  await database.query("UPDATE public.coach_weekly_availability SET location_id=$2 WHERE coach_user_id=$1", [coach, locationB]);
  const extra = randomUUID();
  try {
    expect(await includesCoach()).toBe(false);
    await database.query(`INSERT INTO public.coach_availability_exceptions(id,coach_user_id,exception_date,until_date,kind,location_id,start_minute,end_minute)
      VALUES($1,$2,'2099-11-03','2099-11-03','available',$3,600,660)`, [extra, coach, locationA]);
    const extraOption = (await options()).find(option => option.coach.id === coach);
    expect(extraOption?.programs.find(item => item.id === program)?.durations).toEqual([60]);
  } finally {
    await database.query("DELETE FROM public.coach_availability_exceptions WHERE id=$1", [extra]);
    await database.query("UPDATE public.coach_weekly_availability SET location_id=$2 WHERE coach_user_id=$1", [coach, locationA]);
  }
  await database.query("UPDATE public.coach_weekly_availability SET valid_until='2099-11-01' WHERE coach_user_id=$1", [coach]);
  try { expect(await includesCoach()).toBe(false); }
  finally { await database.query("UPDATE public.coach_weekly_availability SET valid_until=NULL WHERE coach_user_id=$1", [coach]); }
  await database.query("UPDATE public.coach_weekly_availability SET valid_from='2099-12-01' WHERE coach_user_id=$1", [coach]);
  try { expect(await includesCoach()).toBe(true); }
  finally { await database.query("UPDATE public.coach_weekly_availability SET valid_from='2000-01-01' WHERE coach_user_id=$1", [coach]); }
  const toggles = [
    ["UPDATE public.coach_profiles SET is_public=false WHERE user_id=$1", "UPDATE public.coach_profiles SET is_public=true WHERE user_id=$1", coach],
    ["UPDATE public.coach_profiles SET archived_at=clock_timestamp(),is_public=false WHERE user_id=$1", "UPDATE public.coach_profiles SET archived_at=NULL,is_public=true WHERE user_id=$1", coach],
    ["UPDATE public.users SET status='suspended' WHERE id=$1", "UPDATE public.users SET status='active' WHERE id=$1", coach],
    ["UPDATE public.coaching_programs SET is_active=false WHERE id=$1", "UPDATE public.coaching_programs SET is_active=true WHERE id=$1", program],
  ] as const;
  for (const [disable, restore, id] of toggles) {
    await database.query(disable, [id]);
    try { expect(await includesCoach()).toBe(false); }
    finally { await database.query(restore, [id]); }
  }
  expect(await includesCoach()).toBe(true);
});
