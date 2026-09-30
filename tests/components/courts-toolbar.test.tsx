// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CourtsToolbar } from "../../src/app/admin/courts/courts-toolbar";

const navigation = vi.hoisted(() => ({ query: "", replace: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: navigation.replace, push: navigation.push }),
  usePathname: () => "/admin/courts",
  useSearchParams: () => new URLSearchParams(navigation.query),
}));

const locations = [
  { id: "c3000000-0000-4000-8000-000000000001", name: "Central", is_active: true },
  { id: "c3000000-0000-4000-8000-000000000002", name: "North", is_active: false },
];
const toolbarProps = { locations, selectedId: locations[0].id, selectedName: locations[0].name, selectedActive: true, courtCount: 4 };

beforeEach(() => {
  navigation.query = `location=${locations[0].id}&status=active&sort=lighting&dir=desc`;
  navigation.replace.mockClear(); navigation.push.mockClear();
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new Event("close")); };
});
afterEach(cleanup);

it("applies combined court filters immediately and keeps the current sort", () => {
  render(<CourtsToolbar {...toolbarProps} />);
  fireEvent.change(screen.getByRole("combobox", { name: "Surface" }), { target: { value: "hard" } });
  fireEvent.change(screen.getByRole("combobox", { name: "Environment" }), { target: { value: "indoor" } });
  const url = new URL(navigation.replace.mock.lastCall![0], "http://localhost");
  expect(Object.fromEntries(url.searchParams)).toEqual({ location: locations[0].id, status: "active", surface: "hard", environment: "indoor", sort: "lighting", dir: "desc" });
  expect(navigation.replace.mock.lastCall![1]).toEqual({ scroll: false });
  expect(screen.queryByRole("button", { name: "Apply" })).toBeNull();
  expect(screen.queryByRole("searchbox")).toBeNull();
});

it("offers the requested filter options and a clear link", () => {
  render(<CourtsToolbar {...toolbarProps} />);
  expect([...screen.getByRole("combobox", { name: "Status" }).querySelectorAll("option")].map((option) => option.textContent)).toEqual(["All statuses", "Active", "Inactive"]);
  expect([...screen.getByRole("combobox", { name: "Surface" }).querySelectorAll("option")].map((option) => option.textContent)).toEqual(["All surfaces", "Clay", "Hard", "Grass", "Carpet"]);
  expect([...screen.getByRole("combobox", { name: "Environment" }).querySelectorAll("option")].map((option) => option.textContent)).toEqual(["All environments", "Outdoor", "Indoor"]);
  expect(screen.getByRole("link", { name: "Clear filters" }).getAttribute("href")).toBe(`/admin/courts?location=${locations[0].id}`);
});

it("keeps Location and Create court together and navigates to the selected location", () => {
  render(<CourtsToolbar {...toolbarProps} />);
  const location = screen.getByRole("combobox", { name: "Location" });
  const create = screen.getByRole("button", { name: "Create court" });
  const toolbar = location.closest("div");
  expect(toolbar?.contains(create)).toBe(true);
  for (const name of ["Status", "Surface", "Environment"]) {
    expect(toolbar?.contains(screen.getByRole("combobox", { name }))).toBe(true);
  }
  expect([...location.querySelectorAll("option")].map((option) => option.textContent)).toEqual(["Central", "North (inactive)"]);
  fireEvent.change(location, { target: { value: locations[1].id } });
  const url = new URL(navigation.push.mock.lastCall![0], "http://localhost");
  expect(url.searchParams.get("location")).toBe(locations[1].id);
  expect(url.searchParams.get("status")).toBe("active");
  expect(navigation.push.mock.lastCall![1]).toEqual({ scroll: false });
  fireEvent.change(screen.getByRole("combobox", { name: "Surface" }), { target: { value: "hard" } });
  expect(new URL(navigation.replace.mock.lastCall![0], "http://localhost").searchParams.get("location")).toBe(locations[1].id);
});
