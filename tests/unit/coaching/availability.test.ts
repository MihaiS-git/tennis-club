import { assert, beforeEach, expect, it, vi } from "vitest";

const { readCurrentAccount, notFound, redirect, getDataSource } = vi.hoisted(() => ({
  readCurrentAccount: vi.fn(),
  notFound: vi.fn(() => { throw new Error("notFound"); }),
  redirect: vi.fn((path: string) => { throw new Error(`redirect:${path}`); }),
  getDataSource: vi.fn(),
}));
vi.mock("@/lib/auth/account", () => ({ readCurrentAccount }));
vi.mock("next/navigation", () => ({ notFound, redirect }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => ({})) }));
vi.mock("@/lib/db/data-source", () => ({ getDataSource }));

import { resolveCoachAvailability } from "@/lib/coaching/availability-schedule";
import {
  changeCoachAvailability, changeOwnCoachAvailability, loadAdminCoachAvailability, loadOwnCoachAvailability,
} from "@/lib/coaching/availability";
import {
  adminAvailabilityChangeSchema, availabilityChangeSchema, availabilityExceptionFieldsSchema, availabilityFieldErrors,
  weeklyAvailabilityBatchFieldsSchema, weeklyAvailabilityFieldsSchema,
} from "@/lib/coaching/availability-validation";
import CoachLayout from "@/app/coach/layout";

beforeEach(() => vi.clearAllMocks());

const locationA = "a1000000-0000-4000-8000-000000000001";
const locationB = "a1000000-0000-4000-8000-000000000002";
const weekly = (overrides = {}) => ({ location_id: locationA, weekday: 0, start_minute: 540, end_minute: 720, ...overrides });
const exception = (overrides = {}) => ({ date: "2099-06-01", kind: "unavailable", location_id: null, start_minute: null, end_minute: null, note: "", ...overrides });

it.each([
  [{}, true],
  [{ start_minute: 0, end_minute: 1440 }, true],
  [{ start_minute: 540, end_minute: 540 }, false],
  [{ start_minute: 600, end_minute: 540 }, false],
  [{ start_minute: 545 }, false],
  [{ end_minute: 735 }, false],
  [{ start_minute: 1440, end_minute: 1440 }, false],
  [{ end_minute: 1470 }, false],
  [{ weekday: 7 }, false],
  [{ location_id: "not-a-uuid" }, false],
])("validates weekly intervals on 30-minute boundaries %#", (overrides, valid) => {
  expect(weeklyAvailabilityFieldsSchema.safeParse(weekly(overrides)).success).toBe(valid);
});

it.each([
  [{}, true],
  [{ weekdays: [6] }, true],
  [{ weekdays: [0, 1, 2, 3, 4, 5, 6] }, true],
  [{ weekdays: [] }, false],
  [{ weekdays: [1, 1] }, false],
  [{ weekdays: [7] }, false],
  [{ start_minute: 545 }, false],
  [{ start_minute: 720, end_minute: 540 }, false],
])("validates multi-day weekly additions %#", (overrides, valid) => {
  expect(weeklyAvailabilityBatchFieldsSchema.safeParse({ location_id: locationA, weekdays: [0, 2, 4], start_minute: 540, end_minute: 720, ...overrides }).success).toBe(valid);
});

it("reports a missing weekday selection on the weekdays field", () => {
  const parsed = availabilityChangeSchema.safeParse({ operation: "add-weekly", fields: { location_id: locationA, weekdays: [], start_minute: 540, end_minute: 720 } });
  assert(!parsed.success);
  expect(availabilityFieldErrors(parsed.error.issues)).toEqual({ weekdays: "Select at least one day." });
});

