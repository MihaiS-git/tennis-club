// @vitest-environment jsdom
import { installDialogMock } from "../helpers/dialog";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({ query: "", replace: vi.fn(), push: vi.fn(), refresh: vi.fn(), authorize: vi.fn(), list: vi.fn(),
  options: vi.fn(), lesson: vi.fn(), reservation: vi.fn(), calendar: vi.fn(), form: vi.fn(),
  own: { cancel: vi.fn(), edit: vi.fn(), load: vi.fn() }, admin: { cancel: vi.fn(), edit: vi.fn(), load: vi.fn() },
  notFound: vi.fn(() => { throw new Error("not found"); }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: mocks.replace, push: mocks.push, refresh: mocks.refresh }),
  usePathname: () => "/coach/bookings", useSearchParams: () => new URLSearchParams(mocks.query), notFound: mocks.notFound }));
vi.mock("@/lib/coaching/authorization", () => ({ requireActiveCoach: mocks.authorize }));
vi.mock("@/lib/bookings/coach-bookings", () => ({ listCoachBookings: mocks.list, listCoachBookingFilterOptions: mocks.options,
  getCoachLesson: mocks.lesson, getCoachDirectReservation: mocks.reservation }));
vi.mock("@/app/admin/reservations/reservation-content", () => ({ ReservationContent: (props: object) => { mocks.calendar(props); return <p>Scheduler</p>; } }));
vi.mock("@/app/my-activity/bookings/actions", () => ({ cancelOwnReservationAction: mocks.own.cancel,
  editOwnReservationAction: mocks.own.edit, loadReservationEditDayAction: mocks.own.load }));
vi.mock("@/app/admin/reservations/actions", () => ({ cancelAdminReservationAction: mocks.admin.cancel,
  editAdminReservationAction: mocks.admin.edit, loadAdminReservationEditDayAction: mocks.admin.load }));
vi.mock("@/components/reservation-edit-form", () => ({ ReservationEditForm: (props: {
  inProgress: boolean; loadAvailability: unknown; onSave: (draft: object) => Promise<{ ok: boolean }>; onSaved: () => Promise<void>;
}) => { mocks.form(props); return <button type="button" onClick={async () => {
  const result = await props.onSave({ date: "2099-10-15", selection: null, reason: "New reason", inProgress: true });
  if (result.ok) await props.onSaved();
}}>Save stub</button>; } }));

import CoachBookingsPage from "@/app/coach/bookings/page";
import CoachLessonPage from "@/app/coach/bookings/lessons/[bookingId]/page";
import CoachReservationPage from "@/app/coach/bookings/reservations/[reservationId]/page";
import { BookingsToolbar } from "@/app/admin/bookings/bookings-toolbar";

const coachId = "cc000000-0000-4000-8000-0000000000c1", locationId = "cc000000-0000-4000-8000-000000000001";
const courtId = "cc000000-0000-4000-8000-000000000002";
const lessonId = "cc000000-0000-4000-8000-000000000010", reservationId = "cc000000-0000-4000-8000-000000000020";
const locations = [{ id: locationId, name: "RIVUS", archived: false, courts: [{ id: courtId, name: "Court 1" }] }];
const listed = { created_at: "2099-10-01T08:00:00+00:00", booking_date: "2099-10-15", starts_at_minute: 600, ends_at_minute: 660,
  location_id: locationId, location_name: "RIVUS", location_timezone: "UTC", court_id: courtId, court_name: "Court 1" };
const lessonRow = { ...listed, kind: "booking", id: lessonId, status: "confirmed", includes_coaching: true, coach_name: "Coach A",
  coaching_program_name: "Juniors", customer_name: "Ana Player", customer_email: "ana@example.test" };
const reservationRow = { ...listed, kind: "reservation", id: reservationId, status: "active", reason: "Clinic",
  creator_name: "Coach A", creator_email: "coach@example.test" };
const lesson = { id: lessonId, status: "confirmed", booking_date: "2099-10-15", starts_at_minute: 600, ends_at_minute: 660,
  location_name: "RIVUS", location_timezone: "UTC", court_name: "Court 1", coach_name: "Coach A", coaching_program_name: "Juniors",
  customer_name: "Ana Player", customer_email: "ana@example.test", customer_phone: "+40 700", created_at: "2099-10-01T08:00:00+00:00" };
const reservation = { id: reservationId, court_id: courtId, coach_user_id: null, booking_date: "2099-10-15", starts_at_minute: 600,
  ends_at_minute: 720, reason: "Clinic", created_by_user_id: coachId, status: "active", created_at: "2099-10-01T08:00:00+00:00",
  updated_at: "2099-10-01T08:00:00.123456+00:00", cancelled_at: null, cancelled_by_user_id: null, hold_expires_at: null,
  court_name: "Court 1", court_active: true, location_id: locationId, location_name: "RIVUS", location_timezone: "UTC", location_active: true,
  archived_at: null, creator_name: "Coach A", creator_email: "coach@example.test", creator_phone: null, canceller_name: null };
