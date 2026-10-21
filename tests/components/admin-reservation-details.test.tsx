// @vitest-environment jsdom
import { installDialogMock } from "../helpers/dialog";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({ authorize: vi.fn(), details: vi.fn(), refresh: vi.fn(), cancel: vi.fn(), edit: vi.fn(), load: vi.fn(),
  form: vi.fn(), notFound: vi.fn(() => { throw new Error("not found"); }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh, push: vi.fn() }), notFound: mocks.notFound }));
vi.mock("@/lib/admin/authorization", () => ({ requireActiveAdmin: mocks.authorize }));
vi.mock("@/lib/reservations/service", () => ({ getAdminDirectReservation: mocks.details }));
vi.mock("@/app/admin/reservations/actions", () => ({ cancelAdminReservationAction: mocks.cancel,
  editAdminReservationAction: mocks.edit, loadAdminReservationEditDayAction: mocks.load }));
// The existing reservation form owns availability, selection and reason validation.
vi.mock("@/components/reservation-edit-form", () => ({ ReservationEditForm: (props: {
  inProgress: boolean; loadAvailability: unknown; onSave: (draft: object) => Promise<{ ok: boolean }>; onSaved: () => Promise<void>;
}) => { mocks.form(props); return <button type="button" onClick={async () => {
  const result = await props.onSave({ date: "2099-10-16", selection: { courtId, startMinute: 660, endMinute: 780 }, reason: "Coaching clinic", inProgress: props.inProgress });
  if (result.ok) await props.onSaved();
}}>Save stub</button>; } }));

import AdminReservationPage from "@/app/admin/bookings/reservations/[reservationId]/page";

const reservationId = "ad000000-0000-4000-8000-0000000000c1", courtId = "ad000000-0000-4000-8000-0000000000c2";
const creatorId = "ad000000-0000-4000-8000-0000000000c3";
const reservation = { id: reservationId, court_id: courtId, coach_user_id: null, booking_date: "2099-10-15", starts_at_minute: 600,
  ends_at_minute: 720, reason: "Court maintenance", created_by_user_id: creatorId, status: "active",
  created_at: "2099-10-01T08:00:00+00:00", updated_at: "2099-10-01T08:00:00.123456+00:00", cancelled_at: null,
  cancelled_by_user_id: null, hold_expires_at: null, court_name: "Court 2", court_active: true, location_id: "ad000000-0000-4000-8000-0000000000c4",
  location_name: "RIVUS", location_timezone: "UTC", location_active: true, archived_at: null,
  creator_name: "Staff Member", creator_email: "staff@example.test", creator_phone: "+40 700", canceller_name: null };
const details = (overrides: object = {}, flags: object = {}) => mocks.details.mockResolvedValue({ reservation: { ...reservation, ...overrides },
  startsAt: "2099-10-15T10:00:00.000Z", endsAt: "2099-10-15T12:00:00.000Z", started: false, editable: true, cancellable: true, ...flags });
const open = async (search: Record<string, string> = {}) => render(await AdminReservationPage({
  params: Promise.resolve({ reservationId }), searchParams: Promise.resolve(search) }));

beforeAll(() => installDialogMock());
beforeEach(() => {
  vi.clearAllMocks(); mocks.authorize.mockResolvedValue({ state: "active", userId: creatorId, roles: ["admin"] });
  mocks.cancel.mockResolvedValue({ ok: true }); mocks.edit.mockResolvedValue({ ok: true, reservation: {} });
  mocks.load.mockResolvedValue({ day: { times: [], courts: [] }, reservation: { updated_at: reservation.updated_at } });
});
afterEach(() => cleanup());

test("shows location, court, date, time, duration, creator, reason and status, with List return navigation", async () => {
  details();
  await open({ type: "reservation", status: "active", page: "2" });
  expect(mocks.authorize.mock.invocationCallOrder[0]).toBeLessThan(mocks.details.mock.invocationCallOrder[0]);
  expect(mocks.details).toHaveBeenCalledWith(reservationId);
  expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Reservation #ad000000");
  for (const value of ["RIVUS", "Court 2", "15 Oct 2099", "10:00–12:00 (UTC)", "120 min", "Staff Member", "staff@example.test",
    "+40 700", "Court maintenance", "Staff reservation"]) expect(screen.getByText(value)).toBeDefined();
  expect(screen.getAllByText("Active").length).toBeGreaterThan(1);
  // Free operational records: no customer, payment or refund records are shown.
  expect(screen.queryByText(/Financial|Payment|Refund|Total/)).toBeNull();
  expect(screen.getByRole("link", { name: "Back to Bookings" }).getAttribute("href")).toBe("/admin/bookings?type=reservation&status=active&page=2");
  expect(screen.getByRole("link", { name: "View user account" }).getAttribute("href")).toBe(`/admin/users/${creatorId}`);
});

