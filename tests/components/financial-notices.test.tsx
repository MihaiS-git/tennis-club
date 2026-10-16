// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

const { context, list, redirect } = vi.hoisted(() => ({ context: vi.fn(), list: vi.fn(), redirect: vi.fn(() => { throw new Error("redirect"); }) }));
vi.mock("next/navigation", () => ({ redirect, useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/lib/profile/profile", () => ({ profileContext: context }));
vi.mock("@/lib/notifications/financial-notices", () => ({ listOwnFinancialNotices: list }));
vi.mock("@/app/my-activity/actions", () => ({ acknowledgeFinancialNoticeAction: vi.fn() }));

import { FinancialNotices } from "@/app/my-activity/financial-notices";

afterEach(() => { cleanup(); vi.clearAllMocks(); });

const client = {};
const active = { account: { state: "active", userId: "owner", roles: [] }, client };

it("shows only important financial alerts with acknowledgement, without ordinary emails or delivery diagnostics", async () => {
  context.mockResolvedValue(active);
  list.mockResolvedValue([
    { id: "c9000000-0000-4000-8000-000000000001", subject: "Refund requires attention", text: "Refund could not be completed.", important: true, emailFailed: true },
    { id: "c9000000-0000-4000-8000-000000000002", subject: "Booking confirmed", text: "Your booking is confirmed.", important: false, emailFailed: true },
    { id: "c9000000-0000-4000-8000-000000000003", subject: "Booking rescheduled", text: "Your booking moved.", important: false, emailFailed: true },
  ]);
  render(await FinancialNotices());
  expect(list).toHaveBeenCalledWith(client);
  const alerts = screen.getAllByRole("alert");
  expect(alerts).toHaveLength(1);
  expect(within(alerts[0]).getByRole("heading", { name: "Refund requires attention" })).toBeDefined();
  expect(within(alerts[0]).getByRole("button", { name: "OK" })).toBeDefined();
  expect(screen.queryByText("Booking confirmed")).toBeNull();
  expect(screen.queryByText("Booking rescheduled")).toBeNull();
  expect(screen.queryByText(/could not deliver this message/)).toBeNull();
});

it("explains when nothing needs attention", async () => {
  context.mockResolvedValue(active);
  list.mockResolvedValue([{ id: "c9000000-0000-4000-8000-000000000002", subject: "Booking confirmed", text: "", important: false, emailFailed: true }]);
  render(await FinancialNotices());
  expect(screen.getByText("You have no notifications that need your attention.")).toBeDefined();
  expect(screen.queryByRole("alert")).toBeNull();
});

it("requires a signed-in active account", async () => {
  context.mockResolvedValue({ account: { state: "unauthenticated" } });
  await expect(FinancialNotices()).rejects.toThrow("redirect");
  expect(redirect).toHaveBeenCalledWith("/login");
  context.mockResolvedValue({ account: { state: "suspended" }, client });
  render(await FinancialNotices());
  expect(screen.getByText("Your account cannot access notifications right now.")).toBeDefined();
  expect(list).not.toHaveBeenCalled();
});
