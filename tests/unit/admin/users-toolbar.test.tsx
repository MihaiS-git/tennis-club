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
