import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readCurrentAccount: vi.fn(),
  notFound: vi.fn(() => { throw new Error("notFound"); }),
  redirect: vi.fn((path: string) => { throw new Error(`redirect:${path}`); }),
  inTransaction: vi.fn(),
  lockConfigurationForRead: vi.fn(),
  lockReservationActorFacts: vi.fn(),
  lockCoachProfile: vi.fn(),
  lockCoachingProgram: vi.fn(),
  upsertCoachingPrice: vi.fn(),
  deleteCoachingPrice: vi.fn(),
}));
vi.mock("@/lib/auth/account", () => ({ readCurrentAccount: mocks.readCurrentAccount }));
vi.mock("next/navigation", () => ({ notFound: mocks.notFound, redirect: mocks.redirect }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => ({})) }));
vi.mock("@/lib/db/data-source", () => ({ getDataSource: vi.fn() }));
vi.mock("@/lib/db/transaction", () => ({ inTransaction: mocks.inTransaction, inReadSnapshot: vi.fn(), readIndependently: vi.fn() }));
vi.mock("@/lib/db/repositories/clubs.repository", () => ({ lockConfigurationForRead: mocks.lockConfigurationForRead }));
vi.mock("@/lib/db/repositories/accounts.repository", () => ({ lockReservationActorFacts: mocks.lockReservationActorFacts, lockActiveAdminAccount: vi.fn() }));
vi.mock("@/lib/db/repositories/coaching.repository", () => ({
  lockCoachProfile: mocks.lockCoachProfile, lockCoachingProgram: mocks.lockCoachingProgram,
  upsertCoachingPrice: mocks.upsertCoachingPrice, deleteCoachingPrice: mocks.deleteCoachingPrice,
}));

import { removeOwnCoachingPrice, saveOwnCoachingPrice } from "@/lib/coaching/coach-pricing";

const coach = "c1000000-0000-4000-8000-00000000000a";
const otherCoach = "c1000000-0000-4000-8000-00000000000b";
const program = "a1000000-0000-4000-8000-000000000001";
const input = { program_id: program, duration_minutes: 60, participant_count: 1, currency: "RON", amount: "150" };
const key = { program_id: program, duration_minutes: 60, participant_count: 1, currency: "RON" };
const manager = {};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.readCurrentAccount.mockResolvedValue({ state: "active", userId: coach, email: "c@example.test", roles: ["coach"] });
  mocks.inTransaction.mockImplementation(async (work: (value: unknown) => unknown) => work(manager));
  mocks.lockReservationActorFacts.mockResolvedValue({ status: "active", roles: ["coach"] });
  mocks.lockCoachProfile.mockResolvedValue({ userId: coach, locationIds: [], programIds: [program] });
  mocks.lockCoachingProgram.mockResolvedValue({ id: program, programType: "private", durations: [60, 90], minParticipants: 1, maxParticipants: 1 });
  mocks.upsertCoachingPrice.mockResolvedValue("price-1");
  mocks.deleteCoachingPrice.mockResolvedValue("price-1");
});

it("saves an override only for the signed-in coach, keyed by program, duration and currency", async () => {
  expect(await saveOwnCoachingPrice(input)).toEqual({ ok: true, id: "price-1" });
  expect(mocks.lockCoachProfile).toHaveBeenCalledWith(manager, coach, "pessimistic_read");
  expect(mocks.upsertCoachingPrice).toHaveBeenCalledWith(manager,
    { programId: program, durationMinutes: 60, participantCount: 1, currency: "RON", coachUserId: coach }, 15000, expect.any(Date));
  expect(await removeOwnCoachingPrice(key)).toEqual({ ok: true, id: "price-1" });
  expect(mocks.deleteCoachingPrice).toHaveBeenCalledWith(manager, { programId: program, durationMinutes: 60, participantCount: 1, currency: "RON", coachUserId: coach });
});