const withReservation = (flags: object = {}) => mocks.reservation.mockResolvedValue({ reservation,
  startsAt: "2099-10-15T10:00:00.000Z", endsAt: "2099-10-15T12:00:00.000Z", started: false, editable: true, cancellable: true, ...flags });
const openLesson = async (search: Record<string, string> = {}, id = lessonId) => render(await CoachLessonPage({
  params: Promise.resolve({ bookingId: id }), searchParams: Promise.resolve(search) }));
const openReservation = async (search: Record<string, string> = {}, id = reservationId) => render(await CoachReservationPage({
  params: Promise.resolve({ reservationId: id }), searchParams: Promise.resolve(search) }));

beforeAll(() => installDialogMock());
beforeEach(() => {
  vi.clearAllMocks(); mocks.query = "";
  mocks.authorize.mockResolvedValue({ state: "active", userId: coachId, roles: ["coach"] });
  mocks.options.mockResolvedValue(locations);
  mocks.list.mockResolvedValue({ rows: [lessonRow, reservationRow], page: 1, total: 2, totalPages: 1 });
  mocks.lesson.mockResolvedValue(lesson);
  mocks.own.cancel.mockResolvedValue({ ok: true }); mocks.own.edit.mockResolvedValue({ ok: true });
  mocks.own.load.mockResolvedValue({ day: { times: [], courts: [] }, reservation: { updated_at: reservation.updated_at } });
});
afterEach(() => cleanup());

test("the Coach List shows own lessons and reservations with Coach links, tabs and no prices", async () => {
  render(await CoachBookingsPage({ searchParams: Promise.resolve({ type: "all", sort: "scheduled", page: "1" }) }));
  expect(mocks.authorize.mock.invocationCallOrder[0]).toBeLessThan(mocks.list.mock.invocationCallOrder[0]);
  expect(mocks.list.mock.lastCall![0]).toMatchObject({ type: "all", sort: "scheduled", coach: "" });
  const tabs = screen.getByRole("navigation", { name: "Bookings and reservations views" });
  expect(within(tabs).getByRole("link", { name: "Calendar" }).getAttribute("href")).toBe("/coach/bookings?view=calendar");
  expect(within(tabs).getByRole("link", { name: "List" }).getAttribute("aria-current")).toBe("page");
  const table = screen.getByRole("table", { name: "Bookings and reservations" });
  expect(within(table).getAllByRole("columnheader").map((cell) => cell.textContent))
    .toEqual(["Reference", "Type", "Customer or staff", "Location and court", "Scheduled", "Status", "Created"]);
  expect(within(table).getAllByRole("link", { name: "#cc000000" }).map((link) => link.getAttribute("href")))
    .toEqual([`/coach/bookings/lessons/${lessonId}?sort=scheduled`, `/coach/bookings/reservations/${reservationId}?sort=scheduled`]);
  expect(within(table).getByText("Ana Player")).toBeDefined();
  expect(screen.queryByText(/Total|RON|No charge|Guest/)).toBeNull();
});

test("the Coach toolbar offers only lessons and own reservations, without a Coach filter", () => {
  mocks.query = "type=coaching";
  render(<BookingsToolbar locations={locations} scope="coach" />);
  const options = (name: string) => within(screen.getByRole("combobox", { name })).getAllByRole("option").map((option) => option.textContent);
  expect(options("Type")).toEqual(["All", "Coaching", "Staff reservation"]);
  expect(options("Status")).toEqual(["All", "Confirmed", "Cancelled"]);
  expect(screen.queryByRole("combobox", { name: "Coach" })).toBeNull();
  expect(screen.getByRole("searchbox", { name: "Search" }).getAttribute("placeholder")).toBe("ID, customer or reason");
  fireEvent.change(screen.getByRole("combobox", { name: "Type" }), { target: { value: "reservation" } });
  expect(mocks.replace).toHaveBeenLastCalledWith("/coach/bookings?type=reservation", { scroll: false });
});

test("the Coach Calendar tab keeps the existing occupancy calendar under the Coach route", async () => {
  render(await CoachBookingsPage({ searchParams: Promise.resolve({ view: "calendar", location: locationId, date: "2099-10-15" }) }));
  expect(screen.getByText("Scheduler")).toBeDefined();
  expect(mocks.calendar.mock.lastCall![0]).toMatchObject({ href: "/coach/bookings?view=calendar" });
  expect(await mocks.calendar.mock.lastCall![0].searchParams).toEqual({ location: locationId, date: "2099-10-15" });
  expect(mocks.list).not.toHaveBeenCalled();
  expect(screen.getByRole("link", { name: "Calendar" }).getAttribute("aria-current")).toBe("page");
});

