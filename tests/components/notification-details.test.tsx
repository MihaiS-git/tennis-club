// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { StrictMode } from "react";
import { renderToString } from "react-dom/server";
import { installDialogMock } from "../helpers/dialog";
const { context, read, markRead, manage, acknowledge, push, refresh } = vi.hoisted(() => ({ context: vi.fn(), read: vi.fn(), markRead: vi.fn(), manage: vi.fn(), acknowledge: vi.fn(), push: vi.fn(), refresh: vi.fn() }));
vi.mock("@/lib/profile/profile", () => ({ profileContext: context }));
vi.mock("@/lib/notifications/financial-notices", () => ({ readOwnNotification: read }));
vi.mock("@/app/my-activity/actions", () => ({ manageNotificationsAction: manage, markNotificationReadAction: markRead, acknowledgeFinancialNoticeAction: acknowledge }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, refresh }), redirect: (path: string) => { throw new Error(path); } }));
import NotificationDetailsPage from "@/app/my-activity/notifications/[notificationId]/page";
import { NotificationDetailsContent } from "@/app/my-activity/notifications/[notificationId]/content";
import { NotificationDetailsActions } from "@/app/my-activity/notifications/[notificationId]/notification-details-actions";
import { NotificationBell } from "@/components/notification-bell";
const props = { params: Promise.resolve({ notificationId: "notice" }), searchParams: Promise.resolve({ q: "refund", status: "unread", type: "refund_incomplete", sort: "oldest", page: "3" }) };
const back = "/my-activity/notifications?q=refund&status=unread&type=refund_incomplete&sort=oldest&page=3";
const notice = { id: "notice", subject: "Full financial subject", text: "Hello Customer,\n\nComplete message.", event_kind: "refund_incomplete", booking_id: "booking-ref", created_at: "2026-10-17T09:00:00Z", read_at: null, important: true, acknowledged_at: null };
beforeEach(() => {
  installDialogMock();
  context.mockResolvedValue({ account: { state: "active" }, client: {} });
  read.mockResolvedValue(notice);
  manage.mockResolvedValue({ ok: true });
  markRead.mockResolvedValue({ ok: true });
  acknowledge.mockResolvedValue({ ok: true });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
test("server rendering and prefetch reads preserve the full message without mutations", async () => {
  expect(NotificationDetailsPage(props).props.children.type).toBe(NotificationDetailsContent);
  const content = await NotificationDetailsContent(props);
  const html = renderToString(content);
  expect(html).toContain("Hello Customer,");
  expect(html).toContain("Complete message.");
  expect(read).toHaveBeenCalledWith("notice", {});
  expect(markRead).not.toHaveBeenCalled();
  expect(manage).not.toHaveBeenCalled();
  expect(acknowledge).not.toHaveBeenCalled();
});

test("opening details renders a message card and automatically reads without acknowledging", async () => {
  render(await NotificationDetailsContent(props));
  const article = screen.getByRole("article", { name: "Full financial subject" });
  expect(screen.getByRole("heading", { name: "Full financial subject" })).toBeDefined();
  expect(screen.getByText(/Complete message/).textContent).toBe("Hello Customer,\n\nComplete message.");
  expect(screen.getByText("Refund issue")).toBeDefined();
  expect(article.querySelector("time")?.getAttribute("dateTime")).toBe("2026-10-17T09:00:00Z");
  expect(article.parentElement?.className).toContain("max-w-3xl");
  expect(screen.queryByText("booking-ref")).toBeNull();
  expect(screen.getByRole("link", { name: "Back to notifications" }).getAttribute("href")).toBe(back);
  expect(screen.queryByRole("button", { name: "Mark as read" })).toBeNull();
  await vi.waitFor(() => expect(markRead).toHaveBeenCalledExactlyOnceWith("notice"));
  expect(manage).not.toHaveBeenCalled();
  expect(acknowledge).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "OK" }));
  await vi.waitFor(() => expect(acknowledge).toHaveBeenCalledWith("notice"));
});

