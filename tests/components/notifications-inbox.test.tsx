// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { installDialogMock } from "../helpers/dialog";
import { InboxFilters } from "@/app/messages/inbox-filters";
import { InboxList, type InboxRow } from "@/app/messages/inbox-list";
import { MessageDetailActions } from "@/app/messages/[messageId]/unread-button";
import { parseInboxQuery } from "@/lib/notifications/inbox-query";

const mocks = vi.hoisted(() => ({ update: vi.fn(), deleteOne: vi.fn(), read: vi.fn(), unread: vi.fn(),
  refresh: vi.fn(), replace: vi.fn(), push: vi.fn() }));
vi.mock("@/app/messages/actions", () => ({ updateSelectedMessagesAction: mocks.update, deleteMessageAction: mocks.deleteOne,
  markMessageReadAction: mocks.read, markMessageUnreadAction: mocks.unread }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh, replace: mocks.replace, push: mocks.push }) }));

const ids = ["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002",
  "00000000-0000-4000-8000-000000000003"];
const rows: InboxRow[] = ids.map((id, index) => ({ id, category: "Bookings", subject: `Booking ${index + 1}`,
  bodyText: "Court confirmed", read: false, createdAt: "2026-10-22T10:00:00Z", createdLabel: "22 Oct 2026" }));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.update.mockResolvedValue({ updated: 2 });
  mocks.deleteOne.mockResolvedValue({ ok: true });
  mocks.read.mockResolvedValue({ ok: true });
  mocks.unread.mockResolvedValue({ ok: true });
  installDialogMock();
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

it("selects only the current page and clears selection when the page changes", async () => {
  const first = parseInboxQuery({ q: "Court", page: "1" });
  const second = parseInboxQuery({ q: "Court", page: "2" });
  const { rerender } = render(<InboxList key="page-1" rows={rows.slice(0, 2)} query={first} search="q=Court&page=1" />);
  fireEvent.click(screen.getByRole("button", { name: "Select page" }));
  expect(screen.getByText("2 selected on this page")).toBeDefined();
  rerender(<InboxList key="page-2" rows={rows.slice(2)} query={second} search="q=Court&page=2" />);
  expect(screen.getByText("0 selected on this page")).toBeDefined();
  fireEvent.click(screen.getByRole("button", { name: "Select page" }));
  fireEvent.click(screen.getByRole("button", { name: "Mark read" }));
  await waitFor(() => expect(mocks.update).toHaveBeenCalledWith([ids[2]], "read"));
  expect(mocks.update).toHaveBeenCalledTimes(1);
});

it("marks selected messages read and unread, then clears selection", async () => {
  render(<InboxList rows={rows.slice(0, 2)} query={parseInboxQuery({})} search="page=1" />);
  fireEvent.click(screen.getByRole("checkbox", { name: "Select Booking 1" }));
  fireEvent.click(screen.getByRole("button", { name: "Mark read" }));
  await waitFor(() => expect(mocks.update).toHaveBeenCalledWith([ids[0]], "read"));
  await waitFor(() => expect(screen.getByText("0 selected on this page")).toBeDefined());
  fireEvent.click(screen.getByRole("button", { name: "Select page" }));
  fireEvent.click(screen.getByRole("button", { name: "Mark unread" }));
  await waitFor(() => expect(mocks.update).toHaveBeenCalledWith(ids.slice(0, 2), "unread"));
  expect(mocks.refresh).toHaveBeenCalledTimes(2);
});

