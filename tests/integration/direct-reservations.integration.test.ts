import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { assert, expect, test } from "vitest";
import { cancelDirectReservationAsAdmin, createDirectReservation, editDirectReservationAsAdmin, getAdminReservationEditDay, getReservationDay, listInternalLocations } from "@/lib/reservations/service";
import { cancelOwnDirectReservation, editOwnDirectReservation, getOwnReservationEditDay } from "@/lib/reservations/personal-service";
import { listOwnCourtHistory, listOwnUpcomingReservations } from "../helpers/current-activity";
import { mondayWeekday } from "@/lib/pricing/resolution";
import { localMinute, localToday } from "@/lib/courts/local-time";
import { cleanupAuthFixtures, localFixtureClient } from "./auth-fixtures";
import { ensureIntegrationAdminAnchor } from "./admin-anchor";

test("Admin cancellation preserves the creator and reservation, releases occupancy, and denies non-Admins", async () => {
  const service = localFixtureClient();
  await ensureIntegrationAdminAnchor(service);
  const locationId = randomUUID();
  const courtId = randomUUID();
  const userIds: string[] = [];
  const date = "2099-10-15";
  const now = new Date("2099-10-14T12:00:00Z");
  const password = "admin-cancellation-password-123";
  const client = () => createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_PUBLISHABLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  async function account(role?: "admin" | "coach") {
    const email = `admin-cancel-${randomUUID()}@example.test`;
    const { data, error } = await service.auth.admin.createUser({ email, password, email_confirm: true });
    assert.strictEqual(error, null); assert.ok(data.user);
    userIds.push(data.user.id);
    if (role) assert.strictEqual((await service.from("user_roles").insert({ user_id: data.user.id, role_code: role })).error, null);
    const userClient = client();
    assert.strictEqual((await userClient.auth.signInWithPassword({ email, password })).error, null);
    return { id: data.user.id, client: userClient };
  }
  try {
    assert.strictEqual((await service.from("locations").insert({ id: locationId, name: "Operations", slug: `operations-${locationId}`,
      timezone: "UTC", is_active: true, is_public: false })).error, null);
    assert.strictEqual((await service.from("courts").insert({ id: courtId, location_id: locationId, name: "Court 1", slug: "court-1",
      surface: "clay", environment: "outdoor", is_active: true })).error, null);
    assert.strictEqual((await service.from("location_opening_hours").insert({ location_id: locationId,
      weekday: mondayWeekday(date), opens_at_minute: 600, closes_at_minute: 720 })).error, null);
    const admin = await account("admin");
    const coach = await account("coach");
    const member = await account();
    const suspended = await account("admin");
    assert.strictEqual((await service.from("users").update({ status: "suspended" }).eq("id", suspended.id)).error, null);
    const first = { locationId, courtId, date, startMinute: 600, endMinute: 660, reason: "Coach training" };
    expect(await createDirectReservation(first, coach.client, now)).toEqual({ ok: true });
    expect(await createDirectReservation({ ...first, startMinute: 660, endMinute: 720, reason: "Second session" }, coach.client, now)).toEqual({ ok: true });
    const originalResult = await service.from("court_reservations")
      .select("id, court_id, booking_date, starts_at_minute, ends_at_minute, reason, created_by_user_id, created_at, status, cancelled_at, cancelled_by_user_id")
      .eq("court_id", courtId).order("starts_at_minute");
    assert.strictEqual(originalResult.error, null);
    const [original, second] = originalResult.data!;
    await expect(cancelDirectReservationAsAdmin(original.id, coach.client)).rejects.toThrow();
    await expect(cancelDirectReservationAsAdmin(original.id, member.client)).rejects.toThrow();
    expect(await cancelOwnDirectReservation(original.id, admin.client)).toMatchObject({ ok: false });
    expect(await cancelDirectReservationAsAdmin(original.id, admin.client)).toEqual({ ok: true });
    expect(await cancelDirectReservationAsAdmin(original.id, admin.client)).toMatchObject({ ok: false, message: expect.stringContaining("no longer") });
    expect(await cancelDirectReservationAsAdmin(randomUUID(), admin.client)).toMatchObject({ ok: false, message: expect.stringContaining("no longer") });
    const retained = await service.from("court_reservations")
      .select("id, court_id, booking_date, starts_at_minute, ends_at_minute, reason, created_by_user_id, created_at, status, cancelled_at, cancelled_by_user_id")
      .eq("id", original.id).single();
    assert.strictEqual(retained.error, null);
    expect(retained.data).toEqual({ ...original, status: "cancelled", cancelled_at: expect.any(String), cancelled_by_user_id: admin.id });
    const location = { id: locationId, name: "Operations", timezone: "UTC", courts: [{ id: courtId, name: "Court 1" }] };
    const day = await getReservationDay(location, date, now, admin.client);
    expect(day.courts[0].cells).toEqual(["available", "available", "booked", "booked"]);
    expect(day.adminOccupancy.map((row) => row.id)).toEqual([second.id]);
    const competing = await Promise.all([
      cancelDirectReservationAsAdmin(second.id, admin.client), cancelOwnDirectReservation(second.id, coach.client),
    ]);
    expect(competing.filter((result) => result.ok)).toHaveLength(1);
    const final = await service.from("court_reservations").select("status, cancelled_at, cancelled_by_user_id, created_by_user_id").eq("id", second.id).single();
    assert.strictEqual(final.error, null);
    expect(final.data).toMatchObject({ status: "cancelled", cancelled_at: expect.any(String), created_by_user_id: coach.id,
      cancelled_by_user_id: competing[0].ok ? admin.id : coach.id });
    expect((await getReservationDay(location, date, now, admin.client)).courts[0].cells).toEqual([
      "available", "available", "available", "available",
    ]);
    expect((await listOwnUpcomingReservations(coach.client, now)).upcoming).toEqual([]);
    expect((await listOwnCourtHistory(1, coach.client, now)).rows).toHaveLength(2);
  } finally {
    assert.strictEqual((await service.from("court_reservations").delete().eq("court_id", courtId)).error, null);
    assert.strictEqual((await service.from("location_opening_hours").delete().eq("location_id", locationId)).error, null);
    assert.strictEqual((await service.from("courts").delete().eq("id", courtId)).error, null);
    assert.strictEqual((await service.from("locations").delete().eq("id", locationId)).error, null);
    await cleanupAuthFixtures(service, userIds);
  }
}, 30000);

