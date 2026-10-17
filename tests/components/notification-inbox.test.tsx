// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { installDialogMock } from "../helpers/dialog";
import { parseInboxQuery } from "@/lib/notifications/inbox-query";
const { manage, refresh, replace } = vi.hoisted(() => ({ manage: vi.fn(), refresh: vi.fn(), replace: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh, replace }) }));
vi.mock("@/app/my-activity/actions", () => ({ manageNotificationsAction: manage, acknowledgeFinancialNoticeAction: vi.fn() }));
import { NotificationInbox } from "@/app/my-activity/notification-inbox";
import { NotificationBell } from "@/components/notification-bell";
const notices = [
  { id: "first", booking_id: "booking", event_kind: "confirmed", subject: "Booking confirmed", text: "Full booking content.",
    important: false, created_at: "2026-10-17T09:00:00Z", read_at: null, acknowledged_at: null },
  { id: "second", booking_id: "booking", event_kind: "refund_incomplete", subject: "Refund requires attention", text: "Financial content.",
    important: true, created_at: "2026-10-16T09:00:00Z", read_at: "2026-10-16T09:00:00Z", acknowledged_at: "2026-10-16T09:00:00Z" },
];
const inbox = { notices, total: 30, totalPages: 2, query: parseInboxQuery({ q: "booking" }) };
beforeEach(() => { installDialogMock(); manage.mockResolvedValue({ ok: true }); });
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals(); });

test.each([
  { q: "booking" }, { status: "read" }, { status: "unread" }, { type: "confirmed" },
])("shows Clear filters for an active criterion: %j", (criteria) => {
  render(<NotificationInbox inbox={{ ...inbox, query: parseInboxQuery(criteria) }} />);
  expect(screen.getByRole("button", { name: "Clear filters" })).toBeDefined();
});

test("sort and pagination alone do not show Clear filters", () => {
  render(<NotificationInbox inbox={{ ...inbox, query: parseInboxQuery({ sort: "oldest", page: 2 }) }} />);
  expect(screen.queryByRole("button", { name: "Clear filters" })).toBeNull();
});

test("clearing resets search, filters, selection and page, preserves sort and cancels pending search", () => {
  vi.useFakeTimers();
  const query = parseInboxQuery({ q: "booking", status: "unread", type: "confirmed", sort: "oldest", page: 2 });
  const { rerender } = render(<NotificationInbox inbox={{ ...inbox, query }} />);
  fireEvent.click(screen.getByRole("checkbox", { name: "Select all on this page" }));
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "refund" } });
  fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
  expect(screen.getByRole<HTMLInputElement>("searchbox").value).toBe("");
  expect(screen.queryByRole("toolbar")).toBeNull();
  expect(replace).toHaveBeenCalledExactlyOnceWith("/my-activity/notifications?sort=oldest", { scroll: false });
  act(() => { vi.advanceTimersByTime(350); });
  expect(replace).toHaveBeenCalledTimes(1);

  // The server supplies the cleared query and matching results after URL navigation.
  rerender(<NotificationInbox inbox={{ ...inbox, query: parseInboxQuery({ sort: "oldest" }) }} />);
  expect(screen.getByLabelText<HTMLSelectElement>("Status").value).toBe("all");
  expect(screen.getByLabelText<HTMLSelectElement>("Type").value).toBe("all");
  expect(screen.getByLabelText<HTMLSelectElement>("Sort").value).toBe("oldest");
  expect(screen.getByRole("navigation", { name: "Notification pages" }).querySelector('[aria-current="page"]')?.textContent).toBe("1");
  expect(screen.getByRole("link", { name: /Booking confirmed.*Confirmation/ }).getAttribute("href"))
    .toBe("/my-activity/notifications/first?sort=oldest");
  expect(screen.queryByRole("button", { name: "Clear filters" })).toBeNull();
});

