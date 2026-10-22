// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { installDialogMock } from "../helpers/dialog";
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
afterEach(cleanup);

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
  fireEvent.click(screen.getByRole("button", { name: "Delete Booking 1" }));
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

it("detail controls mark read, mark unread and delete while keeping the inbox return URL", async () => {
  const returnHref = "/messages?q=Court&status=unread&page=2";
  render(<MessageDetailActions id={ids[0]} returnHref={returnHref} />);
  fireEvent.click(screen.getByRole("button", { name: "Mark read" }));
  await waitFor(() => expect(mocks.read).toHaveBeenCalledWith(ids[0]));
  expect(mocks.refresh).toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Mark unread" }));
  await waitFor(() => expect(mocks.unread).toHaveBeenCalledWith(ids[0]));
  expect(mocks.push).toHaveBeenLastCalledWith(returnHref);
  fireEvent.click(screen.getByRole("button", { name: "Delete" }));
  await waitFor(() => expect(mocks.deleteOne).toHaveBeenCalledWith(ids[0]));
  expect(mocks.push).toHaveBeenLastCalledWith(returnHref);
});