test("Admin edits another creator's row atomically while preserving owner-only edits and rejecting stale, invalid and occupied targets", async () => {
  const service = localFixtureClient();
  await ensureIntegrationAdminAnchor(service);
  const ids = { location: randomUUID(), otherLocation: randomUUID(), court: randomUUID(), secondCourt: randomUUID(),
    otherCourt: randomUUID(), inactiveCourt: randomUUID() };
  const userIds: string[] = [];
  const date = "2099-10-15";
  const nextDate = "2099-10-16";
  const now = new Date("2099-10-14T12:00:00Z");
  const password = "admin-edit-password-123";
  async function account(role?: "admin" | "coach") {
    const email = `admin-edit-${randomUUID()}@example.test`;
    const { data, error } = await service.auth.admin.createUser({ email, password, email_confirm: true });
    assert.strictEqual(error, null); assert.ok(data.user);
    userIds.push(data.user.id);
    if (role) assert.strictEqual((await service.from("user_roles").insert({ user_id: data.user.id, role_code: role })).error, null);
    const client = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_PUBLISHABLE_KEY!, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    assert.strictEqual((await client.auth.signInWithPassword({ email, password })).error, null);
    return { id: data.user.id, client };
  }
  try {
    assert.strictEqual((await service.from("locations").insert([
      { id: ids.location, name: "Operations", slug: `admin-edit-${ids.location}`, timezone: "UTC", is_public: false },
      { id: ids.otherLocation, name: "Elsewhere", slug: `admin-edit-${ids.otherLocation}`, timezone: "UTC", is_public: false },
    ])).error, null);
    assert.strictEqual((await service.from("courts").insert([
      { id: ids.court, location_id: ids.location, name: "Court 1", slug: "court-1", surface: "clay", environment: "outdoor", is_active: true },
      { id: ids.secondCourt, location_id: ids.location, name: "Court 2", slug: "court-2", surface: "clay", environment: "outdoor", is_active: true },
      { id: ids.otherCourt, location_id: ids.otherLocation, name: "Other", slug: "other", surface: "clay", environment: "outdoor", is_active: true },
      { id: ids.inactiveCourt, location_id: ids.location, name: "Closed", slug: "closed", surface: "clay", environment: "outdoor", is_active: false },
    ])).error, null);
    assert.strictEqual((await service.from("location_opening_hours").insert([
      { location_id: ids.location, weekday: mondayWeekday(date), opens_at_minute: 600, closes_at_minute: 900 },
      { location_id: ids.location, weekday: mondayWeekday(nextDate), opens_at_minute: 600, closes_at_minute: 900 },
      { location_id: ids.otherLocation, weekday: mondayWeekday(nextDate), opens_at_minute: 600, closes_at_minute: 900 },
    ])).error, null);
    const admin = await account("admin");
    const coach = await account("coach");
    const member = await account();
    expect(await createDirectReservation({ locationId: ids.location, courtId: ids.court, date,
      startMinute: 600, endMinute: 660, reason: "Coach training" }, coach.client, now)).toEqual({ ok: true });
    expect(await createDirectReservation({ locationId: ids.location, courtId: ids.secondCourt, date: nextDate,
      startMinute: 720, endMinute: 780, reason: "Occupied" }, coach.client, now)).toEqual({ ok: true });
    const original = (await listOwnUpcomingReservations(coach.client, now)).upcoming.find((row) => row.court_id === ids.court)!;
    const row = async () => {
      const result = await service.from("court_reservations")
        .select("id, court_id, booking_date, starts_at_minute, ends_at_minute, reason, created_by_user_id, created_at, updated_at, status, cancelled_at, cancelled_by_user_id")
        .eq("id", original.id).single();
      assert.strictEqual(result.error, null);
      return result.data!;
    };
    const before = await row();
    const reasonEdit = { kind: "reason", id: original.id, expectedUpdatedAt: before.updated_at, reason: " Admin update " };
    await expect(editDirectReservationAsAdmin(reasonEdit, coach.client, now)).rejects.toThrow();
    await expect(editDirectReservationAsAdmin(reasonEdit, member.client, now)).rejects.toThrow();
    expect(await editOwnDirectReservation(reasonEdit, admin.client, now)).toMatchObject({ ok: false });
    expect(await editDirectReservationAsAdmin(reasonEdit, admin.client, now)).toMatchObject({ ok: true });
    const changedReason = await row();
    expect(changedReason).toMatchObject({ ...before, updated_at: expect.any(String), reason: "Admin update" });
    expect(changedReason.updated_at).not.toBe(before.updated_at);
    expect(await editDirectReservationAsAdmin(reasonEdit, admin.client, now)).toMatchObject({ ok: false, stale: true });
    const schedule = { kind: "schedule", id: original.id, expectedUpdatedAt: changedReason.updated_at,
      schedule: { courtId: ids.secondCourt, date: nextDate, startMinute: 780, endMinute: 870, reason: "Moved training" } };
    for (const invalid of [
      { ...schedule.schedule, courtId: ids.otherCourt },
      { ...schedule.schedule, courtId: ids.inactiveCourt },
      { ...schedule.schedule, startMinute: 870, endMinute: 930 },
      { ...schedule.schedule, startMinute: 795 },
      { ...schedule.schedule, endMinute: 810 },
      { ...schedule.schedule, date: "2099-10-13" },
    ]) expect(await editDirectReservationAsAdmin({ ...schedule, schedule: invalid }, admin.client, now)).toMatchObject({ ok: false });
    expect(await row()).toEqual(changedReason);
    expect(await row()).toEqual(changedReason);
    const conflict = await editDirectReservationAsAdmin({ ...schedule,
      schedule: { ...schedule.schedule, startMinute: 720, endMinute: 780 } }, admin.client, now);
    expect(conflict).toMatchObject({ ok: false, message: expect.stringContaining("existing reservation has not been changed") });
    expect(await row()).toEqual(changedReason);
    expect(await editDirectReservationAsAdmin(schedule, admin.client, now)).toMatchObject({ ok: true });
    const moved = await row();
    expect(moved).toMatchObject({ id: before.id, created_by_user_id: coach.id, created_at: before.created_at,
      status: "active", cancelled_at: null, cancelled_by_user_id: null, court_id: ids.secondCourt,
      booking_date: nextDate, starts_at_minute: 780, ends_at_minute: 870, reason: "Moved training" });
    expect(moved.updated_at).not.toBe(changedReason.updated_at);
    const location = { id: ids.location, name: "Operations", timezone: "UTC",
      courts: [{ id: ids.court, name: "Court 1" }, { id: ids.secondCourt, name: "Court 2" }] };
    expect((await getReservationDay(location, date, now, admin.client)).courts[0].cells.slice(0, 2)).toEqual(["available", "available"]);
    expect((await getReservationDay(location, nextDate, now, admin.client)).adminOccupancy.map((item) => item.id)).toContain(original.id);
    const racing = await Promise.all(["First", "Second"].map((reason) => editDirectReservationAsAdmin({
      kind: "reason", id: original.id, expectedUpdatedAt: moved.updated_at, reason,
    }, admin.client, now)));
    expect(racing.filter((result) => result.ok)).toHaveLength(1);
    expect(racing.filter((result) => !result.ok && result.stale)).toHaveLength(1);
    const afterRace = await row();
    expect(["First", "Second"]).toContain(afterRace.reason);
    expect(await editOwnDirectReservation({ kind: "reason", id: original.id, expectedUpdatedAt: afterRace.updated_at,
      reason: "Still owner" }, coach.client, now)).toEqual({ ok: true });
    expect((await row()).created_by_user_id).toBe(coach.id);
    expect(await editDirectReservationAsAdmin({ kind: "reason", id: randomUUID(),
      expectedUpdatedAt: afterRace.updated_at, reason: "Missing" }, admin.client, now)).toMatchObject({ ok: false });
    expect(await cancelDirectReservationAsAdmin(original.id, admin.client)).toEqual({ ok: true });
    const cancelled = await row();
    expect(cancelled.status).toBe("cancelled");
    expect(await editDirectReservationAsAdmin({ kind: "reason", id: original.id,
      expectedUpdatedAt: cancelled.updated_at, reason: "Too late" }, admin.client, now)).toMatchObject({ ok: false });
  } finally {
    assert.strictEqual((await service.from("court_reservations").delete().in("court_id", [ids.court, ids.secondCourt, ids.otherCourt, ids.inactiveCourt])).error, null);
    assert.strictEqual((await service.from("location_opening_hours").delete().in("location_id", [ids.location, ids.otherLocation])).error, null);
    assert.strictEqual((await service.from("courts").delete().in("location_id", [ids.location, ids.otherLocation])).error, null);
    assert.strictEqual((await service.from("locations").delete().in("id", [ids.location, ids.otherLocation])).error, null);
    await cleanupAuthFixtures(service, userIds);
  }
}, 30000);

