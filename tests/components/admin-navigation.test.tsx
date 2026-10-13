// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({ pathname: "/admin/locations", push: vi.fn(), redirect: vi.fn(), requireActiveAdmin: vi.fn(), requireReservationRole: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: navigation.redirect, usePathname: () => navigation.pathname, useRouter: () => ({ push: navigation.push }) }));
vi.mock("../../src/lib/admin/authorization", () => ({ requireActiveAdmin: navigation.requireActiveAdmin }));
vi.mock("../../src/lib/reservations/authorization", () => ({ requireReservationRole: navigation.requireReservationRole }));
vi.mock("../../src/lib/supabase/server", () => ({ createClient: vi.fn() }));
import { AdminNavigation } from "../../src/components/admin-navigation";
import PaymentsLayout from "../../src/app/admin/payments/layout";
import AdminPage from "../../src/app/admin/page";
import { PricingLocationSelect } from "../../src/app/admin/pricing/location-select";

afterEach(() => { cleanup(); vi.clearAllMocks(); });

it.each([
  ["/admin/locations", "Locations"],
  ["/admin/locations/new", "Locations"],
  ["/admin/locations/location-id", "Locations"],
  ["/admin/payments/transactions", "Transactions"],
  ["/admin/payments/transactions/refund/transaction-id", "Transactions"],
  ["/admin/payments/settings", "Settings"],
  ["/admin/reservations", "Reservations"],
  ["/admin/reservations/day", "Reservations"],
  ["/admin/users", "Users"],
  ["/admin/users/user-id", "Users"],
])("activates only %s's primary section", (pathname, label) => {
  navigation.pathname = pathname;
  render(<AdminNavigation />);
  const nav = screen.getByRole("navigation", { name: "Management navigation" });
  const links = within(nav).getAllByRole("link");
  expect(links.map((link) => link.textContent)).toEqual(["Locations", "Reservations", "Transactions", "Settings", "Users"]);
  expect(links.map((link) => link.getAttribute("href"))).toEqual(["/admin/locations", "/admin/reservations", "/admin/payments/transactions", "/admin/payments/settings", "/admin/users"]);
  for (const link of links) {
    expect(link.getAttribute("aria-current")).toBe(link.textContent === label ? "page" : null);
    expect(link.className.includes("bg-primary text-primary-foreground")).toBe(link.textContent === label);
    expect(link.className).toContain("focus-visible:outline-2");
  }
});

it.each(["/admin", "/admin/locations-extra", "/admin/payments-extra", "/admin/users-extra", "/administrator", "/admin/unknown", "/admin/reservations-extra"])(
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
  ["/admin/payments/transactions", "Transactions", "Settings"],
  ["/admin/payments/settings", "Settings", "Transactions"],
])("keeps Payments active on %s with the correct secondary tab", async (pathname, active, inactive) => {
  navigation.pathname = pathname;
  render(<><AdminNavigation />{await PaymentsLayout({ children: <p>Settings content</p> })}</>);
  expect(screen.queryByRole("link", { name: "Payments" })).toBeNull();
  expect(within(screen.getByRole("navigation", { name: "Management navigation" })).getByText("Payments").className).toContain("text-primary");
  expect(screen.queryByRole("navigation", { name: "Payments navigation" })).toBeNull();
  expect(screen.getByRole("link", { name: active }).getAttribute("aria-current")).toBe("page");
  expect(screen.getByRole("link", { name: inactive }).hasAttribute("aria-current")).toBe(false);
});

it("redirects the Admin entry route to Locations after authorization", async () => {
  navigation.requireReservationRole.mockResolvedValue({ roles: ["admin"] });
  await AdminPage();
  expect(navigation.requireReservationRole).toHaveBeenCalledOnce();
  expect(navigation.redirect).toHaveBeenCalledExactlyOnceWith("/admin/locations");
  expect(navigation.requireReservationRole.mock.invocationCallOrder[0]).toBeLessThan(navigation.redirect.mock.invocationCallOrder[0]);
});

it("does not redirect when Admin authorization rejects access", async () => {
  navigation.requireReservationRole.mockRejectedValueOnce(new Error("Unauthorized"));
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

it("shows only Reservations to Coaches", () => {
  navigation.pathname = "/admin/reservations";
  render(<AdminNavigation isAdmin={false} />);
  const nav = screen.getByRole("navigation", { name: "Management navigation" });
  expect(within(nav).getAllByRole("link").map((link) => link.textContent)).toEqual(["Reservations"]);
});

it("closes the drawer with Escape and restores focus", () => {
  render(<AdminNavigation />);
  const trigger = screen.getByRole("button", { name: "Management menu" });
  fireEvent.click(trigger);
  const drawer = screen.getByRole("dialog", { name: "Management menu" });
  const close = within(drawer).getByRole("button", { name: "Close management menu" });
  expect(document.activeElement).toBe(close);
  const last = within(drawer).getByRole("link", { name: "Users" });
  fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
  expect(document.activeElement).toBe(last);
  fireEvent.keyDown(last, { key: "Tab" });
  expect(document.activeElement).toBe(close);
  fireEvent.keyDown(window, { key: "Escape" });
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  expect(document.activeElement).toBe(trigger);
  expect(document.body.style.overflow).toBe("");
});

it("closes after navigation and browser route changes", () => {
  const { rerender } = render(<AdminNavigation />);
  fireEvent.click(screen.getByRole("button", { name: "Management menu" }));
  fireEvent.click(screen.getByRole("link", { name: "Users" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Management menu" }));
  navigation.pathname = "/admin/payments/settings";
  rerender(<AdminNavigation />);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.getByRole("link", { name: "Settings" }).getAttribute("aria-current")).toBe("page");
});

it("redirects the Coach entry route to Reservations after authorization", async () => {
  navigation.requireReservationRole.mockResolvedValue({ roles: ["coach"] });
  await AdminPage();
  expect(navigation.redirect).toHaveBeenCalledExactlyOnceWith("/admin/reservations");
});
