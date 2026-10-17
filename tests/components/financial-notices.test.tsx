// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { parseInboxQuery } from "@/lib/notifications/inbox-query";

const { context, list, financial, redirect } = vi.hoisted(() => ({ context: vi.fn(), list: vi.fn(), financial: vi.fn(), redirect: vi.fn(() => { throw new Error("redirect"); }) }));
vi.mock("next/navigation", () => ({ redirect, useRouter: () => ({ refresh: vi.fn(), replace: vi.fn() }) }));
vi.mock("@/lib/profile/profile", () => ({ profileContext: context }));
vi.mock("@/lib/notifications/financial-notices", () => ({ listOwnNotifications: list, listOwnFinancialNotices: financial }));
vi.mock("@/app/my-activity/actions", () => ({ acknowledgeFinancialNoticeAction: vi.fn(), markNotificationReadAction: vi.fn(), manageNotificationsAction: vi.fn() }));
import { FinancialNotices } from "@/app/my-activity/financial-notices";

afterEach(() => { cleanup(); vi.resetAllMocks(); });
const client = {};
const active = { account: { state: "active", userId: "owner", roles: [] }, client };

it("keeps unresolved financial alerts visible when the inbox is empty or filtered", async () => {
  context.mockResolvedValue(active);
  list.mockResolvedValue({ notices: [], total: 0, totalPages: 1, query: parseInboxQuery({ status: "read" }) });
  financial.mockResolvedValue([{ id: "financial", subject: "Refund requires attention", text: "Contact the club.", important: true }]);
  render(await FinancialNotices({ searchParams: Promise.resolve({ status: "read" }) }));
  expect(list).toHaveBeenCalledWith({ status: "read" }, client);
  expect(within(screen.getByRole("alert")).getByRole("button", { name: "OK" })).toBeDefined();
  expect(screen.getByText("No notifications match your search and filters.")).toBeDefined();
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