test("ordinary messages mark read once on opening, including Strict Mode and rerenders", async () => {
  read.mockResolvedValue({ ...notice, important: false, event_kind: "confirmed" });
  const content = await NotificationDetailsContent(props);
  const { rerender } = render(<StrictMode>{content}</StrictMode>);
  await vi.waitFor(() => expect(markRead).toHaveBeenCalledExactlyOnceWith("notice"));
  rerender(<StrictMode>{await NotificationDetailsContent(props)}</StrictMode>);
  expect(markRead).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("button", { name: "OK" })).toBeNull();
  expect(acknowledge).not.toHaveBeenCalled();
});

test("opening a message refreshes the navbar unread indicator", async () => {
  let unread = true;
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  const fetcher = vi.fn(async () => ({ ok: true, json: async () => ({ unread }) }));
  vi.stubGlobal("fetch", fetcher);
  markRead.mockImplementation(async () => { unread = false; return { ok: true }; });
  const { rerender } = render(<NotificationBell />);
  await vi.waitFor(() => expect(screen.getByRole("link", { name: "Notifications, unread notifications" })).toBeDefined());
  const content = await NotificationDetailsContent(props);
  rerender(<><NotificationBell />{content}</>);
  await vi.waitFor(() => expect(screen.getByRole("link", { name: "Notifications" })).toBeDefined());
  expect(document.querySelector("[data-unread-indicator]")).toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(acknowledge).not.toHaveBeenCalled();
});

test("already read messages do not issue another automatic read", async () => {
  read.mockResolvedValue({ ...notice, read_at: "2026-10-17T09:01:00Z" });
  render(await NotificationDetailsContent(props));
  expect(markRead).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "Mark as read" })).toBeNull();
});

test("details delete confirms and returns to the preserved inbox", async () => {
  render(await NotificationDetailsContent(props));
  const remove = screen.getByRole("button", { name: "Delete notification" });
  expect(remove.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
  expect(remove.textContent).toBe("");
  fireEvent.click(remove);
  expect(manage).not.toHaveBeenCalled();
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete from inbox" }));
  await vi.waitFor(() => expect(push).toHaveBeenCalledWith(back));
  expect(manage).toHaveBeenCalledWith({ ids: ["notice"], operation: "delete" });
});

test("deleting can be cancelled", async () => {
  render(await NotificationDetailsContent(props));
  fireEvent.click(screen.getByRole("button", { name: "Delete notification" }));
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
  expect(manage).not.toHaveBeenCalled();
  expect(push).not.toHaveBeenCalled();
});

test("untrusted content is rendered as text with its line breaks intact", async () => {
  const text = 'Hello Customer,\n\n<script>alert("test")</script>\n\nOriginal final paragraph.';
  read.mockResolvedValue({ ...notice, text });
  render(await NotificationDetailsContent(props));
  expect(screen.getByText(/Original final paragraph/).textContent).toBe(text);
  expect(screen.getByRole("article").querySelector("script")).toBeNull();
});

test("a failed automatic read does not clear the navbar indicator or acknowledge", async () => {
  const fetcher = vi.fn(async () => ({ ok: true, json: async () => ({ unread: true }) }));
  vi.stubGlobal("fetch", fetcher);
  markRead.mockResolvedValue({ ok: false, message: "This notification is no longer available." });
  render(<><NotificationBell /><NotificationDetailsActions id="notice" read={false} backHref={back} /></>);
  await vi.waitFor(() => expect(screen.getByRole("link", { name: "Notifications, unread notifications" })).toBeDefined());
  await act(async () => { await Promise.resolve(); });
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(acknowledge).not.toHaveBeenCalled();
});

test("missing, deleted or foreign details are gracefully unavailable", async () => {
  read.mockResolvedValue(null);
  render(await NotificationDetailsContent(props));
  expect(screen.getByText("This notification is no longer available.")).toBeDefined();
  expect(screen.queryByRole("button")).toBeNull();
  expect(markRead).not.toHaveBeenCalled();
});
test("details require authentication and active account", async () => {
  context.mockResolvedValue({ account: { state: "unauthenticated" } });
  await expect(NotificationDetailsContent(props)).rejects.toThrow("/login");
  context.mockResolvedValue({ account: { state: "suspended" } });
  render(await NotificationDetailsContent(props));
  expect(read).not.toHaveBeenCalled();
  expect(markRead).not.toHaveBeenCalled();
});
