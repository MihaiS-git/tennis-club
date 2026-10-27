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
vi.mock("next/link", () => ({ useLinkStatus: () => ({ pending: false }), default: ({ href, children, ...props }:
  import("react").ComponentProps<"a"> & Pick<import("react").ComponentProps<typeof import("next/link").default>, "scroll" | "transitionTypes" | "onNavigate">) =>
  {
    delete props.scroll;
    delete props.transitionTypes;
    delete props.onNavigate;
    return <a href={href} {...props}>{children}</a>;
  } }));
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
  fireEvent.change(screen.getByRole("combobox", { name: "Type" }), { target: { value: "court" } });
  const params = new URL(navigation.replace.mock.lastCall![0], "http://localhost").searchParams;
  expect(Object.fromEntries(params)).toMatchObject({ location: otherLocation, type: "court", from: "2026-10-01", sort: "datetime", direction: "asc" });
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

it.each(["upcoming", "history"] as const)("offers Court and Coaching filters to regular users on %s", (scope) => {
  render(<ActivityControls staff={false} scope={scope}
    query={parseActivityQuery({ type: "coaching", page: "3", sort: "duration" }, scope, false)} options={options} />);
  const select = screen.getByRole("combobox", { name: "Type" }) as HTMLSelectElement;
  expect([...select.options].map(option => option.textContent)).toEqual(["All bookings", "Court bookings", "Coaching lessons"]);
  expect(select.value).toBe("coaching");
  fireEvent.change(select, { target: { value: "court" } });
  const params = new URL(navigation.replace.mock.lastCall![0], "http://localhost").searchParams;
  expect(params.get("type")).toBe("court");
  expect(params.get("sort")).toBe("duration");
  expect(params.has("page")).toBe(false);
  const cleared = new URL(screen.getByRole("link", { name: "Clear filters" }).getAttribute("href")!, "http://localhost").searchParams;
  expect(cleared.get("type")).toBe("all");
});

it.each(["history"] as const)("uses visible %s headers to toggle server sorts and retain filters", (scope) => {
  const query = parseActivityQuery({ page: "3", location, court, type: "reservation", from: "2026-10-01", status: "cancelled" }, scope);
  const { rerender } = render(<ActivityTable scope={scope} query={query}><tr><td>Activity</td></tr></ActivityTable>);
  const date = screen.getByRole("link", { name: "Date/time" });
  expect(date.closest("th")?.getAttribute("aria-sort")).toBe(scope === "history" ? "descending" : "ascending");
  const params = new URL(date.getAttribute("href")!, "http://localhost").searchParams;
  expect(Object.fromEntries(params)).toMatchObject({ location, court, type: "reservation", from: "2026-10-01", page: "1", sort: "datetime", direction: scope === "history" ? "asc" : "desc" });
  const columns: [string, typeof query.sort][] = [["Location", "location"], ["Court", "court"], ["Duration", "duration"], ["Type", "type"]];
  if (scope === "history") columns.push(["Status", "status"]);
  for (const [label, sort] of columns) {
    const href = screen.getByRole("link", { name: label }).getAttribute("href")!;
    expect(Object.fromEntries(new URL(href, "http://localhost").searchParams)).toMatchObject({ sort, direction: "asc", page: "1", location, court });
    rerender(<ActivityTable scope={scope} query={{ ...query, sort, direction: "asc" }}><tr><td>Activity</td></tr></ActivityTable>);
    const active = screen.getByRole("link", { name: label });
    expect(active.closest("th")?.getAttribute("aria-sort")).toBe("ascending");
    expect(new URL(active.getAttribute("href")!, "http://localhost").searchParams.get("direction")).toBe("desc");
    rerender(<ActivityTable scope={scope} query={query}><tr><td>Activity</td></tr></ActivityTable>);
  }
  rerender(<ActivityTable scope={scope} query={parseActivityQuery({}, scope, false)}><tr><td>Activity</td></tr></ActivityTable>);
  expect(screen.getByRole("columnheader", { name: /Type/ })).toBeTruthy();
  expect(screen.queryByRole("columnheader", { name: /Status/ }) !== null).toBe(scope === "history");
});

it("collapses filters behind a mobile toggle that reports the active filter count", () => {
  render(<ActivityControls staff={false} scope="history" query={parseActivityQuery({ location, status: "cancelled" }, "history", false)} options={options} />);
  const toggle = screen.getByRole("button", { name: /^Filters\s*2\s*active$/ });
  const panel = document.getElementById(toggle.getAttribute("aria-controls")!)!;
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(toggle);
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(screen.getByRole("combobox", { name: "Location" }).closest(`#${CSS.escape(panel.id)}`)).toBe(panel);
});

const mivus = "55555555-5555-4555-8555-555555555555";
const rimus = "66666666-6666-4666-8666-666666666666";
const mivusC1 = "77777777-7777-4777-8777-777777777777";
const rimusC1 = "88888888-8888-4888-8888-888888888888";
const duplicateNames = {
  locations: [{ id: mivus, name: "Mivus" }, { id: rimus, name: "RiMUS" }],
  courts: [{ id: mivusC1, name: "C1", location_id: mivus }, { id: rimusC1, name: "C1", location_id: rimus }],
};
const courtSelect = () => screen.getByRole("combobox", { name: "Court" }) as HTMLSelectElement;
const courtOptions = () => [...courtSelect().options].map((option) => [option.textContent, option.value]);
const lastParams = () => new URL(navigation.replace.mock.lastCall![0], "http://localhost").searchParams;

