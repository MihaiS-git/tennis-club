// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { AdminUserListItem } from "../../../src/lib/admin/users";

const { listAdminUsers, navigation } = vi.hoisted(() => ({ listAdminUsers: vi.fn(), navigation: { query: "" } }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn() }),
  usePathname: () => "/admin/users",
  useSearchParams: () => new URLSearchParams(navigation.query),
}));

vi.mock("../../../src/lib/admin/authorization", () => ({
  requireActiveAdmin: vi.fn().mockResolvedValue({ userId: "current-admin" }),
}));

vi.mock("../../../src/lib/admin/users", () => ({ listAdminUsers }));

import AdminUsersPage from "../../../src/app/admin/users/page";

const member: AdminUserListItem = {
  id: "84c64ef2-6925-4901-a137-f01395541411",
  email: "member@example.com",
  status: "active",
  updated_at: "2026-09-26T10:00:00+00:00",
  created_at: "2026-09-25T23:30:00-04:00",
  roles: [],
};

async function renderPage(users: AdminUserListItem[]) {
  listAdminUsers.mockResolvedValue({ users, page: 1, pageSize: 20, total: users.length, totalPages: users.length ? 1 : 0 });
  render(await AdminUsersPage({ searchParams: Promise.resolve({}) }));
}

beforeEach(() => { vi.clearAllMocks(); navigation.query = ""; });
afterEach(cleanup);

it("renders the page heading and supporting copy", async () => {
  await renderPage([]);

  expect(screen.getByRole("heading", { level: 1, name: "Users" })).toBeTruthy();
  expect(screen.getByText("Manage accounts, coaches and administrators.")).toBeTruthy();
  expect(listAdminUsers).toHaveBeenCalledOnce();
});

it("renders an active account and the UTC joined date in the table and mobile list", async () => {
  await renderPage([member]);

  for (const label of screen.getAllByText(/Last updated/)) {
    expect(label.closest("dialog")).not.toBeNull();
  }
  expect(screen.queryByRole("columnheader", { name: "Last updated" })).toBeNull();
  const table = screen.getByRole("table");
  for (const heading of ["Email", "Status", "Roles", "Joined", "Actions"]) {
    expect(within(table).getByRole("columnheader", { name: heading }).getAttribute("scope")).toBe("col");
  }
  const row = within(table).getAllByRole("row")[1];
  const cells = within(row).getAllByRole("cell");
  expect(within(cells[0]).getByText("member@example.com")).toBeTruthy();
  expect(within(cells[1]).getByText("Active")).toBeTruthy();
  expect(within(cells[2]).getByText("—")).toBeTruthy();
  expect(within(cells[3]).getByText("26 Sep 2026")).toBeTruthy();
  expect(within(row).getByRole("button", { name: "Manage" })).toBeTruthy();

  const card = screen.getByRole("article");
  expect(within(card.querySelector("p") as HTMLElement).getByText("member@example.com")).toBeTruthy();
  const details = card.querySelector("dl") as HTMLElement;
  expect(within(details).queryByText(/Last updated/)).toBeNull();
  expect(within(details).getByText("Active")).toBeTruthy();
  expect(within(details).getByText("—")).toBeTruthy();
  expect(within(details).getByText("26 Sep 2026")).toBeTruthy();
  expect(within(card).getByRole("button", { name: "Manage" })).toBeTruthy();
  expect(document.body.textContent).not.toContain(member.id);
});

it("renders every role in the returned order", async () => {
  await renderPage([{ ...member, roles: ["admin", "coach"] }]);

  const row = within(screen.getByRole("table")).getAllByRole("row")[1];
  expect(within(within(row).getAllByRole("cell")[2]).getAllByText(/^(Admin|Coach)$/).map((node) => node.textContent)).toEqual([
    "Admin", "Coach",
  ]);
});