test("a draft search can be cleared before its debounce runs", () => {
  vi.useFakeTimers();
  render(<NotificationInbox inbox={{ ...inbox, query: parseInboxQuery() }} />);
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "refund" } });
  fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
  act(() => { vi.advanceTimersByTime(350); });
  expect(replace).toHaveBeenCalledExactlyOnceWith("/my-activity/notifications", { scroll: false });
  expect(screen.getByRole<HTMLInputElement>("searchbox").value).toBe("");
});

test("the empty state also offers Clear filters", () => {
  render(<NotificationInbox inbox={{ ...inbox, notices: [], total: 0, totalPages: 1 }} />);
  const emptyState = screen.getByText("No notifications match your search and filters.").parentElement!;
  fireEvent.click(within(emptyState).getByRole("button", { name: "Clear filters" }));
  expect(replace).toHaveBeenCalledWith("/my-activity/notifications", { scroll: false });
  expect(screen.getByRole<HTMLInputElement>("searchbox").value).toBe("");
});

test("numbered pagination retains the page count, search, filters and sort", () => {
  const query = parseInboxQuery({ q: "booking", status: "unread", type: "confirmed", sort: "oldest", page: 2 });
  render(<NotificationInbox inbox={{ ...inbox, query, totalPages: 4 }} />);
  expect(screen.queryByText("Page 2 of 4")).toBeNull();
  const nav = screen.getByRole("navigation", { name: "Notification pages" });
  expect(nav.querySelector('[aria-current="page"]')?.textContent).toBe("2");
  for (const [label, page] of [["Previous", 1], ["Next", 3], ["4", 4]] as const) {
    expect(within(nav).getByRole("link", { name: label }).getAttribute("href")).toBe(
      `/my-activity/notifications?q=booking&status=unread&type=confirmed&sort=oldest${page > 1 ? `&page=${page}` : ""}`,
    );
  }
});

test.each([
  { notices: [], total: 0, totalPages: 0 },
  { notices: [], total: 0, totalPages: 1 },
  { notices, total: 2, totalPages: 1 },
])("hides pagination for an inbox with $total notifications and $totalPages pages", (result) => {
  render(<NotificationInbox inbox={{ ...inbox, ...result }} />);
  expect(screen.queryByRole("navigation", { name: "Notification pages" })).toBeNull();
  expect(screen.queryByText(/Page \d+ of \d+/)).toBeNull();
  expect(screen.getByText(`${result.total} notifications`)).toBeDefined();
});

test("selection has indeterminate state and bulk read/unread actions", async () => {
  render(<NotificationInbox inbox={inbox} />);
  fireEvent.click(screen.getByRole("checkbox", { name: "Select Booking confirmed" }));
  const all = screen.getByRole("checkbox", { name: "Select all on this page" }) as HTMLInputElement;
  expect(all.indeterminate).toBe(true);
  expect(screen.getByText("1 selected")).toBeDefined();
  fireEvent.click(all);
  expect(all.indeterminate).toBe(false); expect(all.checked).toBe(true);
  const toolbar = screen.getByRole("toolbar");
  fireEvent.click(within(toolbar).getByRole("button", { name: "Mark as unread" }));
  await vi.waitFor(() => expect(manage).toHaveBeenCalledWith({ ids: ["first", "second"], operation: "unread" }));
  await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());
  await vi.waitFor(() => { expect(all.checked).toBe(false); expect(all.disabled).toBe(false); });
  fireEvent.click(all);
  fireEvent.click(within(screen.getByRole("toolbar")).getByRole("button", { name: "Mark as read" }));
  await vi.waitFor(() => expect(manage).toHaveBeenLastCalledWith({ ids: ["first", "second"], operation: "read" }));
});