test("in-progress Admin edit changes only the reason on the same row", async () => {
  const service = localFixtureClient();
  await ensureIntegrationAdminAnchor(service);
  const now = new Date();
  const zone = ["UTC", "America/Los_Angeles", "Pacific/Honolulu", "Asia/Tokyo", "Europe/Bucharest"]
    .find((value) => localMinute(value, now) >= 120 && localMinute(value, now) <= 1260)!;
  const date = localToday(zone, now);
  const startMinute = Math.floor(localMinute(zone, now) / 30) * 30 - 30;
  const endMinute = startMinute + 120;
  const locationId = randomUUID();
  const courtId = randomUUID();
  const userIds: string[] = [];
  try {
    assert.strictEqual((await service.from("locations").insert({ id: locationId, name: "Current operations",
      slug: `current-${locationId}`, timezone: zone, is_public: false })).error, null);
    assert.strictEqual((await service.from("courts").insert({ id: courtId, location_id: locationId,
      name: "Court", slug: "court", surface: "clay", environment: "outdoor", is_active: true })).error, null);
    assert.strictEqual((await service.from("location_opening_hours").insert({ location_id: locationId,
      weekday: mondayWeekday(date), opens_at_minute: startMinute - 30, closes_at_minute: endMinute + 30 })).error, null);
    const password = "in-progress-admin-edit-password-123";
    async function account(role: "admin" | "coach") {
      const email = `in-progress-${randomUUID()}@example.test`;
      const created = await service.auth.admin.createUser({ email, password, email_confirm: true });
      assert.strictEqual(created.error, null); assert.ok(created.data.user);
      userIds.push(created.data.user.id);
      assert.strictEqual((await service.from("user_roles").insert({ user_id: created.data.user.id, role_code: role })).error, null);
      const client = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_PUBLISHABLE_KEY!, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      });
      assert.strictEqual((await client.auth.signInWithPassword({ email, password })).error, null);
      return { id: created.data.user.id, client };
    }
    const admin = await account("admin");
    const coach = await account("coach");
    const inserted = await service.from("court_reservations").insert({ court_id: courtId, booking_date: date,
      starts_at_minute: startMinute, ends_at_minute: endMinute, reason: "Live training", created_by_user_id: coach.id })
      .select("id, updated_at, created_at").single();
    assert.strictEqual(inserted.error, null);
    const original = inserted.data!;
    const schedule = { kind: "schedule", id: original.id, expectedUpdatedAt: original.updated_at,
      schedule: { courtId, date, startMinute: startMinute + 30, endMinute, reason: "Moved live" } };
    expect(await editDirectReservationAsAdmin(schedule, admin.client, now)).toMatchObject({ ok: false,
      message: "An in-progress reservation can only change its reason." });
    expect(await editDirectReservationAsAdmin({ kind: "reason", id: original.id,
      expectedUpdatedAt: original.updated_at, reason: " Updated live training " }, admin.client, now)).toMatchObject({ ok: true });
    const retained = await service.from("court_reservations")
      .select("id, court_id, booking_date, starts_at_minute, ends_at_minute, reason, created_by_user_id, created_at, updated_at, status, cancelled_at, cancelled_by_user_id")
      .eq("id", original.id).single();
    assert.strictEqual(retained.error, null);
    expect(retained.data).toMatchObject({ id: original.id, court_id: courtId, booking_date: date,
      starts_at_minute: startMinute, ends_at_minute: endMinute, reason: "Updated live training",
      created_by_user_id: coach.id, created_at: original.created_at, status: "active",
      cancelled_at: null, cancelled_by_user_id: null });
    expect(retained.data!.updated_at).not.toBe(original.updated_at);
  } finally {
    assert.strictEqual((await service.from("court_reservations").delete().eq("court_id", courtId)).error, null);
    assert.strictEqual((await service.from("location_opening_hours").delete().eq("location_id", locationId)).error, null);
    assert.strictEqual((await service.from("courts").delete().eq("id", courtId)).error, null);
    assert.strictEqual((await service.from("locations").delete().eq("id", locationId)).error, null);
    await cleanupAuthFixtures(service, userIds);
  }
}, 30000);

