// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { UsersToolbar } from "../../../src/app/admin/users/users-toolbar";

const navigation = vi.hoisted(() => ({ query: "", replace: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: navigation.replace }),
  usePathname: () => "/admin/users",
  useSearchParams: () => new URLSearchParams(navigation.query),
}));
beforeEach(() => { vi.useFakeTimers(); navigation.query = "q=old&status=active&role=coach&sort=email&dir=asc&page=3"; navigation.replace.mockClear(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });
function params() { return Object.fromEntries(new URL(navigation.replace.mock.lastCall![0], "http://localhost").searchParams); }

it("composes consecutive filter changes before the URL finishes updating", () => {
  render(<UsersToolbar />);
  fireEvent.change(screen.getByRole("combobox", { name: "Status" }), { target: { value: "suspended" } });
  fireEvent.change(screen.getByRole("combobox", { name: "Role" }), { target: { value: "admin" } });
  expect(params()).toMatchObject({ status: "suspended", role: "admin" });
});

it("debounces search, resets the page and preserves current sort and filters", () => {
  render(<UsersToolbar />);
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "  new@example.test  " } });
  expect(navigation.replace).not.toHaveBeenCalled();
  vi.advanceTimersByTime(350);
  expect(params()).toEqual({ q: "new@example.test", status: "active", role: "coach", sort: "email", dir: "asc" });
});

it("resets the search draft after Back/Forward and links Clear filters to the clean URL", () => {
  const { rerender } = render(<UsersToolbar />);
  navigation.query = "q=restored";
  rerender(<UsersToolbar />);
  expect((screen.getByRole("searchbox") as HTMLInputElement).value).toBe("restored");
  expect(screen.getByRole("link", { name: "Clear filters" }).getAttribute("href")).toBe("/admin/users");
});