test("bulk deletion requires confirmation", async () => {
  render(<NotificationInbox inbox={inbox} />);
  fireEvent.click(screen.getByRole("checkbox", { name: "Select all on this page" }));
  fireEvent.click(within(screen.getByRole("toolbar")).getByRole("button", { name: "Delete" }));
  expect(manage).not.toHaveBeenCalled();
  const dialog = screen.getByRole("dialog", { name: "Delete notifications?" });
  fireEvent.click(within(dialog).getByRole("button", { name: "Delete from inbox" }));
  await vi.waitFor(() => expect(manage).toHaveBeenCalledWith({ ids: ["first", "second"], operation: "delete" }));
});

test("subjects link to details and preserve the inbox URL without marking read", () => {
  render(<NotificationInbox inbox={inbox} />);
  const link = screen.getByRole("link", { name: /Booking confirmed.*Confirmation/ });
  expect(link.getAttribute("href")).toBe("/my-activity/notifications/first?q=booking");
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(manage).not.toHaveBeenCalled();
});

test("debounces complete-history search and keeps URL filters in pagination", async () => {
  vi.useFakeTimers();
  render(<NotificationInbox inbox={inbox} />);
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "refund" } });
  expect(replace).not.toHaveBeenCalled();
  await act(async () => { vi.advanceTimersByTime(350); });
  expect(replace).toHaveBeenCalledWith("/my-activity/notifications?q=refund", { scroll: false });
  expect(screen.getByRole("link", { name: "Next" }).getAttribute("href")).toBe("/my-activity/notifications?q=booking&page=2");
  fireEvent.change(screen.getByLabelText("Status"), { target: { value: "unread" } });
  expect(replace).toHaveBeenLastCalledWith("/my-activity/notifications?q=refund&status=unread", { scroll: false });
});

test("filter navigation clears selection immediately", () => {
  render(<NotificationInbox inbox={inbox} />);
  fireEvent.click(screen.getByRole("checkbox", { name: "Select all on this page" }));
  fireEvent.change(screen.getByLabelText("Type"), { target: { value: "confirmed" } });
  expect(screen.queryByRole("toolbar")).toBeNull();
});

test("individual actions affect only that row and deletion can be cancelled", async () => {
  render(<NotificationInbox inbox={inbox} />);
  const actions = within(screen.getByLabelText("Actions for Booking confirmed"));
  fireEvent.click(actions.getByRole("button", { name: "Mark as read" }));
  await vi.waitFor(() => expect(manage).toHaveBeenCalledWith({ ids: ["first"], operation: "read" }));
  await vi.waitFor(() => expect(actions.getByRole("button", { name: "Delete notification" }).hasAttribute("disabled")).toBe(false));
  manage.mockClear();
  fireEvent.click(actions.getByRole("button", { name: "Delete notification" }));
  const dialog = within(screen.getByRole("dialog", { name: "Delete notifications?" }));
  fireEvent.click(dialog.getByRole("button", { name: "Cancel" }));
  expect(manage).not.toHaveBeenCalled();
  fireEvent.click(actions.getByRole("button", { name: "Delete notification" }));
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete from inbox" }));
  await vi.waitFor(() => expect(manage).toHaveBeenCalledWith({ ids: ["first"], operation: "delete" }));
});

test("read/unread actions require at least one selected notification whose status can change", () => {
  render(<NotificationInbox inbox={inbox} />);
  expect(screen.queryByRole("toolbar")).toBeNull();
  const unread = within(screen.getByLabelText("Actions for Booking confirmed"));
  const read = within(screen.getByLabelText("Actions for Refund requires attention"));
  expect(unread.getByRole("button", { name: "Mark as unread" })).toHaveProperty("disabled", true);
  expect(unread.getByRole("button", { name: "Mark as read" })).toHaveProperty("disabled", false);
  expect(read.getByRole("button", { name: "Mark as read" })).toHaveProperty("disabled", true);
  expect(read.getByRole("button", { name: "Mark as unread" })).toHaveProperty("disabled", false);
  fireEvent.click(unread.getByRole("button", { name: "Mark as unread" }));
  expect(manage).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("checkbox", { name: "Select Booking confirmed" }));
  const toolbar = within(screen.getByRole("toolbar"));
  expect(toolbar.getByRole("button", { name: "Mark as unread" })).toHaveProperty("disabled", true);
  fireEvent.click(screen.getByRole("checkbox", { name: "Select Refund requires attention" }));
  expect(toolbar.getByRole("button", { name: "Mark as unread" })).toHaveProperty("disabled", false);
  expect(toolbar.getByRole("button", { name: "Mark as read" })).toHaveProperty("disabled", false);
  fireEvent.click(screen.getByRole("checkbox", { name: "Select Refund requires attention" }));
  expect(toolbar.getByRole("button", { name: "Mark as unread" })).toHaveProperty("disabled", true);
});