it("deletes one message without confirmation and confirms bulk deletion", async () => {
  const query = parseInboxQuery({ q: "Court", page: "2" });
  render(<InboxList rows={rows.slice(0, 2)} query={query} search="q=Court&page=2" />);
  const deleteButton = screen.getByRole("button", { name: "Delete Booking 1" });
  expect(deleteButton.textContent).toBe("");
  expect(deleteButton.querySelector("svg.lucide-trash-2")?.getAttribute("aria-hidden")).toBe("true");
  fireEvent.click(deleteButton);
  await waitFor(() => expect(mocks.deleteOne).toHaveBeenCalledWith(ids[0]));
  expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Select page" }));
  fireEvent.click(screen.getByRole("button", { name: "Delete selected" }));
  const dialog = screen.getByRole("dialog", { name: "Delete selected notifications?" });
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(mocks.update).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Delete selected" }));
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete selected" }));
  await waitFor(() => expect(mocks.update).toHaveBeenCalledWith(ids.slice(0, 2), "delete"));
  expect(mocks.replace).toHaveBeenCalledWith("/messages?q=Court&page=1");
});

it("reserves an inert Clear slot for default filters and pagination alone", () => {
  const { rerender } = render(<InboxFilters query={parseInboxQuery({})} />);
  const slot = screen.getByRole("search").querySelector("[data-filter-clear-slot]");
  expect(screen.queryByRole("link", { name: "Clear" })).toBeNull();
  expect(slot?.children).toHaveLength(0);
  expect(slot?.parentElement).toBe(screen.getByRole("search"));
  const controls = [screen.getByRole("searchbox"), ...screen.getAllByRole("combobox")];
  rerender(<InboxFilters query={parseInboxQuery({ q: "  ", status: "all", category: "all", sort: "newest", page: "3" })} />);
  expect(screen.queryByRole("link", { name: "Clear" })).toBeNull();
  rerender(<InboxFilters query={parseInboxQuery({ status: "unread" })} />);
  expect(screen.getByRole("link", { name: "Clear" }).parentElement).toBe(slot);
  expect([screen.getByRole("searchbox"), ...screen.getAllByRole("combobox")]).toEqual(controls);
  rerender(<InboxFilters query={parseInboxQuery({})} />);
  expect(screen.getByRole("search").querySelector("[data-filter-clear-slot]")).toBe(slot);
  expect(screen.queryByRole("link", { name: "Clear" })).toBeNull();
});

it.each([{ q: "Court" }, { status: "read" }, { category: "club" }, { sort: "oldest" }])(
  "shows Clear for a meaningful non-default filter: %j", (filter) => {
    render(<InboxFilters query={parseInboxQuery(filter)} />);
    expect(screen.getByRole("link", { name: "Clear" }).getAttribute("href")).toBe("/messages");
  },
);

it("detail controls mark read, mark unread and delete while keeping the inbox return URL", async () => {
  const returnHref = "/messages?q=Court&status=unread&page=2";
  render(<MessageDetailActions id={ids[0]} subject="Booking 1" returnHref={returnHref} />);
  fireEvent.click(screen.getByRole("button", { name: "Mark read" }));
  await waitFor(() => expect(mocks.read).toHaveBeenCalledWith(ids[0]));
  expect(mocks.refresh).toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Mark unread" }));
  await waitFor(() => expect(mocks.unread).toHaveBeenCalledWith(ids[0]));
  expect(mocks.push).toHaveBeenLastCalledWith(returnHref);
  fireEvent.click(screen.getByRole("button", { name: "Delete Booking 1" }));
  await waitFor(() => expect(mocks.deleteOne).toHaveBeenCalledWith(ids[0]));
  expect(mocks.push).toHaveBeenLastCalledWith(returnHref);
});


it("applies selects immediately, composes pending changes and retains search and sort", () => {
  render(<InboxFilters query={parseInboxQuery({ q: "Court", page: "3", sort: "oldest" })} />);
  expect(screen.queryByRole("button", { name: "Apply" })).toBeNull();
  fireEvent.change(screen.getByRole("combobox", { name: "Status" }), { target: { value: "unread" } });
  expect(mocks.replace).toHaveBeenLastCalledWith("/messages?q=Court&status=unread&sort=oldest&page=1", { scroll: false });
  fireEvent.change(screen.getByRole("combobox", { name: "Category" }), { target: { value: "bookings" } });
  expect(mocks.replace).toHaveBeenLastCalledWith("/messages?q=Court&status=unread&category=bookings&sort=oldest&page=1", { scroll: false });
});

