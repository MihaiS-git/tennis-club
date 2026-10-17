// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const { list } = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock("@/lib/notifications/admin-notifications", () => ({ listAdminUndeliveredNotifications: list }));
vi.mock("@/app/admin/payments/notification-retry-button", () => ({ NotificationRetryButton: () => null }));

import AdminNotificationsPage from "@/app/admin/payments/notifications/page";

afterEach(() => { cleanup(); list.mockReset(); });

test("shows notification times in Europe/Bucharest across daylight-saving changes", async () => {
  list.mockResolvedValue({
    rows: [{
      id: "n1", recipient: "ana@example.test", subject: "Booking confirmed", important: false, booking_id: null,
      last_error: "unavailable", attempts: 2,
      created_at: "2026-07-15T09:00:00.000Z", // EEST, UTC+3
      next_attempt_at: "2026-12-15T09:00:00.000Z", // EET, UTC+2
    }],
    total: 1, unacknowledgedExceptions: 0, page: 1, totalPages: 1,
  });
  render(await AdminNotificationsPage({ searchParams: Promise.resolve({}) }));

  const [created, nextRetry] = screen.getAllByRole("cell").filter((cell) => cell.querySelector("time"));
  expect(created.textContent).toBe("15 Jul 2026, 12:00:00");
  expect(nextRetry.textContent).toBe("15 Dec 2026, 11:00:00");
  expect(created.querySelector("time")?.getAttribute("dateTime")).toBe("2026-07-15T09:00:00.000Z");
  expect(screen.getByText(/Times in Europe\/Bucharest\./)).toBeTruthy();
});