test("returns to the same Calendar day when opened from the Calendar", async () => {
  details();
  await open({ back: "/admin/bookings?view=calendar&location=ad000000-0000-4000-8000-0000000000c4&date=2099-10-15" });
  expect(screen.getByRole("link", { name: "Back to Calendar" }).getAttribute("href"))
    .toBe("/admin/bookings?view=calendar&location=ad000000-0000-4000-8000-0000000000c4&date=2099-10-15");
});

test("Cancel uses the existing Admin reservation action after confirmation, then refreshes the details", async () => {
  details();
  await open();
  fireEvent.click(within(screen.getByRole("region", { name: "Reservation actions" })).getByRole("button", { name: "Cancel reservation" }));
  const confirm = screen.getByRole("dialog", { name: "Cancel reservation?" });
  expect(confirm.textContent).toContain("Staff Member");
  fireEvent.click(within(confirm).getByRole("button", { name: "Cancel reservation" }));
  await waitFor(() => expect(mocks.refresh).toHaveBeenCalledOnce());
  expect(mocks.cancel).toHaveBeenCalledExactlyOnceWith(reservationId);
});

test("Edit loads the current token and saves through the existing Admin reservation action", async () => {
  details();
  await open();
  fireEvent.click(screen.getByRole("button", { name: "Edit reservation" }));
  const dialog = screen.getByRole("dialog", { name: "Edit reservation" });
  await waitFor(() => expect(within(dialog).getByRole("button", { name: "Save stub" })).toBeDefined());
  expect(mocks.load).toHaveBeenCalledWith(reservationId, "2099-10-15");
  expect(mocks.form.mock.lastCall![0]).toMatchObject({ inProgress: false, loadAvailability: mocks.load });
  fireEvent.click(within(dialog).getByRole("button", { name: "Save stub" }));
  await waitFor(() => expect(mocks.refresh).toHaveBeenCalledOnce());
  expect(mocks.edit).toHaveBeenCalledExactlyOnceWith({ id: reservationId, expectedUpdatedAt: reservation.updated_at, kind: "schedule",
    schedule: { courtId, date: "2099-10-16", startMinute: 660, endMinute: 780, reason: "Coaching clinic" } });
  expect(screen.queryByRole("dialog", { name: "Edit reservation" })).toBeNull();
});

test("a started reservation offers only a reason edit and no cancellation", async () => {
  details({}, { started: true, cancellable: false });
  await open();
  expect(screen.queryByRole("button", { name: "Cancel reservation" })).toBeNull();
  expect(screen.getByRole("status").textContent).toBe("This reservation has started and can no longer be cancelled.");
  fireEvent.click(screen.getByRole("button", { name: "Edit reservation" }));
  await waitFor(() => expect(mocks.form).toHaveBeenCalled());
  expect(mocks.form.mock.lastCall![0].inProgress).toBe(true);
});

test("cancelled and unmanageable reservations show their record without actions", async () => {
  details({ status: "cancelled", cancelled_at: "2099-10-02T09:00:00+00:00", cancelled_by_user_id: creatorId, canceller_name: "Admin User" },
    { editable: false, cancellable: false });
  await open();
  expect(screen.getAllByText("Cancelled").length).toBeGreaterThan(1);
  expect(screen.getByText("2 Oct 2099, 09:00 by Admin User")).toBeDefined();
  expect(screen.queryByRole("region", { name: "Reservation actions" })).toBeNull();
  expect(screen.queryByRole("button", { name: /Edit reservation|Cancel reservation/ })).toBeNull();
});

test("unknown, invalid and non-staff reservation IDs are not found; authorization comes first", async () => {
  mocks.details.mockResolvedValue(null);
  await expect(open()).rejects.toThrow("not found");
  mocks.details.mockClear();
  await expect(AdminReservationPage({ params: Promise.resolve({ reservationId: "not-a-uuid" }), searchParams: Promise.resolve({}) }))
    .rejects.toThrow("not found");
  expect(mocks.details).not.toHaveBeenCalled();
  mocks.authorize.mockRejectedValueOnce(new Error("forbidden"));
  await expect(open()).rejects.toThrow("forbidden");
  expect(mocks.details).not.toHaveBeenCalled();
});