it("renders suspended users and multiple rows", async () => {
  await renderPage([
    member,
    { ...member, id: "second-user-id", email: "coach@example.com", status: "suspended", roles: ["coach"] },
  ]);

  const rows = within(screen.getByRole("table")).getAllByRole("row");
  expect(rows).toHaveLength(3);
  expect(within(within(rows[1]).getAllByRole("cell")[0]).getByText("member@example.com")).toBeTruthy();
  expect(within(within(rows[2]).getAllByRole("cell")[0]).getByText("coach@example.com")).toBeTruthy();
  expect(within(within(rows[2]).getAllByRole("cell")[1]).getByText("Suspended")).toBeTruthy();
  expect(within(screen.getAllByRole("article")[1].querySelector("dl") as HTMLElement).getByText("Suspended")).toBeTruthy();
  expect(screen.getAllByRole("button", { name: "Manage" })).toHaveLength(4);
});

it("renders a simple empty state", async () => {
  await renderPage([]);

  expect(screen.getByText("No users found.")).toBeTruthy();
  expect(screen.queryByRole("table")).toBeNull();
  expect(screen.queryByRole("button", { name: "Manage" })).toBeNull();
});


it("passes the trusted current administrator identity to both dialog layouts", async () => {
  await renderPage([{ ...member, id: "current-admin", roles: ["admin"] }]);
  const statusButtons = screen.getAllByRole("button", { name: "Suspend user", hidden: true });
  expect(statusButtons).toHaveLength(2);
  for (const button of statusButtons) expect(button.hasAttribute("disabled")).toBe(true);
});


it("renders reactive filter controls without an Apply button", async () => {
  await renderPage([]);
  const input = screen.getByRole("searchbox", { name: "Email search" });
  expect(input.getAttribute("placeholder")).toBe("Search by email");
  expect(screen.getByRole("combobox", { name: "Status" })).toBeTruthy();
  expect(screen.getByRole("combobox", { name: "Role" })).toBeTruthy();
  expect(input.closest("form")).toBeNull();
  expect(screen.queryByRole("button", { name: "Apply" })).toBeNull();
  expect(screen.queryByRole("navigation", { name: "Pagination" })).toBeNull();
});

it("preserves filters in controls and paging links", async () => {
  listAdminUsers.mockResolvedValue({ users: [member], page: 2, pageSize: 20, total: 60, totalPages: 3 });
  navigation.query = "q=smith%2Btest&status=active&role=admin&sort=email&dir=asc&page=2";
  render(await AdminUsersPage({ searchParams: Promise.resolve({ q: "  smith+test  ", status: "active", role: "admin", sort: "email", dir: "asc", page: "2" }) }));
  expect(listAdminUsers).toHaveBeenCalledWith({ search: "smith+test", status: "active", role: "admin", page: 2, sort: "email", dir: "asc" });
  expect((screen.getByRole("searchbox") as HTMLInputElement).value).toBe("smith+test");
  expect((screen.getByRole("combobox", { name: "Status" }) as HTMLSelectElement).value).toBe("active");
  expect((screen.getByRole("combobox", { name: "Role" }) as HTMLSelectElement).value).toBe("admin");
  for (const [label, page] of [["Previous", "1"], ["Next", "3"], ["1", "1"], ["3", "3"]]) {
    const href = screen.getByRole("link", { name: label }).getAttribute("href");
    const url = new URL(href!, "http://localhost");
    expect(Object.fromEntries(url.searchParams)).toEqual({ q: "smith+test", status: "active", role: "admin", sort: "email", dir: "asc", page });
  }
  expect(screen.getByText("2").getAttribute("aria-current")).toBe("page");
  expect(screen.queryByText(/Page \d+ of/)).toBeNull();
  expect(screen.getByRole("link", { name: "Clear filters" }).getAttribute("href")).toBe("/admin/users");
});

