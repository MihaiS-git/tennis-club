import { DataSource, type EntityManager } from "typeorm";
import { beforeEach, expect, it, vi } from "vitest";

const { insert, update, weekly, schedules, hours } = vi.hoisted(() => ({
  insert: vi.fn(), update: vi.fn(), weekly: vi.fn(), schedules: vi.fn(), hours: vi.fn(),
}));
const coach = "c1000000-0000-4000-8000-000000000001";
const location = "b1000000-0000-4000-8000-000000000001";
vi.mock("@/lib/coaching/authorization", () => ({ requireActiveCoach: async () => ({ userId: coach }) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/db/transaction", () => ({
  inTransaction: (work: (manager: EntityManager) => Promise<unknown>) => work(new DataSource({ type: "postgres" }).manager),
}));
vi.mock("@/lib/db/repositories/coaching.repository", () => ({
  lockCoachProfile: async () => ({ userId: coach, locationIds: [location] }),
}));
vi.mock("@/lib/db/repositories/accounts.repository", () => ({
  lockReservationActorFacts: async () => ({ status: "active", roles: ["coach"] }),
}));
vi.mock("@/lib/db/repositories/clubs.repository", () => ({
  lockConfigurationForRead: vi.fn(),
  lockLocationsForRead: async () => [{ id: location, timezone: "Europe/Bucharest", archivedAt: null }],
  listOpeningHoursSchedules: schedules, listLocationOpeningHours: hours,
}));
vi.mock("@/lib/db/repositories/coach-availability.repository", () => ({
  listCoachWeeklyAvailability: weekly, insertCoachWeeklyAvailability: insert, updateCoachWeeklyAvailability: update,
}));

import { changeOwnCoachAvailability } from "@/lib/coaching/availability";

const id = "d1000000-0000-4000-8000-000000000001";
const fields = { location_id: location, start_minute: 660, end_minute: 900, valid_from: "2099-01-01", valid_until: null };
beforeEach(() => {
  vi.clearAllMocks();
  weekly.mockResolvedValue([]);
  schedules.mockResolvedValue([{ id: "baseline", startsOn: "0001-01-01", endsOn: null }]);
  hours.mockResolvedValue([0, 1, 2, 3, 4].flatMap((weekday) => [
    { scheduleId: "baseline", weekday, opensAtMinute: 480, closesAtMinute: 720 },
    { scheduleId: "baseline", weekday, opensAtMinute: 840, closesAtMinute: 1260 },
  ]));
  insert.mockResolvedValue(id);
});

it.each(["add-weekly", "save-weekly"] as const)("rejects a direct %s submission crossing lunch before persistence", async (operation) => {
  const change = operation === "add-weekly" ? { operation, fields: { ...fields, weekdays: [0, 1] } }
    : { operation, fields: { ...fields, weekday: 0 } };
  expect(await changeOwnCoachAvailability(change)).toEqual({ ok: false, reason: "outside-opening-hours", weekdays: operation === "add-weekly" ? [0, 1] : [0] });
  expect(insert).not.toHaveBeenCalled();
  expect(update).not.toHaveBeenCalled();
});

it("checks future schedules for a direct submission", async () => {
  schedules.mockResolvedValue([{ id: "baseline", startsOn: "0001-01-01", endsOn: "2099-06-30" },
    { id: "future", startsOn: "2099-07-01", endsOn: null }]);
  hours.mockResolvedValue([{ scheduleId: "baseline", weekday: 0, opensAtMinute: 480, closesAtMinute: 1320 },
    { scheduleId: "future", weekday: 0, opensAtMinute: 600, closesAtMinute: 1200 }]);
  expect(await changeOwnCoachAvailability({ operation: "add-weekly", fields: { ...fields, weekdays: [0], start_minute: 480, end_minute: 720 } }))
    .toEqual({ ok: false, reason: "outside-opening-hours", weekdays: [0] });
  expect(insert).not.toHaveBeenCalled();
});

it("accepts a direct submission contained within one opening interval", async () => {
  expect(await changeOwnCoachAvailability({ operation: "add-weekly", fields: { ...fields, weekdays: [0], start_minute: 480, end_minute: 720 } }))
    .toEqual({ ok: true, id, ids: [id] });
  expect(insert).toHaveBeenCalledOnce();
});