test("inbox actions are disabled while processing and become eligible for retry after failure", async () => {
  let finish!: (result: { ok: false; message: string }) => void;
  manage.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  render(<NotificationInbox inbox={inbox} />);
  fireEvent.click(screen.getByRole("checkbox", { name: "Select all on this page" }));
  fireEvent.click(within(screen.getByRole("toolbar")).getByRole("button", { name: "Mark as read" }));
  for (const name of ["Selected notification actions", "Actions for Booking confirmed", "Actions for Refund requires attention"]) {
    const controls = name === "Selected notification actions" ? screen.getByRole("toolbar") : screen.getByLabelText(name);
    for (const button of within(controls).getAllByRole("button")) expect(button).toHaveProperty("disabled", true);
  }
  await act(async () => finish({ ok: false, message: "Try again." }));
  const toolbar = within(screen.getByRole("toolbar"));
  for (const button of toolbar.getAllByRole("button")) expect(button).toHaveProperty("disabled", false);
});

test("refreshed results cannot keep invisible notifications actionable or confirm their deletion", () => {
  const { rerender } = render(<NotificationInbox inbox={inbox} />);
  fireEvent.click(screen.getByRole("checkbox", { name: "Select Booking confirmed" }));
  fireEvent.click(within(screen.getByRole("toolbar")).getByRole("button", { name: "Delete" }));
  rerender(<NotificationInbox inbox={{ ...inbox, notices: [notices[1]] }} />);
  expect(screen.queryByRole("toolbar")).toBeNull();
  const confirm = within(screen.getByRole("dialog")).getByRole("button", { name: "Delete from inbox" });
  expect(confirm).toHaveProperty("disabled", true);
  fireEvent.click(confirm);
  expect(manage).not.toHaveBeenCalled();
});

test.each(["read", "unread", "delete"] as const)("%s updates both navbar indicators immediately after persistence", async operation => {
  vi.useFakeTimers();
  let persistedUnread = operation !== "unread";
  const fetcher = vi.fn(async () => ({ ok: true, json: async () => ({ unread: persistedUnread }) }));
  vi.stubGlobal("fetch", fetcher);
  let finish!: () => void;
  manage.mockImplementationOnce(() => new Promise(resolve => { finish = () => {
    persistedUnread = operation === "unread";
    resolve({ ok: true });
  }; }));
  render(<><NotificationBell /><NotificationBell /><NotificationInbox inbox={{ ...inbox, notices: [
    { ...notices[0], read_at: operation === "unread" ? "2026-10-17T09:00:00Z" : null },
  ] }} /></>);
  await act(async () => {});
  const controls = within(screen.getByLabelText("Actions for Booking confirmed"));
  fireEvent.click(controls.getByRole("button", { name: operation === "delete" ? "Delete notification" : operation === "read" ? "Mark as read" : "Mark as unread" }));
  if (operation === "delete") fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete from inbox" }));
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(document.querySelectorAll("[data-unread-indicator]")).toHaveLength(operation === "unread" ? 0 : 2);
  await act(async () => finish());
  await act(async () => {});
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(document.querySelectorAll("[data-unread-indicator]")).toHaveLength(operation === "unread" ? 2 : 0);
});
