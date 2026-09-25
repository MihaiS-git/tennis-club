// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { AdminUserListItem } from "../../../src/lib/admin/users";

const { listAdminUsers } = vi.hoisted(() => ({ listAdminUsers: vi.fn() }));

vi.mock("../../../src/lib/admin/users", () => ({ listAdminUsers }));

import AdminUsersPage from "../../../src/app/admin/users/page";

const member: AdminUserListItem = {
  id: "84c64ef2-6925-4901-a137-f01395541411",
  email: "member@example.com",
  status: "active",
  created_at: "2026-09-25T23:30:00-04:00",
  roles: ["member"],
};

async function renderPage(users: AdminUserListItem[]) {
  listAdminUsers.mockResolvedValue(users);
  render(await AdminUsersPage());
}

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

it("renders the page heading and supporting copy", async () => {
  await renderPage([]);

  expect(screen.getByRole("heading", { level: 1, name: "Users" })).toBeTruthy();
  expect(screen.getByText("Manage club members, coaches and administrators.")).toBeTruthy();
  expect(listAdminUsers).toHaveBeenCalledOnce();
});

it("renders an active member and the UTC joined date in the table and mobile list", async () => {
  await renderPage([member]);

  const table = screen.getByRole("table");
  for (const heading of ["Email", "Status", "Roles", "Joined"]) {
    expect(within(table).getByRole("columnheader", { name: heading }).getAttribute("scope")).toBe("col");
  }
  const row = within(table).getAllByRole("row")[1];
  expect(within(row).getByText("member@example.com")).toBeTruthy();
  expect(within(row).getByText("Active")).toBeTruthy();
  expect(within(row).getByText("Member")).toBeTruthy();
  expect(within(row).getByText("26 Sep 2026")).toBeTruthy();

  const card = screen.getByRole("article");
  expect(within(card).getByText("member@example.com")).toBeTruthy();
  expect(within(card).getByText("Active")).toBeTruthy();
  expect(within(card).getByText("Member")).toBeTruthy();
  expect(within(card).getByText("26 Sep 2026")).toBeTruthy();
  expect(document.body.textContent).not.toContain(member.id);
});

it("renders every role in the returned order", async () => {
  await renderPage([{ ...member, roles: ["admin", "coach", "member"] }]);

  const row = within(screen.getByRole("table")).getAllByRole("row")[1];
  expect(within(row).getAllByText(/^(Admin|Coach|Member)$/).map((node) => node.textContent)).toEqual([
    "Admin", "Coach", "Member",
  ]);
});

it("renders suspended users and multiple rows", async () => {
  await renderPage([
    member,
    { ...member, id: "second-user-id", email: "coach@example.com", status: "suspended", roles: ["coach"] },
  ]);

  const rows = within(screen.getByRole("table")).getAllByRole("row");
  expect(rows).toHaveLength(3);
  expect(within(rows[1]).getByText("member@example.com")).toBeTruthy();
  expect(within(rows[2]).getByText("coach@example.com")).toBeTruthy();
  expect(within(rows[2]).getByText("Suspended")).toBeTruthy();
  expect(within(screen.getAllByRole("article")[1]).getByText("Suspended")).toBeTruthy();
});

it("renders a simple empty state", async () => {
  await renderPage([]);

  expect(screen.getByText("No users found.")).toBeTruthy();
  expect(screen.queryByRole("table")).toBeNull();
});