it.each([1, 3])("makes pagination boundary unavailable on page %s", async (page) => {
  listAdminUsers.mockResolvedValue({ users: [member], page, pageSize: 20, total: 60, totalPages: 3 });
  render(await AdminUsersPage({ searchParams: Promise.resolve({ page: String(page) }) }));
  expect(screen.queryByRole("link", { name: page === 1 ? "Previous" : "Next" })).toBeNull();
  expect(screen.getByText(page === 1 ? "Previous" : "Next").closest("[aria-disabled]")?.getAttribute("aria-disabled")).toBe("true");
});

it("renders a filtered empty state with a clear link and no pagination", async () => {
  listAdminUsers.mockResolvedValue({ users: [], page: 1, pageSize: 20, total: 0, totalPages: 0 });
  navigation.query = "q=missing";
  render(await AdminUsersPage({ searchParams: Promise.resolve({ q: "missing" }) }));
  expect(screen.getByText("No users match these filters.")).toBeTruthy();
  expect(screen.getByRole("link", { name: "Clear filters" })).toBeTruthy();
  expect(screen.queryByRole("navigation", { name: "Pagination" })).toBeNull();
});

it("normalizes invalid URL filters and page without crashing", async () => {
  listAdminUsers.mockResolvedValue({ users: [], page: 1, pageSize: 20, total: 0, totalPages: 0 });
  render(await AdminUsersPage({ searchParams: Promise.resolve({ status: "bad", role: "owner", page: "-2", q: " " }) }));
  expect(listAdminUsers).toHaveBeenCalledWith({ status: undefined, role: undefined, page: 1, search: undefined, sort: "joined", dir: "desc" });
  expect(screen.getByText("No users found.")).toBeTruthy();
  expect(screen.queryByRole("link", { name: "Clear filters" })).toBeNull();
});


it.each(["email", "status", "roles", "joined"] as const)("renders and toggles %s sorting with filters preserved", async (sort) => {
  for (const dir of ["asc", "desc"] as const) {
    listAdminUsers.mockResolvedValue({ users: [member], page: 2, totalPages: 3 });
    render(await AdminUsersPage({ searchParams: Promise.resolve({ q: "smith", status: "active", role: "coach", page: "2", sort, dir }) }));
    const headings = within(screen.getByRole("table")).getAllByRole("columnheader");
    for (const column of ["email", "status", "roles", "joined"]) {
      const header = headings.find((h) => h.textContent?.toLowerCase() === column)!;
      const active = column === sort;
      expect(header.getAttribute("aria-sort")).toBe(active ? dir === "asc" ? "ascending" : "descending" : "none");
      expect(header.querySelector("svg")?.classList.contains(active ? dir === "asc" ? "lucide-arrow-up" : "lucide-arrow-down" : "lucide-arrow-up-down")).toBe(true);
      const href = within(header).getByRole("link").getAttribute("href")!;
      expect(Object.fromEntries(new URL(href, "http://localhost").searchParams)).toEqual({
        q: "smith", status: "active", role: "coach", sort: column,
        dir: active ? dir === "asc" ? "desc" : "asc" : column === "joined" ? "desc" : "asc",
      });
    }
    expect(within(headings[4]).queryByRole("link")).toBeNull();
    cleanup();
  }
});

it("uses the corrected server page for the current page and navigation", async () => {
  listAdminUsers.mockResolvedValue({ users: [member], page: 3, pageSize: 20, total: 60, totalPages: 3 });
  render(await AdminUsersPage({ searchParams: Promise.resolve({ page: "9999", q: "smith", sort: "roles", dir: "asc" }) }));
  const nav = screen.getByRole("navigation", { name: "Pagination" });
  expect(nav.querySelector('[aria-current="page"]')?.textContent).toBe("3");
  expect(within(nav).queryByRole("link", { name: "Next" })).toBeNull();
  expect(Object.fromEntries(new URL(within(nav).getByRole("link", { name: "Previous" }).getAttribute("href")!, "http://localhost").searchParams))
    .toEqual({ q: "smith", sort: "roles", dir: "asc", page: "2" });
});