it("sort preserves the current page, search and filters", () => {
  render(<InboxFilters query={parseInboxQuery({ q: "Court", status: "read", category: "club", page: "3" })} />);
  fireEvent.change(screen.getByRole("combobox", { name: "Sort" }), { target: { value: "subject_asc" } });
  expect(mocks.replace).toHaveBeenLastCalledWith("/messages?q=Court&status=read&category=club&sort=subject_asc&page=3", { scroll: false });
});

it("debounces search for 300 ms, cancels older timers and keeps filters", () => {
  vi.useFakeTimers();
  render(<InboxFilters query={parseInboxQuery({ status: "unread", category: "payments", sort: "oldest", page: "4" })} />);
  const input = screen.getByRole("searchbox");
  fireEvent.change(input, { target: { value: "Co" } });
  act(() => vi.advanceTimersByTime(200));
  fireEvent.change(input, { target: { value: "Court" } });
  act(() => vi.advanceTimersByTime(299));
  expect(mocks.replace).not.toHaveBeenCalled();
  act(() => vi.advanceTimersByTime(1));
  expect(mocks.replace).toHaveBeenCalledExactlyOnceWith("/messages?q=Court&status=unread&category=payments&sort=oldest&page=1", { scroll: false });
});

it("keeps newer typing and focus across a search response and composes a pending search with selects", () => {
  vi.useFakeTimers();
  const { rerender } = render(<InboxFilters query={parseInboxQuery({})} />);
  const input = screen.getByRole("searchbox");
  input.focus();
  fireEvent.change(input, { target: { value: "Court" } });
  act(() => vi.advanceTimersByTime(300));
  fireEvent.change(input, { target: { value: "Court A" } });
  rerender(<InboxFilters query={parseInboxQuery({ q: "Court" })} />);
  expect(screen.getByRole("searchbox")).toBe(input);
  expect(document.activeElement).toBe(input);
  expect(input.getAttribute("value")).toBe("Court A");
  fireEvent.change(screen.getByRole("combobox", { name: "Category" }), { target: { value: "bookings" } });
  act(() => vi.advanceTimersByTime(300));
  expect(mocks.replace).toHaveBeenLastCalledWith("/messages?q=Court+A&category=bookings&page=1", { scroll: false });
});

it("syncs controls on URL and page navigation and cancels search on unmount or Clear", () => {
  vi.useFakeTimers();
  const { rerender, unmount } = render(<InboxFilters query={parseInboxQuery({ q: "Court", status: "unread" })} />);
  rerender(<InboxFilters query={parseInboxQuery({ q: "Lesson", status: "read", category: "coaching", sort: "oldest", page: "2" })} />);
  expect(screen.getByRole("searchbox").getAttribute("value")).toBe("Lesson");
  expect((screen.getByRole("combobox", { name: "Status" }) as HTMLSelectElement).value).toBe("read");
  expect((screen.getByRole("combobox", { name: "Category" }) as HTMLSelectElement).value).toBe("coaching");
  expect((screen.getByRole("combobox", { name: "Sort" }) as HTMLSelectElement).value).toBe("oldest");
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "New" } });
  fireEvent.click(screen.getByRole("link", { name: "Clear" }));
  rerender(<InboxFilters query={parseInboxQuery({})} />);
  expect(screen.getByRole("searchbox").getAttribute("value")).toBe("");
  act(() => vi.advanceTimersByTime(300));
  expect(mocks.replace).not.toHaveBeenCalled();
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "Another" } });
  unmount();
  act(() => vi.advanceTimersByTime(300));
  expect(mocks.replace).not.toHaveBeenCalled();
});