test("lesson details show the schedule and customer contact, no financial records or actions, and return to the source", async () => {
  await openLesson({ type: "coaching", page: "2" });
  expect(mocks.authorize.mock.invocationCallOrder[0]).toBeLessThan(mocks.lesson.mock.invocationCallOrder[0]);
  expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Lesson #cc000000");
  for (const value of ["RIVUS", "Court 1", "15 Oct 2099", "10:00–11:00 (UTC)", "60 min", "Juniors", "Coach A", "Ana Player",
    "ana@example.test", "+40 700"]) expect(screen.getByText(value)).toBeDefined();
  expect(screen.queryByText(/Financial|Payment|Refund|Total|RON|Cancel/)).toBeNull();
  expect(screen.queryByRole("button", { name: /Cancel|Edit/ })).toBeNull();
  expect(screen.getByRole("link", { name: "Back to Bookings" }).getAttribute("href")).toBe("/coach/bookings?type=coaching&page=2");
  cleanup();
  await openLesson({ back: `/coach/bookings?view=calendar&location=${locationId}&date=2099-10-15` });
  expect(screen.getByRole("link", { name: "Back to Calendar" }).getAttribute("href"))
    .toBe(`/coach/bookings?view=calendar&location=${locationId}&date=2099-10-15`);
});

test("another Coach's lesson or reservation, and invalid IDs, are not found; authorization comes first", async () => {
  mocks.lesson.mockResolvedValue(null); mocks.reservation.mockResolvedValue(null);
  await expect(openLesson()).rejects.toThrow("not found");
  await expect(openReservation()).rejects.toThrow("not found");
  mocks.lesson.mockClear(); mocks.reservation.mockClear();
  await expect(openLesson({}, "not-a-uuid")).rejects.toThrow("not found");
  await expect(openReservation({}, "not-a-uuid")).rejects.toThrow("not found");
  expect(mocks.lesson).not.toHaveBeenCalled(); expect(mocks.reservation).not.toHaveBeenCalled();
  mocks.authorize.mockRejectedValue(new Error("forbidden"));
  await expect(openLesson()).rejects.toThrow("forbidden");
  await expect(openReservation()).rejects.toThrow("forbidden");
  expect(mocks.lesson).not.toHaveBeenCalled(); expect(mocks.reservation).not.toHaveBeenCalled();
});

test("own reservation details use the existing owner actions, without Admin account links", async () => {
  withReservation();
  await openReservation({ back: `/coach/bookings?view=calendar&location=${locationId}&date=2099-10-15` });
  expect(screen.getByRole("link", { name: "Back to Calendar" })).toBeDefined();
  expect(screen.queryByRole("link", { name: "View user account" })).toBeNull();
  expect(screen.queryByText(/Payment|Refund|Total/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Cancel reservation" }));
  fireEvent.click(within(screen.getByRole("dialog", { name: "Cancel reservation?" })).getByRole("button", { name: "Cancel reservation" }));
  await waitFor(() => expect(mocks.refresh).toHaveBeenCalledOnce());
  expect(mocks.own.cancel).toHaveBeenCalledExactlyOnceWith(reservationId);
  expect(mocks.admin.cancel).not.toHaveBeenCalled();
});

test("an in-progress own reservation keeps owner cancellation and a reason-only edit through the owner action", async () => {
  withReservation({ started: true });
  await openReservation();
  expect(screen.getByRole("button", { name: "Cancel reservation" })).toBeDefined();
  expect(screen.queryByText("This reservation has started and can no longer be cancelled.")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Edit reservation" }));
  const dialog = screen.getByRole("dialog", { name: "Edit reservation" });
  await waitFor(() => expect(within(dialog).getByRole("button", { name: "Save stub" })).toBeDefined());
  expect(mocks.own.load).toHaveBeenCalledWith(reservationId, "2099-10-15");
  expect(mocks.form.mock.lastCall![0]).toMatchObject({ inProgress: true, loadAvailability: mocks.own.load });
  fireEvent.click(within(dialog).getByRole("button", { name: "Save stub" }));
  await waitFor(() => expect(mocks.refresh).toHaveBeenCalledOnce());
  expect(mocks.own.edit).toHaveBeenCalledExactlyOnceWith({ id: reservationId, expectedUpdatedAt: reservation.updated_at,
    kind: "reason", reason: "New reason" });
  expect(mocks.admin.edit).not.toHaveBeenCalled(); expect(mocks.admin.load).not.toHaveBeenCalled();
});

test("ended or cancelled own reservations show their record without actions", async () => {
  withReservation({ editable: false, cancellable: false });
  await openReservation();
  expect(screen.queryByRole("region", { name: "Reservation actions" })).toBeNull();
  expect(screen.getByText("Clinic")).toBeDefined();
});
