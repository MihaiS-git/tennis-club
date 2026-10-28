// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ComponentProps, ReactElement } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { UsersToolbar } from "@/app/admin/users/users-toolbar";
import { BookingsToolbar } from "@/app/admin/bookings/bookings-toolbar";
import { TransactionsToolbar } from "@/app/admin/payments/transactions-toolbar";
import { AvailabilityCoachSelect } from "@/app/admin/coaching/availability/coach-select";
import { ActivityControls } from "@/app/my-activity/activity-controls";
import { InboxFilters } from "@/app/messages/inbox-filters";
import { parseActivityQuery } from "@/lib/bookings/activity-query";
import { parseInboxQuery } from "@/lib/notifications/inbox-query";
import { Pagination } from "@/components/pagination";
import { SortableTableHeading } from "@/components/sortable-table-heading";
import { PendingLink } from "@/components/navigation-pending";
import { AdminNavigation } from "@/components/admin-navigation";

const navigation = vi.hoisted(() => ({ query: "", navigate: vi.fn(), pendingHref: "" }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: navigation.navigate, push: navigation.navigate }),
  usePathname: () => "/test",
  useSearchParams: () => new URLSearchParams(navigation.query),
}));
vi.mock("next/link", async () => {
  const { createContext, useContext } = await import("react");
  const Href = createContext("");
  return {
    default: ({ href, scroll, onNavigate, transitionTypes, prefetch, children, ...props }: ComponentProps<"a"> & { prefetch?: boolean | null; scroll?: boolean; onNavigate?: (event: { preventDefault: () => void }) => void; transitionTypes?: string[] }) => {
      void scroll; void transitionTypes; void prefetch;
      return <Href.Provider value={href ?? ""}><a href={href} {...props} onClick={event => {
        props.onClick?.(event);
        if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
        event.preventDefault();
        onNavigate?.({ preventDefault() {} });
      }}>{children}</a></Href.Provider>;
    },
    useLinkStatus: () => ({ pending: useContext(Href) === navigation.pendingHref }),
  };
});
let completions: (() => void)[];
beforeEach(() => {
  navigation.query = "page=3"; navigation.pendingHref = ""; completions = [];
  navigation.navigate.mockReset().mockImplementation(() => new Promise<void>(resolve => completions.push(resolve)));
});
afterEach(async () => {
  await act(async () => { completions.forEach(resolve => resolve()); });
  cleanup(); vi.useRealTimers();
});

const cases: [string, () => ReactElement, string, string, string][] = [
  ["management", () => <UsersToolbar />, "Status", "active", "suspended"],
  ["Admin bookings", () => <BookingsToolbar locations={[]} />, "Type", "court", "coaching"],
  ["Coach bookings", () => <BookingsToolbar locations={[]} scope="coach" />, "Type", "coaching", "reservation"],
  ["payments", () => <TransactionsToolbar />, "Provider", "stripe", "netopia"],
  ["coach selection", () => <AvailabilityCoachSelect selectedId="one" coaches={[
    { user_id: "one", display_name: "One", ineligibility: null }, { user_id: "two", display_name: "Two", ineligibility: null },
    { user_id: "three", display_name: "Three", ineligibility: null },
  ]} />, "Coach", "two", "three"],
  ...(["upcoming", "history"] as const).map(scope => [
    scope, () => <ActivityControls scope={scope} staff query={parseActivityQuery({}, scope, true)} options={{ locations: [], courts: [] }} />,
    "Type", "court", "coaching",
  ] satisfies [string, () => ReactElement, string, string, string]),
  ["inbox", () => <InboxFilters query={parseInboxQuery({})} />, "Status", "unread", "read"],
];

// jsdom cannot measure pixels: compare every control, its parent, and the Clear slot's
// layout classes, and verify that the feedback is absolutely positioned instead.
function controlLayout(container: HTMLElement) {
  return [...container.querySelectorAll("input, select, [data-filter-clear-slot]")].map(node => ({
    node, className: node.className, parentClassName: node.parentElement?.className,
  }));
}
it.each(cases)("%s keeps results and controls stable through repeated pending interactions and completion", async (_, toolbar, label, first, second) => {
  const { container } = render(<>{toolbar()}<table aria-label="Existing results"><tbody><tr><td>Existing result</td></tr></tbody></table></>);
  const results = screen.getByRole("table");
  const layout = controlLayout(container);
  const control = screen.getByRole("combobox", { name: label });
  expect(screen.queryByRole("status")).toBeNull();
  fireEvent.change(control, { target: { value: first } });
  expect(screen.getByRole("status").textContent).toBe("Updating results…");
  // role=status already implies polite announcements.
  expect(screen.getByRole("status").className).toContain("absolute");
  // Live feedback must not sit beneath aria-busy, which can defer its announcement.
  expect(screen.getByRole("status").closest('[aria-busy="true"]')).toBeNull();
  expect(control.hasAttribute("disabled")).toBe(false);
  expect(screen.getByRole("table")).toBe(results);
  expect(controlLayout(container)).toEqual(layout);
  fireEvent.change(control, { target: { value: second } });
  expect(navigation.navigate).toHaveBeenCalledTimes(2);
  expect(screen.getAllByText("Updating results…")).toHaveLength(1);
  await act(async () => { completions[0](); });
  expect(screen.getByRole("status").textContent).toBe("Updating results…");
  await act(async () => { completions[1](); });
  expect(screen.queryByRole("status")).toBeNull();
  expect(container.querySelector('[aria-busy="true"]')).toBeNull();
  expect(controlLayout(container)).toEqual(layout);
});

