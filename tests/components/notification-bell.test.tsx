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
