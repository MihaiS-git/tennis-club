import { beforeEach, expect, it, vi } from "vitest";

const services = vi.hoisted(() => ({
  create: vi.fn(), ownerEdit: vi.fn(), ownerCancel: vi.fn(),
  adminEdit: vi.fn(), adminCancel: vi.fn(), adminBookingCancel: vi.fn(), adminBookingReschedule: vi.fn(), ownerBookingReschedule: vi.fn(),
  revalidate: vi.fn(),
}));
vi.mock("next/cache", () => ({ revalidatePath: services.revalidate }));
vi.mock("@/lib/reservations/service", () => ({
  createDirectReservation: services.create,
  editDirectReservationAsAdmin: services.adminEdit,
  cancelDirectReservationAsAdmin: services.adminCancel,
  cancelCustomerBookingAsAdmin: services.adminBookingCancel,
}));
vi.mock("@/lib/bookings/self-reschedule", () => ({ rescheduleOwnCustomerBooking: services.ownerBookingReschedule }));
vi.mock("@/lib/reservations/personal-service", () => ({
  editOwnDirectReservation: services.ownerEdit,
  cancelOwnDirectReservation: services.ownerCancel,
}));

import { cancelAdminCustomerBookingAction, cancelAdminReservationAction, editAdminReservationAction,
  reserveCourtAction } from "@/app/admin/reservations/actions";
import { cancelOwnReservationAction, editOwnReservationAction } from "@/app/my-activity/bookings/actions";

const upcomingPaths = [["/book"], ["/admin/reservations"], ["/my-activity/bookings"]];
const cancelledPaths = [...upcomingPaths, ["/my-activity/history"]];
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

it("owner cancellation rejection leaves all calendar caches unchanged", async () => {
  const failure = { ok: false, message: "This reservation is no longer available to cancel." };
  services.ownerCancel.mockResolvedValue(failure);
  expect(await cancelOwnReservationAction("stale-reservation")).toBe(failure);
  expect(services.ownerCancel).toHaveBeenCalledExactlyOnceWith("stale-reservation");
  expect(services.revalidate).not.toHaveBeenCalled();
});