test("an in-progress owner may edit reason while scheduling stays locked and cancellation still works", async () => {
  const service = localFixtureClient();
  await ensureIntegrationAdminAnchor(service);
  const locationId = randomUUID();
  const courtId = randomUUID();
  const now = new Date();
  const timezone = ["UTC", "America/Los_Angeles", "Pacific/Honolulu", "Asia/Tokyo", "Europe/Bucharest"]
    .find((zone) => localMinute(zone, now) >= 120 && localMinute(zone, now) <= 1320)!;
  const date = localToday(timezone, now);
  const startMinute = Math.floor(localMinute(timezone, now) / 30) * 30 - 30;
  const email = `reservation-progress-${randomUUID()}@example.test`;
  const password = "direct-edit-password-123";
  const { data: created, error: createError } = await service.auth.admin.createUser({ email, password, email_confirm: true });
  assert.strictEqual(createError, null); assert.ok(created.user);
  try {
    assert.strictEqual((await service.from("user_roles").insert({ user_id: created.user.id, role_code: "admin" })).error, null);
    assert.strictEqual((await service.from("locations").insert({ id: locationId, name: "In progress", slug: `progress-${locationId}`,
      timezone, is_active: true, is_public: false })).error, null);
    assert.strictEqual((await service.from("courts").insert({ id: courtId, location_id: locationId, name: "Court", slug: "court",
      surface: "clay", environment: "outdoor", is_active: true })).error, null);
    assert.strictEqual((await service.from("location_opening_hours").insert({ location_id: locationId,
      weekday: mondayWeekday(date), opens_at_minute: 0, closes_at_minute: 1440 })).error, null);
    assert.strictEqual((await service.from("court_reservations").insert({ court_id: courtId, booking_date: date,
      starts_at_minute: startMinute, ends_at_minute: startMinute + 90, reason: "Training",
      created_by_user_id: created.user.id })).error, null);
    const client = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_PUBLISHABLE_KEY!, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    assert.strictEqual((await client.auth.signInWithPassword({ email, password })).error, null);
    const original = (await listOwnUpcomingReservations(client)).upcoming[0];
    expect(original.id).toBeDefined();
    expect(await editOwnDirectReservation({ kind: "schedule", id: original.id, expectedUpdatedAt: original.updated_at,
      schedule: { locationId, courtId, date, startMinute, endMinute: startMinute + 90, reason: "Moved" } }, client)).toMatchObject({ ok: false });
    expect(await editOwnDirectReservation({ kind: "reason", id: original.id, expectedUpdatedAt: original.updated_at,
      reason: " Updated training " }, client)).toEqual({ ok: true });
    const updated = (await listOwnUpcomingReservations(client)).upcoming[0];
    expect(updated).toMatchObject({ id: original.id, court_id: courtId, booking_date: date,
      starts_at_minute: startMinute, ends_at_minute: startMinute + 90, reason: "Updated training" });
    expect(updated.updated_at).not.toBe(original.updated_at);
    expect(await cancelOwnDirectReservation(original.id, client)).toEqual({ ok: true });
    expect((await listOwnCourtHistory(1, client)).rows[0]).toMatchObject({ id: original.id, status: "cancelled" });
  } finally {
    assert.strictEqual((await service.from("court_reservations").delete().eq("court_id", courtId)).error, null);
    assert.strictEqual((await service.from("location_opening_hours").delete().eq("location_id", locationId)).error, null);
    assert.strictEqual((await service.from("courts").delete().eq("id", courtId)).error, null);
    assert.strictEqual((await service.from("locations").delete().eq("id", locationId)).error, null);
    await cleanupAuthFixtures(service, [created.user.id]);
  }
}, 30000);

