// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const { requireActiveAdmin, currentPath } = vi.hoisted(() => ({
  requireActiveAdmin: vi.fn(),
  currentPath: { value: "/admin" },
}));

vi.mock("../../src/lib/admin/authorization", () => ({ requireActiveAdmin }));
vi.mock("next/navigation", () => ({ usePathname: () => currentPath.value }));

import AdminLayout, { AdminAuthorizedShell, instant } from "../../src/app/admin/layout";

beforeEach(() => {
  vi.clearAllMocks();
  currentPath.value = "/admin";
  requireActiveAdmin.mockResolvedValue({ userId: "admin-1" });
});
afterEach(cleanup);

it.each([
  ["/admin", "Overview"],
  ["/admin/locations", "Locations"],
  ["/admin/courts", "Courts"],
  ["/admin/pricing", "Pricing"],
  ["/admin/users", "Users"],
])("keeps the shared shell and marks %s active", async (path, label) => {
  currentPath.value = path;
  render(await AdminAuthorizedShell({ children: <h1>Section content</h1> }));

  expect(requireActiveAdmin).toHaveBeenCalledOnce();
  const shell = screen.getByRole("main");
  const navigation = within(shell).getByRole("navigation", { name: "Admin navigation" });
  expect(within(navigation).getAllByRole("link").map((link) => [link.textContent, link.getAttribute("href")])).toEqual([
    ["Overview", "/admin"], ["Locations", "/admin/locations"],
    ["Courts", "/admin/courts"], ["Pricing", "/admin/pricing"], ["Users", "/admin/users"],
  ]);
  expect(within(navigation).getByRole("link", { name: label }).getAttribute("aria-current")).toBe("page");
  expect(within(shell).getByRole("heading", { name: "Section content" })).toBeTruthy();
});

it("does not render the shell when active-admin authorization rejects", async () => {
  requireActiveAdmin.mockRejectedValue(new Error("notFound"));
  await expect(AdminAuthorizedShell({ children: <h1>Private</h1> })).rejects.toThrow("notFound");
  expect(screen.queryByRole("navigation", { name: "Admin navigation" })).toBeNull();
});

it("declares the shared admin segment blocking without a whole-section fallback", () => {
  expect(instant).toBe(false);
  const layout = AdminLayout({ children: <h1>Section content</h1> });
  expect(layout.type).toBe(AdminAuthorizedShell);
});