it.each([
  [{}, true],
  [{ start_minute: 600, end_minute: 660 }, true],
  [{ kind: "available", location_id: locationA, start_minute: 1080, end_minute: 1200 }, true],
  // Additional hours need a location and an interval; absences are coach-wide.
  [{ kind: "available", start_minute: 1080, end_minute: 1200 }, false],
  [{ kind: "available", location_id: locationA }, false],
  [{ location_id: locationA }, false],
  [{ start_minute: 600 }, false],
  [{ start_minute: 600, end_minute: 600 }, false],
  [{ date: "2099-02-30" }, false],
  [{ note: "x".repeat(201) }, false],
  [{ kind: "maybe" }, false],
])("validates date exceptions %#", (overrides, valid) => {
  expect(availabilityExceptionFieldsSchema.safeParse(exception(overrides)).success).toBe(valid);
});

it("rejects unknown fields, including a coach chosen by a coach", () => {
  expect(availabilityChangeSchema.safeParse({ operation: "save-weekly", fields: weekly(), coach_user_id: locationA }).success).toBe(false);
  expect(availabilityChangeSchema.safeParse({ operation: "save-weekly", fields: { ...weekly(), coach_user_id: locationA } }).success).toBe(false);
  expect(adminAvailabilityChangeSchema.safeParse({ coach_user_id: locationA, change: { operation: "remove-weekly", id: locationB } }).success).toBe(true);
});

it("resolves the weekly schedule with multiple intervals and locations in each location's timezone", () => {
  const timezones = new Map([[locationA, "Europe/Bucharest"], [locationB, "UTC"]]);
  // 2099-06-01 is a Monday.
  const windows = resolveCoachAvailability({ date: "2099-06-01", timezones, exceptions: [], weekly: [
    weekly(), weekly({ start_minute: 900, end_minute: 1140 }), weekly({ location_id: locationB, start_minute: 1200, end_minute: 1260 }),
    weekly({ weekday: 1, start_minute: 600, end_minute: 840 }),
  ] });
  expect(windows).toEqual([
    { location_id: locationA, date: "2099-06-01", start_minute: 540, end_minute: 720, starts_at: "2099-06-01T06:00:00.000Z", ends_at: "2099-06-01T09:00:00.000Z", source: "weekly" },
    { location_id: locationA, date: "2099-06-01", start_minute: 900, end_minute: 1140, starts_at: "2099-06-01T12:00:00.000Z", ends_at: "2099-06-01T16:00:00.000Z", source: "weekly" },
    { location_id: locationB, date: "2099-06-01", start_minute: 1200, end_minute: 1260, starts_at: "2099-06-01T20:00:00.000Z", ends_at: "2099-06-01T21:00:00.000Z", source: "weekly" },
  ]);
  expect(resolveCoachAvailability({ date: "2099-06-03", timezones, exceptions: [], weekly: [weekly()] })).toEqual([]);
  // Locations the caller does not accept (e.g. archived) are omitted.
  expect(resolveCoachAvailability({ date: "2099-06-01", timezones: new Map(), exceptions: [], weekly: [weekly()] })).toEqual([]);
});

it("lets exceptions override the weekly schedule for their interval only", () => {
  const timezones = new Map([[locationA, "UTC"], [locationB, "UTC"]]);
  const base = [weekly({ start_minute: 540, end_minute: 1140 })];
  const on = (exceptions: ReturnType<typeof exception>[]) => resolveCoachAvailability({ date: "2099-06-01", timezones, weekly: base, exceptions: exceptions as never })
    .map((window) => [window.location_id, window.start_minute, window.end_minute, window.source]);
  expect(on([exception()])).toEqual([]);
  expect(on([exception({ start_minute: 720, end_minute: 780 })])).toEqual([[locationA, 540, 720, "weekly"], [locationA, 780, 1140, "weekly"]]);
  // Additional hours outside, and replacing part of, the regular schedule at another location.
  expect(on([exception({ kind: "available", location_id: locationA, start_minute: 1200, end_minute: 1320 })]))
    .toEqual([[locationA, 540, 1140, "weekly"], [locationA, 1200, 1320, "exception"]]);
  expect(on([exception({ kind: "available", location_id: locationB, start_minute: 600, end_minute: 660 })]))
    .toEqual([[locationA, 540, 600, "weekly"], [locationB, 600, 660, "exception"], [locationA, 660, 1140, "weekly"]]);
  // Exceptions on other dates do not apply.
  expect(on([exception({ date: "2099-06-08" })])).toEqual([[locationA, 540, 1140, "weekly"]]);
});

