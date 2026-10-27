// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { UsersToolbar } from "@/app/admin/users/users-toolbar";
import { TransactionsToolbar } from "@/app/admin/payments/transactions-toolbar";
import { BookingsToolbar } from "@/app/admin/bookings/bookings-toolbar";
import { CourtsToolbar } from "@/app/admin/courts/courts-toolbar";

const navigation = vi.hoisted(() => ({ query: "", pathname: "/" }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn() }),
  usePathname: () => navigation.pathname,
  useSearchParams: () => new URLSearchParams(navigation.query),
}));
vi.mock("@/app/admin/courts/court-dialog", () => ({ CourtDialog: () => <button type="button">Add court</button> }));
afterEach(cleanup);

const location = "11111111-1111-4111-8111-111111111111";
const toolbars: [string, string, () => ReactElement, string, string][] = [
  ["Users", "/admin/users", () => <UsersToolbar />, "", "status=active"],
  ["Transactions", "/admin/payments", () => <TransactionsToolbar />, "status=all&provider=all&method=all&attention=all", "provider=stripe"],
  ["Bookings", "/admin/bookings", () => <BookingsToolbar locations={[{ id: location, name: "Central", archived: false, courts: [] }]} />,
    "type=all&status=all", "type=court"],
  ["Courts", "/admin/courts", () => <CourtsToolbar locations={[{ id: location, name: "Central", is_active: true }]} selectedId={location} />,
    `location=${location}&sort=name&dir=asc`, `location=${location}&surface=clay`],
];

// The structural layout (every element and its classes) must be identical with and without Clear.
// Option lists are content, not layout: some (such as Status) legitimately depend on the selected Type.
function layout(container: HTMLElement) {
  return [...container.querySelectorAll(":not(option)")].filter((element) => !element.closest("[data-filter-clear-slot]"))
    .map((element) => `${element.tagName}.${element.getAttribute("class") ?? ""}`);
}

it.each(toolbars)("%s toolbar reserves the Clear slot and keeps its inputs fixed when Clear appears", (_, pathname, toolbar, defaults, active) => {
  navigation.pathname = pathname;
  navigation.query = "";
  const { container, rerender } = render(toolbar());
  const slot = container.querySelector("[data-filter-clear-slot]")!;
  expect(slot).toBeTruthy();
  expect(slot.children).toHaveLength(0);
  const inactiveLayout = layout(container);

  navigation.query = defaults;
  rerender(toolbar());
  expect(screen.queryByRole("link", { name: "Clear filters" })).toBeNull();
  expect(layout(container)).toEqual(inactiveLayout);

  navigation.query = active;
  rerender(toolbar());
  const clear = screen.getByRole("link", { name: "Clear filters" });
  expect(container.querySelector("[data-filter-clear-slot]")).toBe(slot);
  expect(slot.contains(clear)).toBe(true);
  expect(layout(container)).toEqual(inactiveLayout);
});

// Choosing the Coaching type enables Coach in its reserved column instead of inserting one.
it("Bookings toolbar keeps its filter layout when Type changes to Coaching", () => {
  navigation.pathname = "/admin/bookings";
  navigation.query = "type=court";
  const toolbar = () => <BookingsToolbar locations={[{ id: location, name: "Central", archived: false, courts: [] }]}
    coaches={[{ id: location, name: "Coach" }]} />;
  const { container, rerender } = render(toolbar());
  const before = layout(container);
  navigation.query = "type=coaching";
  rerender(toolbar());
  expect(screen.getByRole<HTMLSelectElement>("combobox", { name: "Coach" }).disabled).toBe(false);
  expect(layout(container)).toEqual(before);
});
