import { beforeEach, expect, it, vi } from "vitest";
import type { CurrentAccount, readCurrentAccount } from "@/lib/auth/account";

const mocks = vi.hoisted(() => ({
  account: vi.fn(), dataSource: vi.fn(), create: vi.fn(), edit: vi.fn(), cancel: vi.fn(), cancelBooking: vi.fn(),
  notFound: vi.fn(() => { throw new Error("notFound"); }),
  redirect: vi.fn((path: string) => { throw new Error(`redirect:${path}`); }),
}));
vi.mock("@/lib/auth/account", () => ({ readCurrentAccount: mocks.account }));
vi.mock("next/navigation", () => ({ notFound: mocks.notFound, redirect: mocks.redirect }));
vi.mock("@/lib/db/data-source", () => ({ getDataSource: mocks.dataSource }));
vi.mock("@/lib/reservations/commands", () => ({
  createDirectReservationCommand: mocks.create,
  editDirectReservationCommand: mocks.edit,
  cancelDirectReservationCommand: mocks.cancel,
}));
vi.mock("@/lib/bookings/cancellation-service", () => ({ cancelBookingCommand: mocks.cancelBooking }));

import {
  cancelDirectReservationAsAdmin, cancelCustomerBookingAsAdmin, getAdminDirectReservation,
  getAdminReservationEditDay, editDirectReservationAsAdmin,
} from "@/lib/reservations/service";

const client = {} as Parameters<typeof readCurrentAccount>[0];
const id = "ca000000-0000-4000-8000-000000000001";
const operations = [
  { name: "direct cancellation", call: () => cancelDirectReservationAsAdmin(id, client) },
  { name: "booking cancellation", call: () => cancelCustomerBookingAsAdmin(id, client) },
  { name: "direct details", call: () => getAdminDirectReservation(id, client) },
  { name: "edit availability", call: () => getAdminReservationEditDay({ reservationId: id, date: "2099-10-15" }, client) },
  { name: "direct edit", call: () => editDirectReservationAsAdmin({
    kind: "reason", id, expectedUpdatedAt: "2026-10-01T12:00:00.123456+00:00", reason: "Training",
  }, client) },
];

beforeEach(() => vi.resetAllMocks());

const deniedAccounts = [
  { account: { state: "unauthenticated" }, error: "redirect:/login" },
  { account: { state: "missing-profile" }, error: "redirect:/login" },
  { account: { state: "suspended", userId: id, email: "a@example.test", roles: ["admin"] }, error: "notFound" },
  { account: { state: "active", userId: id, email: "m@example.test", roles: [] }, error: "notFound" },
  { account: { state: "active", userId: id, email: "c@example.test", roles: ["coach"] }, error: "notFound" },
  { account: { state: "load-error" }, error: "notFound" },
] satisfies { account: CurrentAccount; error: string }[];

it.each(operations)("$name rejects unauthorized accounts before protected access", async ({ call }) => {
  for (const { account, error } of deniedAccounts) {
    vi.clearAllMocks();
    mocks.account.mockResolvedValue(account);
    await expect(call()).rejects.toThrow(error);
    expect(mocks.account).toHaveBeenCalledExactlyOnceWith(client);
    if (error === "notFound") {
      expect(mocks.notFound).toHaveBeenCalledOnce();
      expect(mocks.redirect).not.toHaveBeenCalled();
    } else {
      expect(mocks.redirect).toHaveBeenCalledExactlyOnceWith("/login");
      expect(mocks.notFound).not.toHaveBeenCalled();
    }
    expectNoProtectedAccess();
  }
});

it.each(operations)("$name propagates account-loading exceptions before protected access", async ({ call }) => {
  const error = new Error("Account unavailable");
  mocks.account.mockRejectedValueOnce(error);
  await expect(call()).rejects.toBe(error);
  expect(mocks.notFound).not.toHaveBeenCalled();
  expect(mocks.redirect).not.toHaveBeenCalled();
  expectNoProtectedAccess();
});

function expectNoProtectedAccess() {
  for (const operation of [mocks.dataSource, mocks.create, mocks.edit, mocks.cancel, mocks.cancelBooking]) {
    expect(operation).not.toHaveBeenCalled();
  }
}
