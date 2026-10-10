// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({ pathname: "/admin/locations", push: vi.fn(), redirect: vi.fn(), requireActiveAdmin: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: navigation.redirect, usePathname: () => navigation.pathname, useRouter: () => ({ push: navigation.push }) }));
vi.mock("../../src/lib/admin/authorization", () => ({ requireActiveAdmin: navigation.requireActiveAdmin }));
import { AdminNavigation } from "../../src/components/admin-navigation";
import PaymentsLayout from "../../src/app/admin/payments/layout";
import AdminPage from "../../src/app/admin/page";
import { PricingLocationSelect } from "../../src/app/admin/pricing/location-select";

afterEach(() => { cleanup(); vi.clearAllMocks(); });

it.each([
  ["/admin/locations", "Locations"],
  ["/admin/locations/new", "Locations"],
  ["/admin/locations/location-id", "Locations"],
  ["/admin/payments", "Payments"],
  ["/admin/payments/settings", "Payments"],
  ["/admin/users", "Users"],
  ["/admin/users/user-id", "Users"],
])("activates only %s's primary section", (pathname, label) => {
  navigation.pathname = pathname;
  render(<AdminNavigation />);
  const nav = screen.getByRole("navigation", { name: "Admin navigation" });
  const links = within(nav).getAllByRole("link");
  expect(links.map((link) => link.textContent)).toEqual(["Locations", "Payments", "Users"]);
  expect(links.map((link) => link.getAttribute("href"))).toEqual(["/admin/locations", "/admin/payments", "/admin/users"]);
  expect(nav.className).toContain("sm:grid-cols-3");
  expect(nav.className).toContain("overflow-x-auto");
  for (const link of links) {
    expect(link.getAttribute("aria-current")).toBe(link.textContent === label ? "page" : null);
    expect(link.className.includes("bg-primary text-primary-foreground")).toBe(link.textContent === label);
    expect(link.className).toContain("focus-visible:outline-2");
  }
});

it.each(["/admin", "/admin/locations-extra", "/admin/payments-extra", "/admin/users-extra", "/administrator", "/admin/unknown"])(
  "does not activate a section for unrelated pathname %s", (pathname) => {
    navigation.pathname = pathname;
    render(<AdminNavigation />);
    expect(screen.getAllByRole("link").every((link) => !link.hasAttribute("aria-current"))).toBe(true);
  },
);

it.each(["details", "opening-hours", "courts", "pricing", "public-booking"])(
  "keeps Locations active for workspace tab %s", (tab) => {
    navigation.pathname = "/admin/locations/location-id";
    window.history.replaceState(null, "", `${navigation.pathname}?tab=${tab}`);
    render(<AdminNavigation />);
    expect(screen.getByRole("link", { name: "Locations" }).getAttribute("aria-current")).toBe("page");
  },
);

it.each([
  ["/admin/payments", "Transactions", "Settings"],
  ["/admin/payments/settings", "Settings", "Transactions"],
])("keeps Payments active on %s with the correct secondary tab", (pathname, active, inactive) => {
  navigation.pathname = pathname;
  render(<><AdminNavigation /><PaymentsLayout><p>Settings content</p></PaymentsLayout></>);
  expect(screen.getByRole("link", { name: "Payments" }).getAttribute("aria-current")).toBe("page");
  expect(screen.getByRole("link", { name: active }).getAttribute("aria-current")).toBe("page");
  expect(screen.getByRole("link", { name: inactive }).hasAttribute("aria-current")).toBe(false);
});

it("redirects the Admin entry route to Locations after authorization", async () => {
  await AdminPage();
  expect(navigation.requireActiveAdmin).toHaveBeenCalledOnce();
  expect(navigation.redirect).toHaveBeenCalledExactlyOnceWith("/admin/locations");
  expect(navigation.requireActiveAdmin.mock.invocationCallOrder[0]).toBeLessThan(navigation.redirect.mock.invocationCallOrder[0]);
});

it("does not redirect when Admin authorization rejects access", async () => {
  navigation.requireActiveAdmin.mockRejectedValueOnce(new Error("Unauthorized"));
  await expect(AdminPage()).rejects.toThrow("Unauthorized");
  expect(navigation.redirect).not.toHaveBeenCalled();
});

it("navigates pricing location selection directly to the workspace tab", () => {
  const id = "a1000000-0000-4000-8000-000000000001";
  render(<PricingLocationSelect locations={[{ id, name: "Central", is_active: true }]} />);
  fireEvent.change(screen.getByRole("combobox", { name: "Location" }), { target: { value: id } });
  expect(navigation.push).toHaveBeenLastCalledWith(`/admin/locations/${id}?tab=pricing`);
  fireEvent.change(screen.getByRole("combobox", { name: "Location" }), { target: { value: "" } });
  expect(navigation.push).toHaveBeenLastCalledWith("/admin/locations");
});
