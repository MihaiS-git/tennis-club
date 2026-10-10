// @vitest-environment jsdom
import { useSyncExternalStore } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AdminUserDetails } from "../../src/lib/admin/users";
import { installDialogMock } from "../helpers/dialog";

const mocks = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn(), details: vi.fn(), authorize: vi.fn(), status: vi.fn(), role: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push, refresh: mocks.refresh }),
  usePathname: () => window.location.pathname,
  useSearchParams: () => new URLSearchParams(useSyncExternalStore(
    (callback) => { window.addEventListener("popstate", callback); return () => window.removeEventListener("popstate", callback); },
    () => window.location.search,
  )),
  notFound: () => { throw new Error("not-found"); },
}));
vi.mock("../../src/lib/admin/users", () => ({ readAdminUserDetails: mocks.details }));
vi.mock("../../src/lib/admin/authorization", () => ({ requireActiveAdmin: mocks.authorize }));
vi.mock("../../src/app/admin/users/actions", () => ({ updateUserStatusAction: mocks.status, updateUserRoleAction: mocks.role }));
import UserManagementPage from "../../src/app/admin/users/[userId]/page";
import { UserWorkspace } from "../../src/app/admin/users/user-workspace";
import { UserItem } from "../../src/app/admin/users/user-item";
import { AdminNavigation } from "../../src/components/admin-navigation";

const user: AdminUserDetails = {
  id: "84c64ef2-6925-4901-a137-f01395541411", email: "member@example.com", status: "active", roles: ["coach"],
  created_at: "2026-09-25T00:00:00Z", updated_at: "2026-09-26T00:00:00Z",
  personal: { first_name: "Alex", last_name: "Player", phone: "+40712345678", date_of_birth: "1990-05-10",
    address_line1: "10 Court Street", address_line2: "Apartment 2", city: "Bucharest", postal_code: "010101", country_code: "RO" },
  player: { display_name: "Ace Alex", avatar_path: "84c64ef2-6925-4901-a137-f01395541411/avatar.webp", sportya_level: "6",
    rating: 1450, handedness: "left", backhand: "two_handed", preferred_game: "both", preferred_surface: "clay",
    bio: "Enjoys competitive tennis.", updated_at: "2026-09-26T00:00:00Z" },
};
const pathname = `/admin/users/${user.id}`;
function navigate(query: string) {
  act(() => { window.history.replaceState(null, "", `${pathname}${query}`); window.dispatchEvent(new PopStateEvent("popstate")); });
}
async function page(details = user) {
  mocks.details.mockResolvedValue(details);
  return render(await UserManagementPage({ params: Promise.resolve({ userId: user.id }), searchParams: Promise.resolve({ q: "member", sort: "email", dir: "asc", page: "2" }) }));
}
beforeEach(() => {
  vi.clearAllMocks();
  installDialogMock();
  mocks.authorize.mockResolvedValue({ userId: "other-admin" });
  window.history.replaceState(null, "", pathname);
});
afterEach(cleanup);

