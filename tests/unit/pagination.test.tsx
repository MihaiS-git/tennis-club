// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { Pagination, paginationItems } from "../../src/components/pagination";

afterEach(cleanup);

it.each([[4, 8]])(
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