it("disables Court until a location is selected and ignores a court without a location", () => {
  const query = parseActivityQuery({ court: mivusC1, status: "cancelled" }, "history");
  expect(query.court).toBeUndefined();
  render(<ActivityControls staff={false} scope="history" query={query} options={duplicateNames} />);
  expect(courtSelect().disabled).toBe(true);
  expect(courtOptions()).toEqual([["Select a location first", ""]]);
  expect(screen.getByRole("button", { name: /^Filters\s*1\s*active$/ })).toBeTruthy();
});

it("lists only the selected location's courts when court names repeat across locations", () => {
  render(<ActivityControls staff={false} scope="history" query={parseActivityQuery({ location: rimus, court: rimusC1 }, "history")} options={duplicateNames} />);
  expect(courtSelect().disabled).toBe(false);
  expect(courtOptions()).toEqual([["All courts", ""], ["C1", rimusC1]]);
  expect(courtSelect().value).toBe(rimusC1);
  fireEvent.change(courtSelect(), { target: { value: "" } });
  expect(lastParams().has("court")).toBe(false);
  expect(lastParams().get("location")).toBe(rimus);
});

it("clears the court when the location changes or returns to All locations, keeping other filters", () => {
  render(<ActivityControls staff={false} scope="history" query={parseActivityQuery({ location: mivus, court: mivusC1, status: "completed", from: "2026-10-01" }, "history")} options={duplicateNames} />);
  const location = screen.getByRole("combobox", { name: "Location" });
  fireEvent.change(location, { target: { value: rimus } });
  expect(Object.fromEntries(lastParams())).toMatchObject({ location: rimus, status: "completed", from: "2026-10-01" });
  expect(lastParams().has("court")).toBe(false);
  fireEvent.change(location, { target: { value: "" } });
  expect(lastParams().has("location")).toBe(false);
  expect(lastParams().has("court")).toBe(false);
  expect(Object.fromEntries(lastParams())).toMatchObject({ status: "completed", from: "2026-10-01" });
});

it("treats a direct URL court from another location as no court filter", () => {
  render(<ActivityControls staff={false} scope="history" query={parseActivityQuery({ location: mivus, court: rimusC1 }, "history")} options={duplicateNames} />);
  expect(courtOptions()).toEqual([["All courts", ""], ["C1", mivusC1]]);
  expect(courtSelect().value).toBe("");
  expect(screen.getByRole("button", { name: /^Filters\s*1\s*active$/ })).toBeTruthy();
});

const typeSelect = () => screen.getByRole("combobox", { name: "Type" }) as HTMLSelectElement;
const clearSlot = (container: HTMLElement) => container.querySelector("[data-filter-clear-slot]")!;

it("offers staff each distinct activity type once, with clear labels", () => {
  render(<ActivityControls staff scope="upcoming" query={parseActivityQuery({}, "upcoming")} options={options} />);
  expect([...typeSelect().options].map(option => [option.value, option.textContent])).toEqual([
    ["all", "All activity"], ["court", "Court bookings"], ["coaching", "Coaching lessons"],
    ["booking", "All bookings"], ["reservation", "Staff reservations"]]);
});

it.each([false, true])("keeps the selected Type synchronized with URL navigation, including Back/Forward (staff=%s)", (staff) => {
  const { rerender } = render(<ActivityControls staff={staff} scope="upcoming"
    query={parseActivityQuery({ type: "court", page: "2", sort: "duration" }, "upcoming", staff)} options={options} />);
  expect(typeSelect().value).toBe("court");
  fireEvent.change(typeSelect(), { target: { value: "coaching" } });
  expect(Object.fromEntries(lastParams())).toMatchObject({ type: "coaching", sort: "duration" });
  expect(lastParams().has("page")).toBe(false);
  // The server re-renders with the URL's query after navigation and after Back/Forward.
  rerender(<ActivityControls staff={staff} scope="upcoming" query={parseActivityQuery({ type: "coaching" }, "upcoming", staff)} options={options} />);
  expect(typeSelect().value).toBe("coaching");
  rerender(<ActivityControls staff={staff} scope="upcoming" query={parseActivityQuery({ type: "court", page: "2" }, "upcoming", staff)} options={options} />);
  expect(typeSelect().value).toBe("court");
  fireEvent.change(typeSelect(), { target: { value: "all" } });
  expect(lastParams().get("type")).toBe("all");
  expect(lastParams().has("page")).toBe(false);
});

it("hides Clear for explicit default URL values while always reserving its slot", () => {
  const defaults = { type: "booking", status: "all", page: "1", sort: "datetime", direction: "desc" };
  const { container, rerender } = render(<ActivityControls staff={false} scope="history"
    query={parseActivityQuery(defaults, "history", false)} options={options} />);
  expect(typeSelect().value).toBe("all");
  expect(screen.queryByRole("link", { name: "Clear filters" })).toBeNull();
  const slot = clearSlot(container);
  expect(slot).toBeTruthy();
  rerender(<ActivityControls staff={false} scope="history" query={parseActivityQuery({ ...defaults, type: "court" }, "history", false)} options={options} />);
  expect(clearSlot(container)).toBe(slot);
  expect(slot.querySelector("a")?.textContent).toBe("Clear filters");
  expect(slot.className).toBe(clearSlot(container).className);
});
