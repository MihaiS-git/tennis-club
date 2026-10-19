// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }), usePathname: () => "/" }));
import { NotificationBell } from "@/components/notification-bell";
import { refreshNotificationUnread } from "@/components/notification-unread";
const flush = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); };
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
test("both bells share initial boolean load, green transitions, focus, action refresh and visible-only polling", async () => {
  vi.useFakeTimers();
  let unread = true;
  let visible = true;
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visible ? "visible" : "hidden");
  const fetcher = vi.fn(async () => ({ ok: true, json: async () => ({ unread }) }));
  vi.stubGlobal("fetch", fetcher);
  const { unmount } = render(<><NotificationBell /><NotificationBell /></>);
  await flush();
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(screen.getAllByRole("link", { name: "Notifications, unread notifications" })).toHaveLength(2);
  expect(document.querySelectorAll(".bg-green-500")).toHaveLength(2);
  expect(fetcher.mock.calls[0]).toMatchObject(["/api/notifications/unread", { cache: "no-store" }]);
  unread = false;
  await act(async () => { refreshNotificationUnread(); }); await flush();
  expect(document.querySelectorAll("[data-unread-indicator]")).toHaveLength(0);
  unread = true;
  fireEvent.focus(window); await flush();
  expect(document.querySelectorAll("[data-unread-indicator]")).toHaveLength(2);
  await act(async () => { vi.advanceTimersByTime(60_000); }); await flush();
  expect(fetcher).toHaveBeenCalledTimes(4);
  visible = false; fireEvent(document, new Event("visibilitychange"));
  await act(async () => { vi.advanceTimersByTime(180_000); });
  fireEvent.focus(window); await flush();
  expect(fetcher).toHaveBeenCalledTimes(4);
  visible = true; fireEvent(document, new Event("visibilitychange")); await flush();
  expect(fetcher).toHaveBeenCalledTimes(5);
  unmount();
  await act(async () => { vi.advanceTimersByTime(120_000); });
  expect(fetcher).toHaveBeenCalledTimes(5);
});

test("navigation rerenders and replacing one navbar do not restart the shared polling clock", async () => {
  vi.useFakeTimers();
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  let unread = false;
  const fetcher = vi.fn(async () => ({ ok: true, json: async () => ({ unread }) }));
  vi.stubGlobal("fetch", fetcher);
  const { rerender } = render(<><NotificationBell key="desktop" /><NotificationBell key="mobile" /></>);
  await flush();
  for (let step = 1; step <= 5; step++) {
    await act(async () => { vi.advanceTimersByTime(10_000); });
    rerender(<><NotificationBell key="desktop" /><NotificationBell key={`mobile-${step}`} /></>);
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(1);
  }
  unread = true;
  await act(async () => { vi.advanceTimersByTime(10_000); }); await flush();
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(document.querySelectorAll("[data-unread-indicator]")).toHaveLength(2);
});

test("a refresh during an in-flight poll queues a fresh read without concurrent requests overwriting it", async () => {
  const pending: ((response: { ok: boolean; json: () => Promise<{ unread: boolean }> }) => void)[] = [];
  const fetcher = vi.fn(() => new Promise(resolve => { pending.push(resolve); }));
  vi.stubGlobal("fetch", fetcher);
  render(<><NotificationBell /><NotificationBell /></>);
  expect(fetcher).toHaveBeenCalledTimes(1);
  act(() => { refreshNotificationUnread(); refreshNotificationUnread(); });
  expect(fetcher).toHaveBeenCalledTimes(1);
  await act(async () => pending[0]({ ok: true, json: async () => ({ unread: false }) }));
  await flush();
  expect(fetcher).toHaveBeenCalledTimes(2);
  await act(async () => pending[1]({ ok: true, json: async () => ({ unread: true }) }));
  await flush();
  expect(document.querySelectorAll("[data-unread-indicator]")).toHaveLength(2);
  expect(fetcher).toHaveBeenCalledTimes(2);
});

