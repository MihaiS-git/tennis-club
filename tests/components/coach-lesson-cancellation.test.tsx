// @vitest-environment jsdom
import { lastToast } from "../helpers/notifications";
import { installDialogMock } from "../helpers/dialog";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({ authorize: vi.fn(), lesson: vi.fn(), cancel: vi.fn(), refresh: vi.fn(), push: vi.fn(),
  notFound: vi.fn(() => { throw new Error("not found"); }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh, push: mocks.push }), notFound: mocks.notFound }));
vi.mock("@/lib/coaching/authorization", () => ({ requireActiveCoach: mocks.authorize }));
vi.mock("@/lib/bookings/coach-bookings", () => ({ getCoachLesson: mocks.lesson }));
vi.mock("@/app/coach/bookings/lessons/[bookingId]/actions", () => ({ cancelCoachLessonAction: mocks.cancel,
  loadCoachBookingDayAction: vi.fn(), loadCoachBookingEditorAction: vi.fn(), changeCoachBookingAction: vi.fn() }));

import CoachLessonPage from "@/app/coach/bookings/lessons/[bookingId]/page";

const lessonId = "c0000000-0000-4000-8000-000000000001";
const lesson = (cancellation: object = {}, overrides: object = {}) => mocks.lesson.mockResolvedValue({ id: lessonId, status: "confirmed",
  booking_date: "2099-10-15", starts_at_minute: 600, ends_at_minute: 660, location_name: "RIVUS", location_timezone: "UTC",
  court_name: "Court 2", coach_name: "Me Coach", coaching_program_name: "Semi-private", customer_name: "Ana Pop",
  customer_email: "ana@example.test", customer_phone: "+40 700", created_at: "2099-01-01T09:30:00+00:00",
  cancellation: { availability: "eligible", startsAt: "2099-10-15T10:00:00.000Z", refundAvailable: true, ...cancellation }, ...overrides });
const open = async () => render(await CoachLessonPage({ params: Promise.resolve({ bookingId: lessonId }), searchParams: Promise.resolve({}) }));
const confirm = () => {
  fireEvent.click(within(screen.getByRole("region", { name: "Lesson actions" })).getByRole("button", { name: "Cancel lesson" }));
  return screen.getByRole("dialog", { name: "Cancel lesson?" });
};

beforeAll(() => installDialogMock());
beforeEach(() => { vi.clearAllMocks(); mocks.authorize.mockResolvedValue({ userId: "coach", roles: ["coach"] }); });
afterEach(() => cleanup());

test("the assigned Coach confirms before cancelling once, sees the provider-confirmed outcome and refreshes", async () => {
  lesson();
  mocks.cancel.mockResolvedValue({ ok: true, outcome: "cancelled", refundStatus: "succeeded" });
  await open();
  const confirmation = confirm();
  for (const value of ["Ana Pop", "Semi-private lesson", "RIVUS · Court 2", "15 Oct 2099 · 10:00–11:00",
    "This will cancel the lesson, free the court and notify the customer.", "The customer's online payment will be refunded automatically."])
    expect(confirmation.textContent).toContain(value);
  // No price reaches the Coach.
  expect(confirmation.textContent).not.toMatch(/RON|\d+\.\d{2}/);
  expect(mocks.cancel).not.toHaveBeenCalled();
  fireEvent.click(within(confirmation).getByRole("button", { name: "Confirm cancellation" }));
  fireEvent.click(within(confirmation).getByRole("button", { name: "Cancelling lesson…" }));
  await waitFor(() => expect(mocks.refresh).toHaveBeenCalledOnce());
  expect(mocks.cancel).toHaveBeenCalledExactlyOnceWith({ id: lessonId });
  expect(lastToast("success")).toBe("Lesson cancelled. The customer's payment has been refunded.");
});

test.each([
  [{ ok: true, outcome: "cancellation_pending" }, "success", "Cancellation requested. The booking stays confirmed until the refund is confirmed."],
  [{ ok: true, outcome: "cancelled", refundStatus: "pending" }, "success", "Lesson cancelled. The customer's refund has been requested."],
  [{ ok: false, message: "This lesson is no longer available to cancel." }, "error", "This lesson is no longer available to cancel."],
])("a %j outcome is reported without claiming an unconfirmed refund", async (result, kind, message) => {
  lesson();
  mocks.cancel.mockResolvedValue(result);
  await open();
  fireEvent.click(within(confirm()).getByRole("button", { name: "Confirm cancellation" }));
  await waitFor(() => expect(lastToast(kind as "success" | "error")).toBe(message));
  expect(lastToast(kind as "success" | "error")).not.toMatch(/has been refunded/);
  if (!result.ok) expect(mocks.refresh).not.toHaveBeenCalled();
});