it("cannot address another coach, a club default or a location", async () => {
  for (const extra of [{ coach_user_id: otherCoach }, { coach_user_id: null }, { location_id: "b1000000-0000-4000-8000-000000000001" }]) {
    expect(await saveOwnCoachingPrice({ ...input, ...extra })).toMatchObject({ ok: false, reason: "invalid-input" });
    expect(await removeOwnCoachingPrice({ ...key, ...extra }))
      .toMatchObject({ ok: false, reason: "invalid-input" });
  }
  expect(mocks.inTransaction).not.toHaveBeenCalled();
});

it("requires an active coach account offering the program and duration", async () => {
  mocks.readCurrentAccount.mockResolvedValueOnce({ state: "active", userId: "admin", email: "a@example.test", roles: ["admin"] });
  await expect(saveOwnCoachingPrice(input)).rejects.toThrow("notFound");

  mocks.lockCoachProfile.mockResolvedValueOnce({ userId: coach, locationIds: [], programIds: [] });
  expect(await saveOwnCoachingPrice(input)).toEqual({ ok: false, reason: "not-offered" });
  expect(await saveOwnCoachingPrice({ ...input, duration_minutes: 45 })).toMatchObject({ ok: false, reason: "invalid-input" });
  mocks.lockReservationActorFacts.mockResolvedValueOnce({ status: "suspended", roles: ["coach"] });
  expect(await saveOwnCoachingPrice(input)).toEqual({ ok: false, reason: "not-eligible" });
  mocks.lockCoachProfile.mockResolvedValueOnce(null);
  expect(await saveOwnCoachingPrice(input)).toEqual({ ok: false, reason: "not-eligible" });
  expect(mocks.upsertCoachingPrice).not.toHaveBeenCalled();
});

it("rejects own prices for Group and Junior programs, which are club-priced, but still removes obsolete ones", async () => {
  for (const programType of ["group", "junior"]) {
    mocks.lockCoachingProgram.mockResolvedValueOnce({ id: program, programType, durations: [60, 90], minParticipants: 3, maxParticipants: 6 });
    expect(await saveOwnCoachingPrice(input)).toEqual({ ok: false, reason: "club-priced" });
  }
  expect(mocks.upsertCoachingPrice).not.toHaveBeenCalled();
  mocks.lockCoachingProgram.mockResolvedValueOnce({ id: program, programType: "semi_private", durations: [60, 90], minParticipants: 1, maxParticipants: 2 });
  expect(await saveOwnCoachingPrice(input)).toEqual({ ok: true, id: "price-1" });
  expect(await removeOwnCoachingPrice(key)).toEqual({ ok: true, id: "price-1" });
});

it("saves an override only for a participant count inside the program's current range", async () => {
  mocks.lockCoachingProgram.mockResolvedValue({ id: program, programType: "semi_private", durations: [60, 90], minParticipants: 2, maxParticipants: 4 });
  expect(await saveOwnCoachingPrice({ ...input, participant_count: 3 })).toEqual({ ok: true, id: "price-1" });
  expect(mocks.upsertCoachingPrice).toHaveBeenLastCalledWith(manager,
    { programId: program, durationMinutes: 60, participantCount: 3, currency: "RON", coachUserId: coach }, 15000, expect.any(Date));
  expect(await saveOwnCoachingPrice({ ...input, participant_count: 5 }))
    .toEqual({ ok: false, reason: "invalid-input", fieldErrors: { participant_count: "Use a player count from 2 to 4." } });
  expect(await saveOwnCoachingPrice({ ...input, participant_count: 1 })).toMatchObject({ ok: false, reason: "invalid-input" });
  mocks.lockCoachingProgram.mockResolvedValue({ id: program, programType: "semi_private", durations: [60, 90], minParticipants: null, maxParticipants: 4 });
  expect(await saveOwnCoachingPrice({ ...input, participant_count: 3 })).toEqual({ ok: false, reason: "participants-required" });
  expect(mocks.upsertCoachingPrice).toHaveBeenCalledTimes(1);
  expect(await saveOwnCoachingPrice({ ...input, participant_count: undefined })).toMatchObject({ ok: false, reason: "invalid-input" });
});