test("personal edits lock and update the same row without losing it on stale or overlapping changes", async () => {
  const service = localFixtureClient();
  await ensureIntegrationAdminAnchor(service);
  const ids = { location: randomUUID(), otherLocation: randomUUID(), inactiveLocation: randomUUID(),
    court: randomUUID(), otherCourt: randomUUID(), targetCourt: randomUUID(), inactiveCourt: randomUUID(), inactiveLocationCourt: randomUUID() };
  const userIds: string[] = [];
  const date = "2099-10-15";
  const targetDate = "2099-10-16";
  const now = new Date("2099-10-14T12:00:00Z");
  const password = "direct-edit-password-123";
  const publicClient = () => createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_PUBLISHABLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  async function account(role?: "admin" | "coach") {
    const email = `reservation-edit-${randomUUID()}@example.test`;
    const { data, error } = await service.auth.admin.createUser({ email, password, email_confirm: true });
    assert.strictEqual(error, null); assert.ok(data.user);
    userIds.push(data.user.id);
    if (role) assert.strictEqual((await service.from("user_roles").insert({ user_id: data.user.id, role_code: role })).error, null);
    const client = publicClient();
    assert.strictEqual((await client.auth.signInWithPassword({ email, password })).error, null);
    return { id: data.user.id, client };
  }
  try {
    assert.strictEqual((await service.from("locations").insert([
      { id: ids.location, name: "Internal", slug: `edit-${ids.location}`, timezone: "UTC", is_active: true, is_public: false },
      { id: ids.otherLocation, name: "Other", slug: `edit-${ids.otherLocation}`, timezone: "UTC", is_active: true, is_public: false },
      { id: ids.inactiveLocation, name: "Inactive", slug: `edit-${ids.inactiveLocation}`, timezone: "UTC", is_active: false, is_public: false },
    ])).error, null);
    assert.strictEqual((await service.from("courts").insert([
      { id: ids.court, location_id: ids.location, name: "A", slug: "a", surface: "clay", environment: "outdoor", is_active: true },
      { id: ids.otherCourt, location_id: ids.location, name: "B", slug: "b", surface: "clay", environment: "outdoor", is_active: true },
      { id: ids.targetCourt, location_id: ids.otherLocation, name: "C", slug: "c", surface: "clay", environment: "outdoor", is_active: true },
      { id: ids.inactiveCourt, location_id: ids.location, name: "D", slug: "d", surface: "clay", environment: "outdoor", is_active: false },
      { id: ids.inactiveLocationCourt, location_id: ids.inactiveLocation, name: "E", slug: "e", surface: "clay", environment: "outdoor", is_active: true },
    ])).error, null);
    assert.strictEqual((await service.from("location_opening_hours").insert([
      { location_id: ids.location, weekday: mondayWeekday(date), opens_at_minute: 600, closes_at_minute: 1200 },
      { location_id: ids.location, weekday: mondayWeekday(targetDate), opens_at_minute: 600, closes_at_minute: 1200 },
      { location_id: ids.otherLocation, weekday: mondayWeekday(targetDate), opens_at_minute: 600, closes_at_minute: 1200 },
    ])).error, null);
    const admin = await account("admin");
    const coach = await account("coach");
    const member = await account();
    const first = { locationId: ids.location, courtId: ids.court, date, startMinute: 600, endMinute: 660, reason: "Club event" };
    expect(await createDirectReservation(first, admin.client, now)).toEqual({ ok: true });
    expect(await createDirectReservation({ ...first, startMinute: 660, endMinute: 720, reason: "Coaching" }, coach.client, now)).toEqual({ ok: true });
    const original = (await listOwnUpcomingReservations(admin.client, now)).upcoming[0];
    const coachOriginal = (await listOwnUpcomingReservations(coach.client, now)).upcoming[0];
    const editDay = await getOwnReservationEditDay({ reservationId: original.id, date }, admin.client, now);
    expect(editDay.location.id).toBe(ids.location);
    expect(editDay.day.courts.map((item) => item.court.id)).toEqual([ids.court, ids.otherCourt]);
    expect(editDay.day.courts[0].cells.slice(0, 4)).toEqual(["available", "available", "booked", "booked"]);
    expect((await getOwnReservationEditDay({ reservationId: original.id, date: targetDate }, admin.client, now)).location.id).toBe(ids.location);
    await expect(getOwnReservationEditDay({ reservationId: coachOriginal.id, date }, admin.client, now)).rejects.toThrow();
    await expect(getOwnReservationEditDay({ reservationId: original.id, date }, member.client, now)).rejects.toThrow();
    const reasonEdit = { kind: "reason", id: original.id, expectedUpdatedAt: original.updated_at, reason: " Updated event " };
    await expect(editOwnDirectReservation(reasonEdit, member.client, now)).rejects.toThrow();
    expect(await editOwnDirectReservation({ ...reasonEdit, id: coachOriginal.id }, admin.client, now)).toMatchObject({ ok: false });
    expect(await editOwnDirectReservation({ ...reasonEdit, created_by_user_id: coach.id }, admin.client, now)).toMatchObject({ ok: false });
    expect(await editOwnDirectReservation(reasonEdit, admin.client, now)).toEqual({ ok: true });
    const reasonRow = (await listOwnUpcomingReservations(admin.client, now)).upcoming[0];
    expect(reasonRow).toMatchObject({ id: original.id, court_id: ids.court, booking_date: date, starts_at_minute: 600,
      ends_at_minute: 660, reason: "Updated event", created_by_user_id: admin.id, status: "active" });
    expect(reasonRow.updated_at).not.toBe(original.updated_at);
    expect(await editOwnDirectReservation(reasonEdit, admin.client, now)).toMatchObject({ ok: false, stale: true });
    expect((await listOwnUpcomingReservations(admin.client, now)).upcoming[0]).toEqual(reasonRow);
    const schedule = { kind: "schedule", id: original.id, expectedUpdatedAt: reasonRow.updated_at,
      schedule: { courtId: ids.court, date, startMinute: 600, endMinute: 660, reason: "Moved event" } };
    expect(await editOwnDirectReservation({ ...schedule, schedule: { ...schedule.schedule, locationId: ids.otherLocation } }, admin.client, now)).toMatchObject({ ok: false });
    for (const invalid of [
      { ...schedule.schedule, startMinute: 615 },
      { ...schedule.schedule, endMinute: 630 },
      { ...schedule.schedule, startMinute: 1140, endMinute: 1230 },
      { ...schedule.schedule, courtId: ids.inactiveCourt },
      { ...schedule.schedule, courtId: ids.inactiveLocationCourt },
      { ...schedule.schedule, courtId: ids.targetCourt },
      { ...schedule.schedule, date: "2099-10-13" },
    ]) expect(await editOwnDirectReservation({ ...schedule, schedule: invalid }, admin.client, now)).toMatchObject({ ok: false });
    expect((await listOwnUpcomingReservations(admin.client, now)).upcoming[0]).toEqual(reasonRow);
    const conflict = await editOwnDirectReservation({ ...schedule,
      schedule: { ...schedule.schedule, startMinute: 660, endMinute: 720, reason: "Conflict" } }, admin.client, now);
    expect(conflict).toEqual({ ok: false,
      message: "That court is no longer available for the selected time. Your existing reservation has not been changed." });
    expect((await listOwnUpcomingReservations(admin.client, now)).upcoming[0]).toEqual(reasonRow);
    expect(await editOwnDirectReservation({ ...schedule, schedule: { courtId: ids.targetCourt,
      date: targetDate, startMinute: 900, endMinute: 990, reason: "Moved event" } }, admin.client, now)).toMatchObject({ ok: false });
    expect((await listOwnUpcomingReservations(admin.client, now)).upcoming[0]).toEqual(reasonRow);
    expect((await listOwnUpcomingReservations(admin.client, now)).upcoming[0]).toEqual(reasonRow);
    expect(await editOwnDirectReservation({ ...schedule, schedule: { courtId: ids.otherCourt,
      date: targetDate, startMinute: 900, endMinute: 990, reason: "Moved event" } }, admin.client, now)).toEqual({ ok: true });
    const moved = (await listOwnUpcomingReservations(admin.client, now)).upcoming[0];
    expect(moved).toMatchObject({ id: original.id, court_id: ids.otherCourt, location_id: ids.location,
      booking_date: targetDate, starts_at_minute: 900, ends_at_minute: 990, reason: "Moved event", created_by_user_id: admin.id,
      status: "active", cancelled_at: null });
    expect(moved.updated_at).not.toBe(reasonRow.updated_at);
    expect(await editOwnDirectReservation({ kind: "schedule", id: coachOriginal.id, expectedUpdatedAt: coachOriginal.updated_at,
      schedule: { courtId: ids.otherCourt, date, startMinute: 720, endMinute: 810, reason: "Coaching moved" } }, coach.client, now)).toEqual({ ok: true });
    expect((await listOwnUpcomingReservations(coach.client, now)).upcoming[0]).toMatchObject({ id: coachOriginal.id,
      court_id: ids.otherCourt, reason: "Coaching moved", created_by_user_id: coach.id });
    const coachMoved = (await listOwnUpcomingReservations(coach.client, now)).upcoming[0];
    const racing = await Promise.all(["Version A", "Version B"].map((reason) => editOwnDirectReservation({
      kind: "reason", id: coachMoved.id, expectedUpdatedAt: coachMoved.updated_at, reason,
    }, coach.client, now)));
    expect(racing.filter((result) => result.ok)).toHaveLength(1);
    expect(racing.filter((result) => !result.ok && result.stale)).toHaveLength(1);
    const coachAfterRace = (await listOwnUpcomingReservations(coach.client, now)).upcoming[0];
    expect(["Version A", "Version B"]).toContain(coachAfterRace.reason);
    expect(coachAfterRace.updated_at).not.toBe(coachMoved.updated_at);
    const retained = await service.from("court_reservations")
      .select("id, court_id, booking_date, starts_at_minute, ends_at_minute, reason, created_by_user_id, cancelled_at, cancelled_by_user_id")
      .eq("id", original.id).single();
    assert.strictEqual(retained.error, null);
    expect(retained.data).toMatchObject({ id: original.id, court_id: ids.otherCourt, booking_date: targetDate,
      starts_at_minute: 900, ends_at_minute: 990, reason: "Moved event", created_by_user_id: admin.id,
      cancelled_at: null, cancelled_by_user_id: null });
    expect(await cancelOwnDirectReservation(original.id, admin.client)).toEqual({ ok: true });
    expect(await editOwnDirectReservation({ kind: "reason", id: original.id, expectedUpdatedAt: moved.updated_at,
      reason: "Too late" }, admin.client, now)).toMatchObject({ ok: false });
    expect((await service.from("court_reservations").select("id").eq("id", original.id)).data).toHaveLength(1);
  } finally {
    assert.strictEqual((await service.from("court_reservations").delete().in("court_id", [ids.court, ids.otherCourt, ids.targetCourt, ids.inactiveCourt, ids.inactiveLocationCourt])).error, null);
    assert.strictEqual((await service.from("location_opening_hours").delete().in("location_id", [ids.location, ids.otherLocation, ids.inactiveLocation])).error, null);
    assert.strictEqual((await service.from("courts").delete().in("location_id", [ids.location, ids.otherLocation, ids.inactiveLocation])).error, null);
    assert.strictEqual((await service.from("locations").delete().in("id", [ids.location, ids.otherLocation, ids.inactiveLocation])).error, null);
    await cleanupAuthFixtures(service, userIds);
  }
}, 30000);