test("an aborted response from an unmounted navbar cannot overwrite the next mounted store", async () => {
  let finishOld!: (response: { ok: boolean; json: () => Promise<{ unread: boolean }> }) => void;
  const fetcher = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; }))
    .mockResolvedValue({ ok: true, json: async () => ({ unread: true }) });
  vi.stubGlobal("fetch", fetcher);
  const old = render(<NotificationBell />);
  old.unmount();
  render(<NotificationBell />);
  await flush();
  expect(screen.getByRole("link", { name: "Notifications, unread notifications" })).toBeDefined();
  await act(async () => finishOld({ ok: true, json: async () => ({ unread: false }) }));
  await flush();
  expect(screen.getByRole("link", { name: "Notifications, unread notifications" })).toBeDefined();
  expect(fetcher).toHaveBeenCalledTimes(2);
});

const respond = (body: object) => vi.fn(async () => ({ ok: true, json: async () => body }));
const openAdminBell = () => fireEvent.click(screen.getByRole("button", { name: /^Notifications/ }));

test("a member bell stays a direct link and ignores any Admin field", async () => {
  vi.stubGlobal("fetch", respond({ unread: false, adminAlerts: true }));
  render(<NotificationBell />);
  await flush();
  expect(screen.getByRole("link", { name: "Notifications" }).getAttribute("href")).toBe("/my-activity/notifications");
  expect(screen.queryByRole("button", { name: /^Notifications/ })).toBeNull();
  expect(document.querySelectorAll("[data-unread-indicator]")).toHaveLength(0);
});

test.each([
  ["neither", { unread: false, adminAlerts: false }, "Notifications", false, false],
  ["unread personal notifications", { unread: true, adminAlerts: false }, "Notifications, unread notifications", true, false],
  ["unresolved Admin alerts", { unread: false, adminAlerts: true }, "Notifications, admin alerts need attention", false, true],
  ["both", { unread: true, adminAlerts: true }, "Notifications, unread notifications, admin alerts need attention", true, true],
  ["a non-Admin response shape", { unread: false }, "Notifications", false, false],
])("an Admin bell with %s shows separate indicators and the combined dot", async (_name, body, label, personal, admin) => {
  vi.stubGlobal("fetch", respond(body));
  render(<NotificationBell admin />);
  await flush();
  expect(document.querySelectorAll("[data-unread-indicator]")).toHaveLength(personal || admin ? 1 : 0);
  expect(screen.queryByRole("navigation", { name: "Notifications" })).toBeNull();
  openAdminBell();
  expect(screen.getByRole("button", { name: label }).getAttribute("aria-expanded")).toBe("true");
  expect(document.querySelectorAll("[data-personal-indicator]")).toHaveLength(personal ? 1 : 0);
  expect(document.querySelectorAll("[data-admin-indicator]")).toHaveLength(admin ? 1 : 0);
  const links = screen.getAllByRole("link");
  expect(links.map((link) => link.getAttribute("href"))).toEqual(["/my-activity/notifications", "/admin/payments/notifications"]);
});

test("resolved Admin alerts clear the dot on the shared refresh, and the panel closes on Escape, outside press and selection", async () => {
  let alerts = true;
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ unread: false, adminAlerts: alerts }) })));
  render(<><NotificationBell admin /><NotificationBell admin /></>);
  await flush();
  expect(document.querySelectorAll("[data-unread-indicator]")).toHaveLength(2);
  alerts = false;
  await act(async () => { refreshNotificationUnread(); }); await flush();
  expect(document.querySelectorAll("[data-unread-indicator]")).toHaveLength(0);
  alerts = true;
  fireEvent.focus(window); await flush();
  expect(document.querySelectorAll("[data-unread-indicator]")).toHaveLength(2);

  const [bell] = screen.getAllByRole("button", { name: /^Notifications/ });
  fireEvent.click(bell);
  fireEvent.keyDown(window, { key: "Escape" });
  expect(screen.queryByRole("navigation", { name: "Notifications" })).toBeNull();
  expect(document.activeElement).toBe(bell);
  fireEvent.click(bell);
  fireEvent.pointerDown(document.body);
  expect(screen.queryByRole("navigation", { name: "Notifications" })).toBeNull();
  fireEvent.click(bell);
  fireEvent.click(screen.getByRole("link", { name: /^Admin notifications/ }));
  expect(screen.queryByRole("navigation", { name: "Notifications" })).toBeNull();
});
