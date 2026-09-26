// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { Pagination, paginationItems } from "../../src/components/pagination";

afterEach(cleanup);

it.each([
  [1, 1, [1]],
  [2, 3, [1, 2, 3]],
  [3, 5, [1, 2, 3, 4, 5]],
  [1, 8, [1, 2, 3, "ellipsis-end", 8]],
  [2, 8, [1, 2, 3, "ellipsis-end", 8]],
  [4, 8, [1, "ellipsis-start", 3, 4, 5, "ellipsis-end", 8]],
  [7, 8, [1, "ellipsis-start", 6, 7, 8]],
  [8, 8, [1, "ellipsis-start", 6, 7, 8]],
  [3, 6, [1, 2, 3, 4, "ellipsis-end", 6]],
  [4, 6, [1, "ellipsis-start", 3, 4, 5, 6]],
] as const)("builds page items for page %s of %s", (current, total, expected) => {
  expect(paginationItems(current, total)).toEqual(expected);
});

it("keeps pages unique and ordered, with useful neighbors and no redundant ellipses", () => {
  for (let total = 1; total <= 100; total += 1) {
    for (let current = 1; current <= total; current += 1) {
      const items = paginationItems(current, total);
      const pages = items.filter((item) => typeof item === "number");
      expect(new Set(pages).size).toBe(pages.length);
      expect(pages).toEqual([...pages].sort((a, b) => a - b));
      expect(pages).toContain(1);
      expect(pages).toContain(total);
      expect(pages).toContain(current);
      if (current > 1) expect(pages).toContain(current - 1);
      if (current < total) expect(pages).toContain(current + 1);
      items.forEach((item, index) => {
        if (typeof item !== "number") {
          expect(typeof items[index - 1]).toBe("number");
          expect(typeof items[index + 1]).toBe("number");
          expect(Number(items[index + 1]) - Number(items[index - 1])).toBeGreaterThan(1);
        }
      });
    }
  }
});

it.each([[1, 1], [2, 3], [1, 8], [4, 8], [8, 8]])(
  "renders accessible controls for page %s of %s", (currentPage, totalPages) => {
    const buildHref = vi.fn((page: number) => `/example?p=${page}`);
    render(<Pagination currentPage={currentPage} totalPages={totalPages} buildHref={buildHref} />);
    const nav = screen.getByRole("navigation", { name: "Pagination" });
    const active = nav.querySelector('[aria-current="page"]')!;
    expect(active.textContent).toBe(String(currentPage));
    expect(active.tagName).toBe("SPAN");
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
        expect(disabled.tagName).toBe("SPAN");
      } else {
        expect(within(nav).getByRole("link", { name: label }).getAttribute("href")).toBe(`/example?p=${target}`);
      }
    }

    for (const page of paginationItems(currentPage, totalPages)) {
      if (typeof page === "number" && page !== currentPage) {
        expect(within(nav).getByRole("link", { name: String(page) }).getAttribute("href")).toBe(`/example?p=${page}`);
      }
    }
    const targets = within(nav).queryAllByRole("link").map((link) => Number(new URL(link.getAttribute("href")!, "http://localhost").searchParams.get("p")));
    expect(buildHref.mock.calls.map(([page]) => page).sort((a, b) => a - b)).toEqual(targets.sort((a, b) => a - b));
    for (const ellipsis of within(nav).queryAllByText("…")) {
      expect(ellipsis.closest("a, button")).toBeNull();
      expect(ellipsis.getAttribute("aria-current")).toBeNull();
    }
    expect(nav.textContent).not.toMatch(/Page \d+ of|Current \d+ of/);
  },
);

it("renders no controls without pages", () => {
  render(<Pagination currentPage={1} totalPages={0} buildHref={() => "/example"} />);
  expect(screen.queryByRole("navigation")).toBeNull();
});
