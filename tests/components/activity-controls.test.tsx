// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ActivityTable } from "@/app/my-activity/activity-table";
import { ActivityControls } from "@/app/my-activity/activity-controls";
import { parseActivityQuery } from "@/lib/bookings/activity-query";

const navigation = vi.hoisted(() => ({ pathname: "/my-activity/bookings", replace: vi.fn() }));
vi.mock("next/navigation", () => ({
  usePathname: () => navigation.pathname,
  useRouter: () => ({ replace: navigation.replace }),
}));
vi.mock("next/link", () => ({ default: ({ href, children, ...props }: import("react").ComponentProps<"a">) => <a href={href} {...props}>{children}</a> }));
const location = "11111111-1111-4111-8111-111111111111";
const otherLocation = "22222222-2222-4222-8222-222222222222";
const court = "33333333-3333-4333-8333-333333333333";
const options = {
  locations: [{ id: location, name: "Central" }, { id: otherLocation, name: "West" }],
  courts: [{ id: court, name: "Central court", location_id: location }, { id: "44444444-4444-4444-8444-444444444444", name: "West court", location_id: otherLocation }],
};
beforeEach(() => { navigation.pathname = "/my-activity/bookings"; navigation.replace.mockClear(); });
afterEach(cleanup);

it("composes filter changes in the URL, clears the old court and resets pagination", () => {
  render(<ActivityControls staff scope="upcoming" query={parseActivityQuery({ page: "3", location, court, type: "reservation", from: "2026-10-01" }, "upcoming")} options={options} />);
  expect(screen.queryByRole("option", { name: "West court" })).toBeNull();
  fireEvent.change(screen.getByRole("combobox", { name: "Location" }), { target: { value: otherLocation } });
  fireEvent.change(screen.getByRole("combobox", { name: "Type" }), { target: { value: "booking" } });
  const params = new URL(navigation.replace.mock.lastCall![0], "http://localhost").searchParams;
  expect(Object.fromEntries(params)).toMatchObject({ location: otherLocation, type: "booking", from: "2026-10-01", sort: "datetime", direction: "asc" });
  expect(params.has("page")).toBe(false);
  expect(params.has("court")).toBe(false);
});

it("clears active History filters while retaining sort and returning to page 1", () => {
  navigation.pathname = "/my-activity/history";
  render(<ActivityControls staff scope="history" query={parseActivityQuery({ page: "4", status: "cancelled", location, court, type: "booking", to: "2026-10-05", sort: "duration", direction: "desc" }, "history")} options={options} />);
  const href = screen.getByRole("link", { name: "Clear filters" }).getAttribute("href")!;
  expect(Object.fromEntries(new URL(href, "http://localhost").searchParams))
    .toEqual({ page: "1", type: "all", status: "all", sort: "duration", direction: "desc" });
});

it.each(["history"] as const)("hides Type for regular users on %s and retains other URL controls", (scope) => {
  navigation.pathname = scope === "history" ? "/my-activity/history" : "/my-activity/bookings";
  render(<ActivityControls staff={false} scope={scope}
    query={parseActivityQuery({ type: "reservation", page: "3", sort: "duration", direction: "desc", from: "2026-10-01" }, scope, false)} options={options} />);
  expect(screen.queryByRole("combobox", { name: "Type" })).toBeNull();
  expect(screen.getByRole("combobox", { name: "Location" })).toBeTruthy();
  fireEvent.change(screen.getByRole("combobox", { name: "Location" }), { target: { value: location } });
  const params = new URL(navigation.replace.mock.lastCall![0], "http://localhost").searchParams;
  expect(Object.fromEntries(params)).toMatchObject({ type: "booking", location, sort: "duration", direction: "desc", from: "2026-10-01" });
  expect(params.has("page")).toBe(false);
  const cleared = new URL(screen.getByRole("link", { name: "Clear filters" }).getAttribute("href")!, "http://localhost").searchParams;
  expect(cleared.get("type")).toBe("booking");
});

it.each(["history"] as const)("uses visible %s headers to toggle server sorts and retain filters", (scope) => {
  const query = parseActivityQuery({ page: "3", location, court, type: "reservation", from: "2026-10-01", status: "cancelled" }, scope);
  const { rerender } = render(<ActivityTable scope={scope} query={query} staff><tr><td>Activity</td></tr></ActivityTable>);
  const date = screen.getByRole("link", { name: "Date/time" });
  expect(date.closest("th")?.getAttribute("aria-sort")).toBe(scope === "history" ? "descending" : "ascending");
  const params = new URL(date.getAttribute("href")!, "http://localhost").searchParams;
  expect(Object.fromEntries(params)).toMatchObject({ location, court, type: "reservation", from: "2026-10-01", page: "1", sort: "datetime", direction: scope === "history" ? "asc" : "desc" });
  const columns: [string, typeof query.sort][] = [["Location", "location"], ["Court", "court"], ["Duration", "duration"], ["Type", "type"]];
  if (scope === "history") columns.push(["Status", "status"]);
  for (const [label, sort] of columns) {
    const href = screen.getByRole("link", { name: label }).getAttribute("href")!;
    expect(Object.fromEntries(new URL(href, "http://localhost").searchParams)).toMatchObject({ sort, direction: "asc", page: "1", location, court });
    rerender(<ActivityTable scope={scope} query={{ ...query, sort, direction: "asc" }} staff><tr><td>Activity</td></tr></ActivityTable>);
    const active = screen.getByRole("link", { name: label });
    expect(active.closest("th")?.getAttribute("aria-sort")).toBe("ascending");
    expect(new URL(active.getAttribute("href")!, "http://localhost").searchParams.get("direction")).toBe("desc");
    rerender(<ActivityTable scope={scope} query={query} staff><tr><td>Activity</td></tr></ActivityTable>);
  }
  rerender(<ActivityTable scope={scope} query={parseActivityQuery({}, scope, false)} staff={false}><tr><td>Activity</td></tr></ActivityTable>);
  expect(screen.queryByRole("columnheader", { name: /Type/ })).toBeNull();
  expect(screen.queryByRole("columnheader", { name: /Status/ }) !== null).toBe(scope === "history");
});
