import { beforeEach, expect, it, vi } from "vitest";

const services = vi.hoisted(() => ({
  create: vi.fn(), ownerEdit: vi.fn(), ownerCancel: vi.fn(),
  adminEdit: vi.fn(), adminCancel: vi.fn(), adminBookingCancel: vi.fn(),
  revalidate: vi.fn(),
}));
vi.mock("next/cache", () => ({ revalidatePath: services.revalidate }));
vi.mock("@/lib/reservations/service", () => ({
  createDirectReservation: services.create,
  editDirectReservationAsAdmin: services.adminEdit,
  cancelDirectReservationAsAdmin: services.adminCancel,
  cancelCustomerBookingAsAdmin: services.adminBookingCancel,
}));
vi.mock("@/lib/reservations/personal-service", () => ({
  editOwnDirectReservation: services.ownerEdit,
  cancelOwnDirectReservation: services.ownerCancel,
}));

import { cancelAdminCustomerBookingAction, cancelAdminReservationAction, editAdminReservationAction,
  reserveCourtAction } from "@/app/reservations/actions";
import { cancelOwnReservationAction, editOwnReservationAction } from "@/app/my-activity/bookings/actions";

const upcomingPaths = [["/book"], ["/reservations"], ["/my-activity/bookings"]];
const cancelledPaths = [...upcomingPaths, ["/my-activity/bookings/history"]];
const mutations = [
  { name: "direct reservation create", action: reserveCourtAction, service: services.create, paths: upcomingPaths },
  { name: "owner edit", action: editOwnReservationAction, service: services.ownerEdit, paths: upcomingPaths },
  { name: "owner cancel", action: cancelOwnReservationAction, service: services.ownerCancel, paths: cancelledPaths },
  { name: "Admin edit of another owner's reservation", action: editAdminReservationAction, service: services.adminEdit, paths: upcomingPaths },
  { name: "Admin cancel of another owner's reservation", action: cancelAdminReservationAction, service: services.adminCancel, paths: cancelledPaths },
  { name: "Admin cancel of another owner's customer booking", action: cancelAdminCustomerBookingAction,
    service: services.adminBookingCancel, paths: cancelledPaths },
];

beforeEach(() => vi.resetAllMocks());

it.each(mutations)("$name invalidates exactly the affected reads after success and preserves the result", async ({ action, service, paths }) => {
  const input = { id: "owned-by-another-user", reason: "Unchanged intent" };
  const result = { ok: true, reservation: { reason: "Saved reason" } };
  let finish!: (value: unknown) => void;
  service.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
  const pending = action(input);
  expect(service).toHaveBeenCalledExactlyOnceWith(input);
  expect(services.revalidate).not.toHaveBeenCalled();
  finish(result);
  expect(await pending).toBe(result);
  expect(services.revalidate.mock.calls).toEqual(paths);
});

it.each(mutations)("$name preserves failures without success invalidation", async ({ action, service }) => {
  const failure = { ok: false, message: "No longer available.", stale: true, fieldErrors: { reason: "Required" } };
  service.mockResolvedValue(failure);
  expect(await action("id")).toBe(failure);
  expect(services.revalidate).not.toHaveBeenCalled();
});

it.each(mutations)("$name does not invalidate when the service throws", async ({ action, service }) => {
  const error = new Error("Service failed");
  service.mockRejectedValue(error);
  await expect(action("id")).rejects.toBe(error);
  expect(services.revalidate).not.toHaveBeenCalled();
});