test("a failed request keeps the confirmation open with a retryable error", async () => {
  lesson();
  mocks.cancel.mockRejectedValue(new Error("network"));
  await open();
  const confirmation = confirm();
  fireEvent.click(within(confirmation).getByRole("button", { name: "Confirm cancellation" }));
  await waitFor(() => expect(lastToast("error")).toBe("Unable to cancel this lesson. Try again."));
  expect(screen.getByRole("dialog", { name: "Cancel lesson?" })).toBeTruthy();
});

test.each([
  ["started", "This lesson has started and can no longer be rescheduled or cancelled."],
  ["cancellation_pending", "Cancellation requested. The lesson stays confirmed until the customer's refund is confirmed."],
  ["change_pending", "A change to this lesson is still being processed. Rescheduling and cancellation are available once it finishes."],
])("a %s lesson offers no Cancel or Reschedule lesson action", async (availability, message) => {
  lesson({ availability });
  await open();
  expect(screen.queryByRole("button", { name: "Cancel lesson" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Reschedule lesson" })).toBeNull();
  expect(screen.getByRole("status").textContent).toBe(message);
});

test("a cancelled lesson keeps its details without any action", async () => {
  lesson({ availability: "unavailable" }, { status: "cancelled" });
  await open();
  expect(screen.queryByRole("region", { name: "Lesson actions" })).toBeNull();
  for (const text of ["Ana Pop", "ana@example.test", "+40 700", "Semi-private"]) expect(screen.getAllByText(text).length).toBeGreaterThan(0);
});

test("the assigned Coach enters Calendar rescheduling from Lesson details", async () => {
  lesson();
  await open();
  const actions = within(screen.getByRole("region", { name: "Lesson actions" }));
  fireEvent.click(actions.getByRole("button", { name: "Reschedule lesson" }));
  expect(mocks.push).toHaveBeenCalledExactlyOnceWith(`/coach/bookings?view=calendar&reschedule=${lessonId}`);
  expect(mocks.refresh).not.toHaveBeenCalled();
  expect(screen.queryByRole("dialog", { name: "Reschedule lesson" })).toBeNull();
  expect(mocks.cancel).not.toHaveBeenCalled();
});

test("an open Lesson details page stops offering Reschedule lesson once the lesson starts", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  try {
    vi.setSystemTime(new Date("2099-10-15T09:59:00.000Z"));
    lesson();
    await open();
    expect(screen.getByRole("button", { name: "Reschedule lesson" })).toBeTruthy();
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(screen.queryByRole("button", { name: "Reschedule lesson" })).toBeNull();
  } finally { vi.useRealTimers(); }
});

test("Keep booking and Escape dismiss without cancelling, and confirmation names the Coach", async () => {
  lesson();
  await open();
  let confirmation = confirm();
  expect(confirmation.textContent).toContain("Coach: Me Coach");
  const keep = within(confirmation).getByRole("button", { name: "Keep booking" });
  expect(document.activeElement).toBe(keep);
  fireEvent.click(keep);
  expect(mocks.cancel).not.toHaveBeenCalled();
  confirmation = confirm();
  fireEvent(confirmation, new Event("cancel", { cancelable: true }));
  (confirmation as HTMLDialogElement).close();
  expect(mocks.cancel).not.toHaveBeenCalled();
});

test("a refresh failure preserves the authoritative lesson cancellation outcome", async () => {
  lesson();
  mocks.cancel.mockResolvedValue({ ok: true, outcome: "cancelled", refundStatus: "succeeded" });
  mocks.refresh.mockImplementationOnce(() => { throw new Error("refresh failed"); });
  await open();
  fireEvent.click(within(confirm()).getByRole("button", { name: "Confirm cancellation" }));
  await waitFor(() => expect(lastToast("warning")).toBe("Lesson cancelled. The customer's payment has been refunded."));
  expect(mocks.cancel).toHaveBeenCalledOnce();
});