test("direct reservations require active staff, opening hours and an available active court", async () => {
  const service = localFixtureClient();
  await ensureIntegrationAdminAnchor(service);
  const userIds: string[] = [];
  const locationId = randomUUID();
  const otherLocationId = randomUUID();
  const courtId = randomUUID();
  const inactiveCourtId = randomUUID();
  const wrongCourtId = randomUUID();
  const date = "2099-10-15";
  const now = new Date("2099-10-14T12:00:00Z");
  const password = "direct-reservation-password-123";
  const publicClient = () => createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_PUBLISHABLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  async function account(role?: "admin" | "coach") {
    const email = `reservation-${randomUUID()}@example.test`;
    const { data, error } = await service.auth.admin.createUser({ email, password, email_confirm: true });
    assert.strictEqual(error, null); assert.ok(data.user);
    userIds.push(data.user.id);
    if (role) assert.strictEqual((await service.from("user_roles").insert({ user_id: data.user.id, role_code: role })).error, null);
    const client = publicClient();
    assert.strictEqual((await client.auth.signInWithPassword({ email, password })).error, null);
    return { client, id: data.user.id };
  }
  const input = { locationId, courtId, date, startMinute: 600, endMinute: 660, reason: " Sportya tournament " };
  let ruleSetId: string | null = null;
  try {
    assert.strictEqual((await service.from("locations").insert([
      { id: locationId, name: "Internal", slug: `internal-${locationId}`, timezone: "UTC", is_public: false },
      { id: otherLocationId, name: "Other", slug: `other-${otherLocationId}`, timezone: "UTC", is_public: false },
    ])).error, null);
    assert.strictEqual((await service.from("courts").insert([
      { id: courtId, location_id: locationId, name: "Active", slug: "active", surface: "clay", environment: "outdoor", is_active: true },
      { id: inactiveCourtId, location_id: locationId, name: "Inactive", slug: "inactive", surface: "clay", environment: "outdoor", is_active: false },
      { id: wrongCourtId, location_id: otherLocationId, name: "Other", slug: "other", surface: "clay", environment: "outdoor", is_active: true },
    ])).error, null);
    assert.strictEqual((await service.from("location_opening_hours").insert([
      { location_id: locationId, weekday: mondayWeekday(date), opens_at_minute: 600, closes_at_minute: 660 },
      { location_id: locationId, weekday: mondayWeekday(date), opens_at_minute: 720, closes_at_minute: 780 },
      { location_id: locationId, weekday: mondayWeekday("2099-10-16"), opens_at_minute: 600, closes_at_minute: 780 },
    ])).error, null);
    const ruleSet = await service.from("pricing_rule_sets").insert({ location_id: locationId }).select("id").single();
    assert.strictEqual(ruleSet.error, null); ruleSetId = ruleSet.data!.id;
    assert.strictEqual((await service.from("location_pricing_rules").insert({ location_id: locationId,
      rule_set_id: ruleSetId, court_id: courtId, court_state: "outdoor", weekday: mondayWeekday(date),
      starts_at_minute: 600, ends_at_minute: 660, price_per_hour_minor: 5000 })).error, null);
    const admin = await account("admin");
    const coach = await account("coach");
    const member = await account();
    const suspended = await account("coach");
    assert.strictEqual((await service.from("users").update({ status: "suspended" }).eq("id", suspended.id)).error, null);
    await expect(createDirectReservation(input, publicClient(), now)).rejects.toThrow();
    await expect(createDirectReservation(input, member.client, now)).rejects.toThrow();
    await expect(createDirectReservation(input, suspended.client, now)).rejects.toThrow();
    await expect(listInternalLocations(publicClient())).rejects.toThrow();
    await expect(listInternalLocations(member.client)).rejects.toThrow();
    await expect(listInternalLocations(suspended.client)).rejects.toThrow();
    const locations = await listInternalLocations(admin.client);
    expect(locations.find((location) => location.id === locationId)?.courts).toEqual([{ id: courtId, name: "Active" }]);
    expect(locations.some((location) => location.id === otherLocationId)).toBe(false);
    expect((await listInternalLocations(coach.client)).some((location) => location.id === locationId)).toBe(true);
    expect(await createDirectReservation({ ...input, reason: "   " }, admin.client, now)).toMatchObject({ ok: false });
    expect(await createDirectReservation({ ...input, reason: "x".repeat(256) }, admin.client, now)).toMatchObject({ ok: false });
    expect(await createDirectReservation({ ...input, endMinute: 630 }, admin.client, now)).toMatchObject({ ok: false });
    expect(await createDirectReservation({ ...input, endMinute: 750 }, admin.client, now)).toMatchObject({ ok: false });
    expect(await createDirectReservation({ ...input, courtId: inactiveCourtId }, admin.client, now)).toMatchObject({ ok: false });
    expect(await createDirectReservation({ ...input, courtId: wrongCourtId }, admin.client, now)).toMatchObject({ ok: false });
    expect(await createDirectReservation(input, admin.client, now)).toEqual({ ok: true });
    const rows = await service.from("court_reservations")
      .select("id, court_id, booking_date, starts_at_minute, ends_at_minute, reason, created_at, created_by_user_id, status, cancelled_at, cancelled_by_user_id")
      .eq("court_id", courtId).eq("booking_date", date);
    assert.strictEqual(rows.error, null);
    expect(rows.data).toEqual([{ id: expect.any(String), court_id: courtId, booking_date: date,
      starts_at_minute: 600, ends_at_minute: 660, reason: "Sportya tournament", created_at: expect.any(String),
      created_by_user_id: admin.id, status: "active", cancelled_at: null, cancelled_by_user_id: null }]);
    expect(await createDirectReservation({ ...input, created_by_user_id: member.id }, admin.client, now)).toMatchObject({ ok: false });
    expect(await createDirectReservation(input, coach.client, now)).toEqual({ ok: false,
      message: "That court is no longer available for the selected time. Choose another interval." });
    expect(await createDirectReservation({ ...input, startMinute: 720, endMinute: 780, reason: "Course with Andrej" }, coach.client, now)).toEqual({ ok: true });
    const day = await getReservationDay(locations.find((location) => location.id === locationId)!, date, now, admin.client);
    expect(day.courts[0].cells.filter((cell) => cell === "booked")).toHaveLength(4);
    expect(day.adminOccupancy).toEqual(expect.arrayContaining([
      expect.objectContaining({ court_id: courtId, reason: "Sportya tournament", created_by_user_id: admin.id }),
      expect.objectContaining({ court_id: courtId, reason: "Course with Andrej", created_by_user_id: coach.id }),
    ]));
    const coachDay = await getReservationDay(locations.find((location) => location.id === locationId)!, date, now, coach.client);
    expect(coachDay.adminOccupancy).toEqual([]);
    expect(coachDay.courts[0].cells.filter((cell) => cell === "booked")).toHaveLength(4);
    const adminPersonal = await listOwnUpcomingReservations(admin.client, now);
    const coachPersonal = await listOwnUpcomingReservations(coach.client, now);
    expect(adminPersonal.upcoming.map((row) => row.created_by_user_id)).toEqual([admin.id]);
    expect(coachPersonal.upcoming.map((row) => row.created_by_user_id)).toEqual([coach.id]);
    expect(adminPersonal.upcoming[0].reason).toBe("Sportya tournament");
    expect(coachPersonal.upcoming[0].reason).toBe("Course with Andrej");
    const adminEditDay = await getAdminReservationEditDay({ reservationId: coachPersonal.upcoming[0].id, date }, admin.client, now);
    expect(adminEditDay.location).toEqual({ id: locationId, name: "Internal", timezone: "UTC" });
    expect(adminEditDay.day.courts.map((item) => item.court.id)).toEqual([courtId]);
    expect(adminEditDay.day.courts[0].cells).toEqual(["booked", "booked", "closed", "closed", "available", "available"]);
    const changedDate = await getAdminReservationEditDay({ reservationId: coachPersonal.upcoming[0].id,
      date: "2099-10-16" }, admin.client, now);
    expect(changedDate.location.id).toBe(locationId);
    expect(changedDate.day.courts[0].cells).toEqual(["available", "available", "available", "available", "available", "available"]);
    await expect(getAdminReservationEditDay({ reservationId: coachPersonal.upcoming[0].id, date }, coach.client, now)).rejects.toThrow();
    await expect(getAdminReservationEditDay({ reservationId: coachPersonal.upcoming[0].id, date }, member.client, now)).rejects.toThrow();
    await expect(getAdminReservationEditDay({ reservationId: coachPersonal.upcoming[0].id, date }, suspended.client, now)).rejects.toThrow();
    await expect(getAdminReservationEditDay({ reservationId: randomUUID(), date }, admin.client, now)).rejects.toThrow();
    expect((await listOwnUpcomingReservations(member.client, now)).upcoming).toEqual([]);
    expect(await listOwnCourtHistory(1, member.client, now)).toMatchObject({ rows: [], hasNext: false, page: 1 });
    expect((await publicClient().from("court_reservations").select("reason").eq("court_id", courtId)).error?.code).toBe("42501");
    expect((await publicClient().from("court_reservations").select("created_by_user_id").eq("court_id", courtId)).error?.code).toBe("42501");
    assert.strictEqual((await service.from("locations").update({ is_public: true }).eq("id", locationId)).error, null);
    const publicBefore = await publicClient().from("court_reservations").select("court_id, booking_date, starts_at_minute, ends_at_minute")
      .eq("court_id", courtId).eq("booking_date", date);
    expect(publicBefore.error?.code).toBe("42501");
    await expect(cancelOwnDirectReservation(rows.data![0].id, member.client)).rejects.toThrow();
    await expect(cancelOwnDirectReservation(rows.data![0].id, publicClient())).rejects.toThrow();
    const coachReservation = coachPersonal.upcoming[0];
    expect(await cancelOwnDirectReservation(coachReservation.id, admin.client)).toMatchObject({ ok: false, message: expect.stringContaining("no longer") });
    expect(await cancelOwnDirectReservation(rows.data![0].id, coach.client)).toMatchObject({ ok: false, message: expect.stringContaining("no longer") });
    expect(await cancelOwnDirectReservation(rows.data![0].id, admin.client)).toEqual({ ok: true });
    expect(await cancelOwnDirectReservation(rows.data![0].id, admin.client)).toMatchObject({ ok: false, message: expect.stringContaining("no longer") });
    const concurrent = await Promise.all([
      cancelOwnDirectReservation(coachReservation.id, coach.client), cancelOwnDirectReservation(coachReservation.id, coach.client),
    ]);
    expect(concurrent).toEqual(expect.arrayContaining([{ ok: true }, expect.objectContaining({ ok: false })]));
    const after = await getReservationDay(locations.find((location) => location.id === locationId)!, date, now, admin.client);
    expect(after.courts[0].cells.filter((cell) => cell === "booked")).toHaveLength(0);
    expect(after.adminOccupancy).toEqual([]);
    const publicAfter = await publicClient().from("court_reservations").select("court_id, booking_date, starts_at_minute, ends_at_minute")
      .eq("court_id", courtId).eq("booking_date", date);
    expect(publicAfter.error?.code).toBe("42501");
    const retained = await service.from("court_reservations")
      .select("id, court_id, booking_date, starts_at_minute, ends_at_minute, reason, created_at, created_by_user_id, status, cancelled_at, cancelled_by_user_id")
      .eq("court_id", courtId).eq("booking_date", date).order("starts_at_minute");
    assert.strictEqual(retained.error, null);
    expect(retained.data).toEqual([
      { ...rows.data![0], status: "cancelled", cancelled_at: expect.any(String), cancelled_by_user_id: admin.id },
      { id: coachReservation.id, court_id: courtId, booking_date: date, starts_at_minute: 720, ends_at_minute: 780,
        reason: "Course with Andrej", created_at: expect.any(String), created_by_user_id: coach.id, status: "cancelled",
        cancelled_at: expect.any(String), cancelled_by_user_id: coach.id },
    ]);
    const adminHistory = await listOwnCourtHistory(1, admin.client, now);
    const coachHistory = await listOwnCourtHistory(1, coach.client, now);
    expect(adminHistory.rows.map((row) => row.id)).toEqual([rows.data![0].id]);
    expect(coachHistory.rows.map((row) => row.id)).toEqual([coachReservation.id]);
    expect(adminHistory.rows[0]).toMatchObject({ status: "cancelled", cancelled_at: expect.any(String) });
    const archived = Array.from({ length: 21 }, (_, index) => ({
      id: randomUUID(), court_id: courtId, booking_date: "2099-09-01",
      starts_at_minute: 600, ends_at_minute: 660, reason: `Archived ${index}`,
      created_by_user_id: admin.id, status: "cancelled" as const,
      cancelled_at: new Date(Date.UTC(2099, 9, 1, 0, index)).toISOString(), cancelled_by_user_id: admin.id,
    }));
    const elapsedId = randomUUID();
    assert.strictEqual((await service.from("court_reservations").insert([
      ...archived, { id: elapsedId, court_id: courtId, booking_date: "2099-10-13",
        starts_at_minute: 600, ends_at_minute: 660, reason: "Elapsed",
        created_by_user_id: admin.id, status: "active" as const,
        cancelled_at: null, cancelled_by_user_id: null },
    ])).error, null);
    const firstPage = await listOwnCourtHistory(1, admin.client, now);
    const secondPage = await listOwnCourtHistory(2, admin.client, now);
    expect(firstPage.rows).toHaveLength(20);
    expect(firstPage.hasNext).toBe(true);
    // Current activity sorts by booking start, then kind/UUID, rather than cancellation time.
    const historyIds = [rows.data![0].id, elapsedId, ...archived.map((row) => row.id).sort()];
    expect([...firstPage.rows, ...secondPage.rows].map((row) => row.id)).toEqual(historyIds);
    expect(secondPage.hasNext).toBe(false);
    expect((await listOwnCourtHistory(3, admin.client, now)).rows).toEqual([]);
    expect((await listOwnUpcomingReservations(admin.client, now)).upcoming).toEqual([]);
    expect((await listOwnCourtHistory(1, coach.client, now)).rows).toHaveLength(1);
    expect(await createDirectReservation(input, admin.client, now)).toEqual({ ok: true });
  } finally {
    if (ruleSetId) {
      assert.strictEqual((await service.from("location_pricing_rules").delete().eq("rule_set_id", ruleSetId)).error, null);
      assert.strictEqual((await service.from("pricing_rule_sets").delete().eq("id", ruleSetId)).error, null);
    }
    assert.strictEqual((await service.from("court_reservations").delete().in("court_id", [courtId, inactiveCourtId, wrongCourtId])).error, null);
    assert.strictEqual((await service.from("location_opening_hours").delete().in("location_id", [locationId, otherLocationId])).error, null);
    assert.strictEqual((await service.from("courts").delete().in("location_id", [locationId, otherLocationId])).error, null);
    assert.strictEqual((await service.from("locations").delete().in("id", [locationId, otherLocationId])).error, null);
    await cleanupAuthFixtures(service, userIds);
  }
}, 30000);
