// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";

import { Pagination, paginationItems } from "../../src/components/pagination";
import { ActivityPagination } from "@/app/my-activity/activity-pagination";
import { activityHref, parseActivityQuery } from "@/lib/bookings/activity-query";

vi.mock("next/link", () => ({ useLinkStatus: () => ({ pending: false }),
  default: ({ scroll, ...props }: ComponentProps<"a"> & { scroll?: boolean }) => <a {...props} data-scroll={String(scroll)} />,
}));

afterEach(cleanup);

it.each([0, 1])("hides numbered pagination with %s pages", (totalPages) => {
  render(<Pagination currentPage={1} totalPages={totalPages} buildHref={(page) => `?page=${page}`} />);
  expect(screen.queryByRole("navigation")).toBeNull();
});

it("hides count-free pagination on its only page", () => {
  render(<Pagination currentPage={1} hasNext={false} buildHref={(page) => `?page=${page}`} />);
  expect(screen.queryByRole("navigation")).toBeNull();
});

it.each([[1, 2], [1, 8], [4, 8], [8, 8]])(
  "renders accessible controls for page %s of %s", (currentPage, totalPages) => {
    const buildHref = vi.fn((page: number) => `/example?p=${page}`);
    render(<Pagination currentPage={currentPage} totalPages={totalPages} buildHref={buildHref} />);
    const nav = screen.getByRole("navigation", { name: "Pagination" });
    const active = nav.querySelector('[aria-current="page"]')!;
    expect(active.textContent).toBe(String(currentPage));
    expect(active.closest("a")).toBeNull();
    expect(nav.querySelectorAll('[aria-current="page"]')).toHaveLength(1);

    for (const [label, target, unavailable] of [
      ["Previous", currentPage - 1, currentPage === 1],
      ["Next", currentPage + 1, currentPage === totalPages],
    ] as const) {
      if (unavailable) {
        expect(within(nav).queryByRole("link", { name: label })).toBeNull();
        const disabled = nav.querySelector(`[aria-label="${label}"]`)!;
        expect(disabled.getAttribute("aria-disabled")).toBe("true");
      } else {
        expect(within(nav).getByRole("link", { name: label }).getAttribute("href")).toBe(`/example?p=${target}`);
      }
    }

    for (const page of paginationItems(currentPage, totalPages)) {
      if (typeof page === "number" && page !== currentPage) {
        expect(within(nav).getByRole("link", { name: String(page) }).getAttribute("href")).toBe(`/example?p=${page}`);
      }
    }
    for (const ellipsis of within(nav).queryAllByText("…")) {
      expect(ellipsis.closest("a, button")).toBeNull();
      expect(ellipsis.getAttribute("aria-current")).toBeNull();
    }
  },
);

it.each([[1, true], [3, true], [3, false]] as const)(
  "renders count-free navigation at page %s with hasNext=%s", (currentPage, hasNext) => {
    render(<Pagination currentPage={currentPage} hasNext={hasNext} buildHref={(page) => `/activity?page=${page}`} />);
    const nav = screen.getByRole("navigation");
    expect(nav.querySelector('[aria-current="page"]')?.getAttribute("aria-label")).toBe(`Page ${currentPage}`);
    expect(within(nav).queryByText("…")).toBeNull();
    expect(within(nav).getAllByRole("listitem")).toHaveLength(3);
    for (const [name, enabled, target] of [
      ["Previous", currentPage > 1, currentPage - 1], ["Next", hasNext, currentPage + 1],
    ] as const) {
      const link = within(nav).queryByRole("link", { name });
      if (enabled) expect(link?.getAttribute("href")).toBe(`/activity?page=${target}`);
      else {
        expect(link).toBeNull();
        expect(nav.querySelector(`[aria-label="${name}"]`)?.getAttribute("aria-disabled")).toBe("true");
      }
    }
  },
);

it.each([false, true])("passes scroll=%s to every navigation link", (scroll) => {
  render(<Pagination currentPage={3} totalPages={8} scroll={scroll} buildHref={(page) => `?page=${page}`} />);
  for (const link of screen.getAllByRole("link")) expect(link.getAttribute("data-scroll")).toBe(String(scroll));
});

it("keeps numbered navigation scrolling disabled by default", () => {
  render(<Pagination currentPage={1} totalPages={2} buildHref={(page) => `?page=${page}`} />);
  expect(screen.getByRole("link", { name: "Next" }).getAttribute("data-scroll")).toBe("false");
});

it.each(["upcoming", "history"] as const)("preserves %s activity URLs, default scrolling and empty-page recovery", (scope) => {
  const query = parseActivityQuery({ page: "3", type: "reservation", from: "2026-10-01", sort: "court", direction: "desc" }, scope);
  render(<ActivityPagination scope={scope} query={query} hasNext={false} empty />);
  const previous = screen.getByRole("link", { name: "Previous" });
  expect(previous.getAttribute("href")).toBe(activityHref(scope, query, 2));
  expect(previous.getAttribute("data-scroll")).toBe("true");
  expect(screen.getByRole("navigation", { name: "Activity pages" })).toBeDefined();
  expect(screen.getByRole("link", { name: "Return to first page" }).getAttribute("href")).toBe(activityHref(scope, query, 1));
});

it("hides activity navigation on the only page", () => {
  render(<ActivityPagination scope="upcoming" query={parseActivityQuery({}, "upcoming")} hasNext={false} empty />);
  expect(screen.queryByRole("navigation")).toBeNull();
  expect(screen.queryByRole("link")).toBeNull();
});
