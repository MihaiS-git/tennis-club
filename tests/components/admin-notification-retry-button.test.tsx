// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const { retry, refresh, refreshIndicators } = vi.hoisted(() => ({ retry: vi.fn(), refresh: vi.fn(), refreshIndicators: vi.fn() }));
vi.mock("@/app/admin/payments/actions", () => ({ retryNotificationAction: retry }));
vi.mock("@/components/notification-unread", () => ({ refreshNotificationUnread: refreshIndicators }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { NotificationRetryButton } from "@/app/admin/payments/notification-retry-button";

afterEach(() => { cleanup(); vi.resetAllMocks(); });

test.each([{ ok: true, result: "accepted" }, { ok: false, message: "This notification no longer exists." }])(
  "a manual retry refreshes the list and the navbar Admin indicator: %o", async (outcome) => {
    retry.mockResolvedValue(outcome);
    render(<NotificationRetryButton id="0a000000-0000-4000-8000-000000000001" />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Retry now" })); });
    expect(refresh).toHaveBeenCalledOnce();
    expect(refreshIndicators).toHaveBeenCalledOnce();
  });