it.each([false, true])("navigates user rows by pointer and keyboard and preserves table query (mobile=%s)", (mobile) => {
  window.history.replaceState(null, "", "/admin/users?q=member&role=coach&status=active&sort=email&dir=asc&page=2");
  render(mobile ? <UserItem user={user} mobile /> : <table><tbody><UserItem user={user} /></tbody></table>);
  const row = screen.getByRole(mobile ? "button" : "row", { name: `Manage user ${user.email}` });
  const href = `${pathname}?q=member&role=coach&status=active&sort=email&dir=asc&page=2`;
  expect(screen.getByRole("link", { name: user.email }).getAttribute("href")).toBe(href);
  fireEvent.click(row);
  fireEvent.keyDown(row, { key: "Enter" });
  fireEvent.keyDown(row, { key: " " });
  expect(mocks.push).toHaveBeenCalledTimes(3);
  expect(mocks.push).toHaveBeenLastCalledWith(href);
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("loads the authoritative details once and shows identity, account, without a redundant return link", async () => {
  await page();
  expect(mocks.details).toHaveBeenCalledExactlyOnceWith(user.id);
  expect(screen.getByRole("heading", { name: "Alex Player" })).toBeTruthy();
  expect(screen.queryByRole("link", { name: "Back to users" })).toBeNull();
  expect(screen.getByRole("region", { name: "Account & access" })).toBeTruthy();
  expect(screen.queryByRole("region", { name: "Personal profile" })).toBeNull();
  expect(screen.getByText("Joined").nextElementSibling?.textContent).toBe("25 Sep 2026");
  expect(screen.getByText("Last updated").nextElementSibling?.textContent).toBe("26 Sep 2026");
});

it.each(["?tab=unknown", "?tab=tennis&tab=personal", ""])("defaults invalid or missing tab %s to Account & access", async (query) => {
  navigate(query);
  await page();
  expect(screen.getByRole("link", { name: "Account & access" }).getAttribute("aria-current")).toBe("page");
});

it("uses URL-backed tabs, handles refreshed selection and popstate, and keeps Users active", async () => {
  navigate("?q=member&page=2&tab=personal");
  const view = await page();
  render(<AdminNavigation />);
  const nav = screen.getByRole("navigation", { name: "User management" });
  expect(within(nav).getAllByRole("link")).toHaveLength(3);
  expect(within(nav).getByRole("link", { name: "Tennis profile" }).getAttribute("href")).toBe(`${pathname}?q=member&page=2&tab=tennis`);
  for (const value of ["+40712345678", "10 May 1990", "10 Court Street", "Apartment 2", "Bucharest", "010101", "Romania"]) {
    expect(screen.getByText(value)).toBeTruthy();
  }
  expect(screen.queryByRole("textbox")).toBeNull();
  navigate("?tab=tennis");
  for (const value of ["Ace Alex", "6", "1450", "Left-handed", "Two-handed", "Both", "Clay", "Enjoys competitive tennis."]) {
    expect(screen.getByText(value)).toBeTruthy();
  }
  view.rerender(<UserWorkspace user={user} currentAdminId="other-admin" />);
  expect(screen.getByRole("region", { name: "Tennis profile" })).toBeTruthy();
  navigate("?tab=personal");
  expect(screen.getByRole("region", { name: "Personal profile" })).toBeTruthy();
  navigate("?tab=tennis");
  expect(screen.getByRole("link", { name: "Users" }).getAttribute("aria-current")).toBe("page");
});

it("shows the complete private avatar with intrinsic aspect ratio and without clipping", async () => {
  navigate("?tab=tennis");
  await page();
  const image = screen.getByRole("img", { name: "User avatar" });
  expect(image.getAttribute("src")).toBe(`${pathname}/avatar?v=${encodeURIComponent(user.player!.updated_at)}`);
  expect(image.className).toContain("object-contain");
  expect(image.className).toContain("h-auto");
  expect(image.className).toContain("w-auto");
  expect(image.className).toContain("max-w-full");
  expect(image.className).not.toMatch(/rounded|object-cover|clip/);
  expect(image.hasAttribute("width")).toBe(false);
  expect(image.hasAttribute("height")).toBe(false);
  fireEvent.error(image);
  expect(screen.getByText("Avatar unavailable")).toBeTruthy();
});

it("handles incomplete profiles and identity fallbacks", async () => {
  const incomplete = { ...user, personal: { ...user.personal, first_name: null, last_name: null }, player: null };
  navigate("?tab=tennis");
  await page(incomplete);
  expect(screen.getByRole("heading", { name: user.email })).toBeTruthy();
  expect(screen.getByText("No avatar uploaded")).toBeTruthy();
  expect(screen.getAllByText("—").length).toBeGreaterThan(5);
});

it("refreshes after suspension/reactivation and updates controls from fresh server data", async () => {
  mocks.status.mockResolvedValueOnce({ ok: true, user: { id: user.id, status: "suspended" } })
    .mockResolvedValueOnce({ ok: true, user: { id: user.id, status: "active" } });
  const view = await page();
  fireEvent.click(screen.getByRole("button", { name: "Suspend user" }));
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Suspend user" }));
  await waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(1));
  expect(screen.getByRole("button", { name: "Reactivate user" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Reactivate user" }));
  await waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(2));
  view.rerender(<UserWorkspace user={{ ...user, status: "suspended", roles: ["admin"] }} currentAdminId="other-admin" />);
  expect(screen.getByRole("button", { name: "Reactivate user" })).toBeTruthy();
  expect(within(screen.getByText("Admin").closest("li")!).getByRole("button", { name: "Remove" })).toBeTruthy();
});

it("rejects malformed, missing and unauthorized user reads", async () => {
  await expect(UserManagementPage({ params: Promise.resolve({ userId: "invalid" }), searchParams: Promise.resolve({}) })).rejects.toThrow("not-found");
  expect(mocks.details).not.toHaveBeenCalled();
  mocks.details.mockResolvedValue(null);
  await expect(UserManagementPage({ params: Promise.resolve({ userId: user.id }), searchParams: Promise.resolve({}) })).rejects.toThrow("not-found");
  mocks.authorize.mockRejectedValue(new Error("not-found"));
  mocks.details.mockClear();
  await expect(UserManagementPage({ params: Promise.resolve({ userId: user.id }), searchParams: Promise.resolve({}) })).rejects.toThrow("not-found");
  expect(mocks.details).not.toHaveBeenCalled();
});
