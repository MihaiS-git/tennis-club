// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { expectToast } from "../helpers/notifications";
import { installDialogMock } from "../helpers/dialog";
import { parseAdminNotificationQuery } from "@/lib/notifications/admin-notification-query";

const { list, remove, replace, refresh, loadBooking } = vi.hoisted(() => ({ list: vi.fn(), remove: vi.fn(), replace: vi.fn(), refresh: vi.fn(), loadBooking: vi.fn() }));
vi.mock("@/lib/notifications/admin-notifications", () => ({ listAdminUndeliveredNotifications: list }));
vi.mock("@/app/admin/payments/notification-retry-button", () => ({ NotificationRetryButton: () => <button type="button">Retry now</button> }));
vi.mock("@/app/admin/payments/actions", () => ({ deleteNotificationsAction: remove, loadAdminBookingDetailsAction: loadBooking }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace, refresh }) }));

import AdminNotificationsPage from "@/app/admin/payments/notifications/page";
import { NotificationsTable } from "@/app/admin/payments/notifications-table";
import { NotificationsToolbar } from "@/app/admin/payments/notifications-toolbar";

const id = (n: number) => `0a000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const booking = "b0000000-0000-4000-8000-000000000001";
const base = { account_user_id: null, recipient: "ana@example.test", subject: "Booking confirmed", important: false, booking_id: booking, last_error: "unavailable",
  attempts: 8, created_at: "2026-07-15T09:00:00.000Z", next_attempt_at: null };
const stopped = (n: number) => ({ ...base, id: id(n), state: "stopped" as const, deletable: true, recipient: `user${n}@example.test` });
const retrying = { ...base, id: id(10), state: "retrying" as const, deletable: false, attempts: 2, next_attempt_at: "2026-12-15T09:00:00.000Z" };
const financial = { ...base, id: id(11), state: "stopped" as const, deletable: false, important: true, subject: "Refund requires attention" };
const query = parseAdminNotificationQuery({});
const page = (rows: unknown[], params = {}) => ({ rows, total: rows.length, unacknowledgedExceptions: 0, page: 1, totalPages: 1,
  query: parseAdminNotificationQuery(params) });

test("links only authoritative customer accounts and leaves guests and missing bookings unlinked", () => {
  render(<NotificationsTable rows={[{ ...stopped(1), account_user_id: id(50) }, stopped(2), { ...stopped(3), booking_id: null }]} query={query} />);
  expect(screen.getByRole("link", { name: "user1@example.test" }).getAttribute("href")).toBe(`/admin/users/${id(50)}`);
  expect(screen.queryByRole("link", { name: "user2@example.test" })).toBeNull();
  expect(screen.queryByRole("link", { name: "user3@example.test" })).toBeNull();
  expect(screen.getAllByRole("button", { name: `Booking ${booking}` })).toHaveLength(2);
});

test.each(["confirmed", "cancelled"])("opens %s historical booking details with the full UUID and preserves filters and selection", async (status) => {
  loadBooking.mockResolvedValue({ id: booking, status, booking_date: "2025-01-01", starts_at_minute: 600, ends_at_minute: 660,
    location_name: "Historical club", location_timezone: "Europe/Bucharest", court_name: "Court 1",
    customer_name: "Guest customer", customer_email: "guest@example.test", customer_phone: "123456789",
    cancellation_notice_minutes: 1440, total_amount_minor: 5000, currency: "RON", payment_method: "online", account_user_id: null });
  render(<NotificationsTable rows={[stopped(1)]} query={parseAdminNotificationQuery({ q: "guest", status: "stopped", page: "3" })} />);
  fireEvent.click(screen.getByRole("checkbox", { name: "Select all deletable notifications on this page" }));
  const trigger = screen.getByRole("button", { name: `Booking ${booking}` });
  fireEvent.click(trigger);
  expect(loadBooking).toHaveBeenCalledExactlyOnceWith(booking);
  const dialog = await screen.findByRole("dialog", { name: "Booking details" });
  await within(dialog).findByText("Guest customer");
  expect(within(dialog).getByText(status === "cancelled" ? "Cancelled" : "Confirmed")).toBeTruthy();
  expect(within(dialog).getByText("guest@example.test")).toBeTruthy();
  expect(within(dialog).getByText("Historical club")).toBeTruthy();
  fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(trigger);
  expect(screen.getByText("1 selected")).toBeTruthy();
  expect(screen.getByRole("link", { name: "Created" }).getAttribute("href")).toContain("q=guest&status=stopped");
  expect(replace).not.toHaveBeenCalled(); expect(refresh).not.toHaveBeenCalled();
});

test("handles missing bookings and load failures with a retryable dialog", async () => {
  loadBooking.mockResolvedValueOnce(null).mockRejectedValueOnce(new Error("unavailable"));
  render(<NotificationsTable rows={[stopped(1)]} query={query} />);
  fireEvent.click(screen.getByRole("button", { name: `Booking ${booking}` }));
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "This booking is no longer available.");
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("Unable to load booking details. Try again."));
  fireEvent.click(screen.getByRole("button", { name: "Close dialog" }));
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("closing while loading ignores a late response and allows reopening", async () => {
  let finish: (value: null) => void = () => {};
  loadBooking.mockReturnValueOnce(new Promise<null>((resolve) => { finish = resolve; })).mockResolvedValueOnce(null);
  render(<NotificationsTable rows={[stopped(1)]} query={query} />);
  const trigger = screen.getByRole("button", { name: `Booking ${booking}` });
  fireEvent.click(trigger);
  expect(screen.getByRole("status").textContent).toBe("Loading booking details…");
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  await act(async () => { finish(null); });
  expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent.click(trigger);
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "This booking is no longer available.");
  expect(loadBooking).toHaveBeenCalledTimes(2);
});

beforeEach(() => { installDialogMock(); loadBooking.mockReset(); remove.mockReset(); replace.mockReset(); refresh.mockReset(); });
afterEach(() => { cleanup(); list.mockReset(); vi.useRealTimers(); });

test("shows notification times in Europe/Bucharest across daylight-saving changes", async () => {
  list.mockResolvedValue(page([{ ...retrying, created_at: "2026-07-15T09:00:00.000Z", next_attempt_at: "2026-12-15T09:00:00.000Z" }]));
  render(await AdminNotificationsPage({ searchParams: Promise.resolve({}) }));
  const [created, nextRetry] = screen.getAllByRole("cell").filter((cell) => cell.querySelector("time"));
  expect(created.textContent).toBe("15 Jul 2026, 12:00:00");
  expect(nextRetry.textContent).toBe("15 Dec 2026, 11:00:00");
  expect(created.querySelector("time")?.getAttribute("dateTime")).toBe("2026-07-15T09:00:00.000Z");
  expect(screen.getByText(/Times in Europe\/Bucharest\./)).toBeTruthy();
});

test("passes URL parameters to the server list and distinguishes empty results", async () => {
  list.mockResolvedValue(page([]));
  render(await AdminNotificationsPage({ searchParams: Promise.resolve({}) }));
  expect(screen.getByText("All booking emails have been accepted by Brevo.")).toBeTruthy();
  cleanup();
  list.mockResolvedValue(page([], { q: "ana", status: "stopped" }));
  const params = { q: "ana", status: "stopped", page: "2" };
  render(await AdminNotificationsPage({ searchParams: Promise.resolve(params) }));
  expect(list).toHaveBeenLastCalledWith(params);
  expect(screen.getByText("No notifications match these filters.")).toBeTruthy();
  expect(screen.getByRole("link", { name: "Clear filters" }).getAttribute("href")).toBe("/admin/payments/notifications");
});

test("distinguishes scheduled retries from manual intervention and keeps the full booking ID accessible", () => {
  render(<NotificationsTable rows={[stopped(1), retrying, financial]} query={query} />);
  const [, first, second, third] = screen.getAllByRole("row");
  expect(within(first).getByText("Needs manual retry")).toBeTruthy();
  expect(within(first).getByText("Stopped").textContent).toBe("Stopped: manual retry required");
  expect(within(second).getByText("Retry scheduled")).toBeTruthy();
  expect(within(second).getByText("15 Dec 2026, 11:00:00")).toBeTruthy();
  expect(within(third).getByText("Financial exception")).toBeTruthy();
  expect(within(first).getByText(`Booking ${booking}`)).toBeTruthy();
  expect(within(first).getByTitle(booking).textContent).toContain("#b0000000");
  // Only eligible rows offer selection and deletion; Retry stays on every row.
  expect(within(first).getByRole("checkbox")).toHaveProperty("disabled", false);
  for (const row of [second, third]) {
    expect(within(row).getByRole("checkbox")).toHaveProperty("disabled", true);
    expect(within(row).queryByRole("button", { name: /^Delete/ })).toBeNull();
    expect(within(row).getByRole("button", { name: "Retry now" })).toBeTruthy();
  }
});

test("selects deletable rows on the current page with an indeterminate header and a contextual toolbar", () => {
  render(<NotificationsTable rows={[stopped(1), stopped(2), retrying]} query={query} />);
  const all = screen.getByRole("checkbox", { name: "Select all deletable notifications on this page" }) as HTMLInputElement;
  expect(screen.queryByRole("toolbar", { name: "Selected notifications" })).toBeNull();
  fireEvent.click(screen.getByRole("checkbox", { name: "Select “Booking confirmed” to user1@example.test" }));
  expect(within(screen.getByRole("toolbar")).getByText("1 selected")).toBeTruthy();
  expect(all.indeterminate).toBe(true);
  expect(all.checked).toBe(false);
  fireEvent.click(all);
  expect(within(screen.getByRole("toolbar")).getByText("2 selected")).toBeTruthy();
  expect(all.indeterminate).toBe(false);
  expect(all.checked).toBe(true);
  fireEvent.click(all);
  expect(screen.queryByRole("toolbar")).toBeNull();
  fireEvent.click(all);
  fireEvent.click(within(screen.getByRole("toolbar")).getByRole("button", { name: "Clear selection" }));
  expect(screen.queryByRole("toolbar")).toBeNull();
});

test("bulk deletion confirms the count, reports records not deleted and clears the selection", async () => {
  remove.mockResolvedValue({ ok: true, deleted: [id(1)], skipped: 1 });
  render(<NotificationsTable rows={[stopped(1), stopped(2)]} query={query} />);
  fireEvent.click(screen.getByRole("checkbox", { name: "Select all deletable notifications on this page" }));
  fireEvent.click(screen.getByRole("button", { name: "Delete selected" }));
  const dialog = screen.getByRole("dialog", { name: "Delete 2 notifications?" });
  expect(dialog.textContent).toContain("Booking, payment and refund records are not changed.");
  await act(async () => { fireEvent.click(within(dialog).getByRole("button", { name: "Delete" })); });
  expect(remove).toHaveBeenCalledExactlyOnceWith({ ids: [id(1), id(2)] });
  await expectToast("Notification deleted.", "success");
  await expectToast(/1 notification was not deleted/, "warning");
  expect(refresh).toHaveBeenCalled();
  await waitFor(() => expect(screen.queryByRole("toolbar")).toBeNull());
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("individual deletion names the notification and reports server errors", async () => {
  remove.mockResolvedValue({ ok: false, message: "Unable to delete notifications. Try again." });
  render(<NotificationsTable rows={[stopped(1)]} query={query} />);
  fireEvent.click(screen.getByRole("button", { name: "Delete “Booking confirmed” to user1@example.test" }));
  const dialog = screen.getByRole("dialog", { name: "Delete notification?" });
  expect(dialog.textContent).toContain("“Booking confirmed” to user1@example.test, created 15 Jul 2026, 12:00:00.");
  await act(async () => { fireEvent.click(within(dialog).getByRole("button", { name: "Delete" })); });
  expect(remove).toHaveBeenCalledExactlyOnceWith({ ids: [id(1)] });
  await expectToast("Unable to delete notifications. Try again.");
});

test("a new query remounts the table, clearing the selection; rows that became ineligible drop out", () => {
  const { rerender } = render(<NotificationsTable key="a" rows={[stopped(1), stopped(2)]} query={query} />);
  fireEvent.click(screen.getByRole("checkbox", { name: "Select all deletable notifications on this page" }));
  expect(screen.getByText("2 selected")).toBeTruthy();
  rerender(<NotificationsTable key="a" rows={[stopped(1), { ...stopped(2), state: "sending", deletable: false }]} query={query} />);
  expect(screen.getByText("1 selected")).toBeTruthy();
  rerender(<NotificationsTable key="b" rows={[stopped(1), stopped(2)]} query={{ ...query, page: 2 }} />);
  expect(screen.queryByRole("toolbar")).toBeNull();
});

test("sortable headers toggle direction in the URL and reset to the first page", () => {
  render(<NotificationsTable rows={[stopped(1)]} query={{ ...query, page: 3 }} />);
  expect(screen.getByRole("link", { name: "Created" }).closest("th")?.getAttribute("aria-sort")).toBe("descending");
  expect(screen.getByRole("link", { name: "Created" }).getAttribute("href")).toBe("/admin/payments/notifications?sort=created&dir=asc");
  expect(screen.getByRole("link", { name: "Attempts" }).getAttribute("href")).toBe("/admin/payments/notifications?sort=attempts&dir=desc");
  expect(screen.getByRole("link", { name: "Next retry" }).getAttribute("href")).toBe("/admin/payments/notifications?sort=next_retry&dir=asc");
});

test("search waits for typing to pause; filters combine and return to page 1", () => {
  vi.useFakeTimers();
  render(<NotificationsToolbar query={parseAdminNotificationQuery({ status: "stopped", page: "3", sort: "attempts", dir: "asc" })} />);
  const search = screen.getByRole("searchbox", { name: "Search" });
  for (const value of ["a", "an", "ana"]) fireEvent.change(search, { target: { value } });
  expect(replace).not.toHaveBeenCalled();
  act(() => { vi.advanceTimersByTime(350); });
  expect(replace).toHaveBeenCalledExactlyOnceWith("/admin/payments/notifications?q=ana&status=stopped&sort=attempts&dir=asc", { scroll: false });
  fireEvent.change(screen.getByRole("combobox", { name: "Type" }), { target: { value: "customer_cancelled" } });
  fireEvent.change(screen.getByLabelText("Created from"), { target: { value: "2026-10-01" } });
  expect(replace).toHaveBeenLastCalledWith(
    "/admin/payments/notifications?q=ana&status=stopped&type=customer_cancelled&from=2026-10-01&sort=attempts&dir=asc", { scroll: false });
  expect(screen.getByRole("combobox", { name: "Type" }).textContent).toContain("Booking cancelled");
});