it.each([
  ["management", () => <UsersToolbar />, 350],
  ["bookings", () => <BookingsToolbar locations={[]} />, 350],
  ["payments", () => <TransactionsToolbar />, 350],
  ["inbox", () => <InboxFilters query={parseInboxQuery({})} />, 300],
] as const)("%s search shows feedback only after its existing debounce and remains editable", async (_, toolbar, delay) => {
  vi.useFakeTimers();
  render(toolbar());
  const search = screen.getByRole("searchbox");
  fireEvent.change(search, { target: { value: "first" } });
  expect(screen.queryByRole("status")).toBeNull();
  act(() => { vi.advanceTimersByTime(delay); });
  expect(navigation.navigate).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("status").textContent).toBe("Updating results…");
  fireEvent.change(search, { target: { value: "second" } });
  expect((search as HTMLInputElement).value).toBe("second");
  act(() => { vi.advanceTimersByTime(delay); });
  expect(navigation.navigate).toHaveBeenCalledTimes(2);
  await act(async () => { completions.forEach(resolve => resolve()); });
  expect(screen.queryByRole("status")).toBeNull();
});

it("tracks only the last pending pagination/sort/Clear link and clears feedback on completion", () => {
  const content = () => <>
    <Pagination currentPage={1} totalPages={3} buildHref={page => `/test?page=${page}`} />
    <table><thead><tr><SortableTableHeading label="Name" sort={{ href: "/test?sort=name", direction: "asc" }} /></tr></thead></table>
    <PendingLink href="/test">Clear filters</PendingLink>
  </>;
  const { rerender } = render(content());
  const next = screen.getByRole("link", { name: "Next" });
  const nextClass = next.className;
  for (const href of ["/test?page=3", "/test?sort=name", "/test"]) {
    navigation.pendingHref = href; rerender(content());
    const link = document.querySelector(`a[href="${href}"]`)!;
    expect(link.querySelector("svg")).toBeTruthy();
    expect(within(link as HTMLElement).queryByRole("status")).toBeNull();
    expect(document.querySelectorAll("svg.motion-safe\\:animate-spin")).toHaveLength(1);
    expect(next.className).toBe(nextClass);
    expect(screen.getByRole("columnheader").getAttribute("aria-sort")).toBe("ascending");
  }
  navigation.pendingHref = ""; rerender(content());
  expect(screen.queryByText("Loading results…")).toBeNull();
  expect(next.getAttribute("href")).toBe("/test?page=2");
});

it("uses the filter transition as the single Clear feedback source", async () => {
  navigation.query = "status=active";
  render(<UsersToolbar />);
  fireEvent.click(screen.getByRole("link", { name: "Clear filters" }));
  expect(navigation.navigate).toHaveBeenCalledWith("/test", { scroll: false });
  expect(screen.getByRole("status").textContent).toBe("Updating results…");
  expect(screen.getAllByRole("status")).toHaveLength(1);
  expect(screen.getByRole("link", { name: "Clear filters" }).querySelector("svg")).toBeNull();
  await act(async () => { completions.forEach(resolve => resolve()); });
  expect(screen.queryByRole("status")).toBeNull();
});

it("shows a page-navigation spinner beside only the clicked sidebar link, without moving it", () => {
  const { rerender } = render(<AdminNavigation isAdmin />);
  const users = screen.getByRole("link", { name: "Users" });
  expect(within(users).queryByRole("status")).toBeNull();
  expect(users.querySelector("svg.motion-safe\\:animate-spin")).toBeNull();
  navigation.pendingHref = "/admin/users"; rerender(<AdminNavigation isAdmin />);
  expect(screen.getByRole("link", { name: "Users" })).toBe(users);
  expect(users.querySelector("svg.motion-safe\\:animate-spin")?.getAttribute("class")).toContain("motion-safe:animate-spin");
  expect(users.querySelector("svg.motion-safe\\:animate-spin")?.closest('[aria-hidden="true"]')).toBeTruthy();
  expect(screen.queryByRole("status")).toBeNull();
  navigation.pendingHref = ""; rerender(<AdminNavigation isAdmin />);
  expect(users.querySelector("svg.motion-safe\\:animate-spin")).toBeNull();
});

it("composes a filter change after Clear with the cleared query while both are pending", async () => {
  navigation.query = "q=member&role=coach";
  render(<UsersToolbar />);
  fireEvent.click(screen.getByRole("link", { name: "Clear filters" }));
  fireEvent.change(screen.getByRole("combobox", { name: "Status" }), { target: { value: "active" } });
  expect(navigation.navigate.mock.calls.map(([href]) => href)).toEqual(["/test", "/test?status=active"]);
  expect(screen.getAllByRole("status")).toHaveLength(1);
  await act(async () => { completions.forEach(resolve => resolve()); });
  expect(screen.queryByRole("status")).toBeNull();
});
