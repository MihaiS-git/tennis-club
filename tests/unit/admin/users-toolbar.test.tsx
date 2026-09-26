// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
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
function type(text: string) { fireEvent.change(screen.getByRole("searchbox"), { target: { value: text } }); }
function tick(ms: number) { act(() => vi.advanceTimersByTime(ms)); }

it("has no Apply button", () => {
  render(<UsersToolbar />);
  expect(screen.queryByRole("button", { name: "Apply" })).toBeNull();
});
it("keeps a permanent desktop clear slot with no inactive link", () => {
  navigation.query = "";
  const view = render(<UsersToolbar />);
  const toolbar = view.container.firstElementChild!;
  const slot = toolbar.lastElementChild!;
  expect(toolbar.classList.contains("lg:grid")).toBe(true);
  expect(toolbar.classList.contains("lg:grid-cols-[minmax(320px,1fr)_144px_112px_96px]")).toBe(true);
  expect(toolbar.children).toHaveLength(4);
  expect(slot.classList.contains("lg:flex")).toBe(true);
  expect(slot.children).toHaveLength(0);
  expect(screen.queryByRole("link", { name: "Clear filters" })).toBeNull();

  navigation.query = "status=active";
  view.rerender(<UsersToolbar />);
  expect(toolbar.lastElementChild).toBe(slot);
  expect(screen.getByRole("link", { name: "Clear filters" }).parentElement).toBe(slot);

  navigation.query = "";
  view.rerender(<UsersToolbar />);
  expect(toolbar.lastElementChild).toBe(slot);
  expect(slot.children).toHaveLength(0);
});
it.each([["Status", "status", "suspended"], ["Role", "role", "admin"]])("applies %s immediately, preserving other params and removing page", (label, key, value) => {
  render(<UsersToolbar />);
  fireEvent.change(screen.getByRole("combobox", { name: label }), { target: { value } });
  expect(params()).toEqual({ q: "old", status: "active", role: "coach", sort: "email", dir: "asc", [key]: value });
  expect(navigation.replace.mock.lastCall![1]).toEqual({ scroll: false });
});
it("debounces for exactly 350ms and trims surrounding whitespace", () => {
  render(<UsersToolbar />); type("  smith  ");
  expect(navigation.replace).not.toHaveBeenCalled(); tick(349);
  expect(navigation.replace).not.toHaveBeenCalled(); tick(1);
  expect(params()).toEqual({ q: "smith", status: "active", role: "coach", sort: "email", dir: "asc" });
});
it("continued typing restarts the debounce", () => {
  render(<UsersToolbar />); type("s"); tick(300); type("sm"); tick(349);
  expect(navigation.replace).not.toHaveBeenCalled(); tick(1);
  expect(params().q).toBe("sm"); expect(navigation.replace).toHaveBeenCalledOnce();
});
it("clearing search removes q", () => {
  render(<UsersToolbar />); type("  "); tick(350);
  expect(params()).toEqual({ status: "active", role: "coach", sort: "email", dir: "asc" });
});
it("synchronizes external URL navigation and cancels stale search even if q stays unchanged", () => {
  const view = render(<UsersToolbar />); type("stale"); tick(100);
  navigation.query = "q=old&role=admin"; view.rerender(<UsersToolbar />);
  expect((screen.getByRole("searchbox") as HTMLInputElement).value).toBe("old");
  tick(350); expect(navigation.replace).not.toHaveBeenCalled();
  navigation.query = "q=old&status=active&role=coach&sort=email&dir=asc&page=3"; view.rerender(<UsersToolbar />);
  expect((screen.getByRole("searchbox") as HTMLInputElement).value).toBe("old");
  navigation.query = "q=back"; view.rerender(<UsersToolbar />);
  expect((screen.getByRole("searchbox") as HTMLInputElement).value).toBe("back");
  navigation.query = ""; view.rerender(<UsersToolbar />);
  expect((screen.getByRole("searchbox") as HTMLInputElement).value).toBe("");
});
it("cancels search on unmount", () => {
  const view = render(<UsersToolbar />); type("stale"); view.unmount(); tick(350);
  expect(navigation.replace).not.toHaveBeenCalled();
});
it("immediate filter changes cancel an older search", () => {
  render(<UsersToolbar />); type("stale");
  fireEvent.change(screen.getByRole("combobox", { name: "Role" }), { target: { value: "admin" } }); tick(350);
  expect(navigation.replace).toHaveBeenCalledOnce(); expect(params().q).toBe("old");
});
it("composes consecutive filter changes before the URL finishes updating", () => {
  render(<UsersToolbar />);
  fireEvent.change(screen.getByRole("combobox", { name: "Status" }), { target: { value: "suspended" } });
  fireEvent.change(screen.getByRole("combobox", { name: "Role" }), { target: { value: "admin" } });
  expect(params()).toMatchObject({ status: "suspended", role: "admin" });
});
it("clears filters with the existing default URL and cancels search", () => {
  render(<UsersToolbar />); type("stale");
  const link = screen.getByRole("link", { name: "Clear filters" });
  expect(link.getAttribute("href")).toBe("/admin/users");
  fireEvent.click(link); tick(350); expect(navigation.replace).not.toHaveBeenCalled();
});

it("offers only All roles, Coach, and Admin", () => {
  render(<UsersToolbar />);
  const select = screen.getByRole("combobox", { name: "Role" });
  expect([...select.querySelectorAll("option")].map((option) => option.textContent)).toEqual(["All roles", "Coach", "Admin"]);
});