it("converts across daylight-saving changes and drops skipped local time", () => {
  const timezones = new Map([[locationA, "Europe/Bucharest"]]);
  // 2099-03-29 (Sunday): 03:00 local jumps to 04:00 in Europe/Bucharest.
  const spring = resolveCoachAvailability({ date: "2099-03-29", timezones, exceptions: [], weekly: [
    weekly({ weekday: 6, start_minute: 180, end_minute: 240 }), weekly({ weekday: 6, start_minute: 480, end_minute: 600 }),
  ] });
  expect(spring).toEqual([expect.objectContaining({ start_minute: 480, starts_at: "2099-03-29T05:00:00.000Z", ends_at: "2099-03-29T07:00:00.000Z" })]);
  const winter = resolveCoachAvailability({ date: "2099-12-07", timezones, exceptions: [], weekly: [weekly({ end_minute: 1440, start_minute: 1380 })] });
  expect(winter).toEqual([expect.objectContaining({ starts_at: "2099-12-07T21:00:00.000Z", ends_at: "2099-12-07T22:00:00.000Z" })]);
});

it.each([
  ["a member", { state: "active", userId: "u", email: "m@example.test", roles: [] }, "notFound"],
  ["an Admin without the Coach role", { state: "active", userId: "u", email: "a@example.test", roles: ["admin"] }, "notFound"],
  ["a suspended coach", { state: "suspended", userId: "u", email: "c@example.test", roles: ["coach"] }, "notFound"],
  ["an anonymous visitor", { state: "unauthenticated" }, "redirect:/login"],
])("denies the Coach area to %s before any database access", async (_label, account, failure) => {
  readCurrentAccount.mockResolvedValue(account);
  for (const operation of [() => loadOwnCoachAvailability(), () => changeOwnCoachAvailability({}), () => CoachLayout({ children: null })]) {
    await expect(operation()).rejects.toThrow(failure);
  }
  expect(getDataSource).not.toHaveBeenCalled();
});

it.each([
  ["a coach", { state: "active", userId: "u", email: "c@example.test", roles: ["coach"] }, "notFound"],
  ["a member", { state: "active", userId: "u", email: "m@example.test", roles: [] }, "notFound"],
  ["an anonymous visitor", { state: "unauthenticated" }, "redirect:/login"],
])("denies Admin availability management to %s", async (_label, account, failure) => {
  readCurrentAccount.mockResolvedValue(account);
  await expect(loadAdminCoachAvailability(undefined)).rejects.toThrow(failure);
  await expect(changeCoachAvailability({ coach_user_id: locationA, change: { operation: "remove-weekly", id: locationB } })).rejects.toThrow(failure);
  expect(getDataSource).not.toHaveBeenCalled();
});

it("returns field errors for invalid changes without database access", async () => {
  readCurrentAccount.mockResolvedValue({ state: "active", userId: locationA, email: "c@example.test", roles: ["coach", "admin"] });
  expect(await changeOwnCoachAvailability({ operation: "save-weekly", fields: weekly({ end_minute: 510 }) }))
    .toEqual({ ok: false, reason: "invalid-input", fieldErrors: { end_minute: "End time must be after start time." } });
  expect(await changeCoachAvailability({ coach_user_id: locationA, change: { operation: "save-exception", fields: exception({ kind: "available" }) } }))
    .toMatchObject({ ok: false, reason: "invalid-input", fieldErrors: { location_id: "Select a location." } });
  expect(getDataSource).not.toHaveBeenCalled();
});
