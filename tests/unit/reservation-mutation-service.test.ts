import { createClient } from "@supabase/supabase-js";
import { QueryFailedError } from "typeorm";
import { beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({ account: vi.fn(), create: vi.fn(), edit: vi.fn(), cancel: vi.fn() }));
vi.mock("@/lib/auth/account", () => ({ readCurrentAccount: mocks.account }));
vi.mock("@/lib/reservations/commands", () => ({
  createDirectReservationCommand: mocks.create, editDirectReservationCommand: mocks.edit, cancelDirectReservationCommand: mocks.cancel,
}));
import { createDirectReservation, editDirectReservationAsAdmin, cancelDirectReservationAsAdmin } from "@/lib/reservations/service";
import { editOwnDirectReservation, cancelOwnDirectReservation } from "@/lib/reservations/personal-service";

const id = "ca000000-0000-4000-8000-000000000001";
const client = createClient("http://localhost:54321", "user-key", { auth: { persistSession: false } });
const now = new Date("2099-10-14T12:00:00Z");
const schedule = { locationId: id, courtId: id, date: "2099-10-15", startMinute: 600, endMinute: 660, reason: " Training " };
const edit = { kind: "reason", id, expectedUpdatedAt: "2026-10-01T12:00:00.123456+00:00", reason: " Training " };
const operations = [
  { name: "create", call: () => createDirectReservation(schedule, client, now), command: mocks.create,
    failure: "Unable to reserve this court. Try again.", overlap: "That court is no longer available for the selected time. Choose another interval." },
  { name: "Admin edit", call: () => editDirectReservationAsAdmin(edit, client, now), command: mocks.edit,
    failure: "Unable to save this reservation. Refresh the details before trying again.", overlap: "That court is no longer available for the selected time. The existing reservation has not been changed." },
  { name: "owner edit", call: () => editOwnDirectReservation(edit, client, now), command: mocks.edit,
    failure: "Unable to save this reservation. Refresh the details before trying again.", overlap: "That court is no longer available for the selected time. Your existing reservation has not been changed." },
  { name: "Admin cancel", call: () => cancelDirectReservationAsAdmin(id, client), command: mocks.cancel,
    failure: "Unable to cancel this reservation. Try again.", overlap: undefined },
  { name: "owner cancel", call: () => cancelOwnDirectReservation(id, client), command: mocks.cancel,
    failure: "Unable to cancel this reservation. Try again.", overlap: undefined },
];
beforeEach(() => {
  vi.resetAllMocks(); mocks.account.mockResolvedValue({ state: "active", userId: id, roles: ["admin"] });
});
function databaseFailure(code: string, constraint?: string) {
  return new QueryFailedError("private query", [], Object.assign(new Error("private details"), { code, constraint }));
}
test.each(operations)("$name denies non-staff before persistence", async ({ call, command }) => {
  mocks.account.mockResolvedValue({ state: "active", userId: id, roles: [] });
  await expect(call()).rejects.toThrow(); expect(command).not.toHaveBeenCalled();
});
test.each([operations[4]])("$name sanitizes errors after transaction rollback", async ({ call, command, failure }) => {
  for (const code of ["23503", "23514", "23505", "40P01", "40001"]) {
    command.mockRejectedValue(databaseFailure(code));
    expect(await call()).toEqual({ ok: false, message: failure });
  }
});
test.each([operations[0]])("$name translates only the exact reservation overlap constraint", async ({ call, command, failure, overlap }) => {
  command.mockRejectedValue(databaseFailure("23P01", "court_reservation_no_overlap"));
  expect(await call()).toEqual({ ok: false, message: overlap });
  command.mockRejectedValue(databaseFailure("23P01", "another_exclusion"));
  expect(await call()).toEqual({ ok: false, message: failure });
  command.mockRejectedValue(databaseFailure("23P01"));
  expect(await call()).toEqual({ ok: false, message: failure });
});
test("validates before persistence and trims reason without altering the token", async () => {
  mocks.edit.mockResolvedValue({ ok: true, reservation: {} }); mocks.create.mockResolvedValue({ ok: true });
  await editOwnDirectReservation(edit, client, now);
  expect(mocks.edit).toHaveBeenCalledWith({ ...edit, reason: "Training" }, id, "owner", now);
  await createDirectReservation(schedule, client, now);
  expect(mocks.create).toHaveBeenCalledWith({ ...schedule, reason: "Training" }, id, now);
  mocks.create.mockClear();
  expect(await createDirectReservation({ ...schedule, reason: " " }, client, now)).toEqual({ ok: false, message: "Enter a reason." });
  expect(mocks.create).not.toHaveBeenCalled();
});
