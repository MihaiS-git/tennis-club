// @vitest-environment jsdom
import { Children, cloneElement, isValidElement, Suspense, type ReactNode } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("next/server", () => ({ connection: async () => undefined }));
vi.mock("@/lib/courts/public", () => ({
  listPublicLocationsWithCourts: async () => [], listPublicVisitorLocations: async () => [],
}));
vi.mock("@/lib/courts/public-calendar", () => ({ listPublicLocationsToday: async () => [] }));
vi.mock("@/lib/coaching/public", () => ({ readPublicCoaching: async () => ({ programs: [], coaches: [] }) }));

import Home from "@/app/page";
import CourtsPage from "@/app/courts/page";
import CoachingPage from "@/app/coaching/page";
import ClubPage from "@/app/club/page";

// Render the actual fallback branches without invoking async Server Components in jsdom.
function showFallbacks(node: ReactNode): ReactNode {
  return Children.map(node, (child) => {
    if (!isValidElement<{ children?: ReactNode; fallback?: ReactNode }>(child)) return child;
    if (child.type === Suspense) return child.props.fallback;
    if (!child.props.children) return child;
    return cloneElement(child, {}, showFallbacks(child.props.children));
  });
}

afterEach(cleanup);

it.each([
  ["home", () => Home({ searchParams: Promise.resolve({}), params: Promise.resolve({}) }), 5],
  ["courts", CourtsPage, 1],
  ["coaching", CoachingPage, 4],
  ["club", ClubPage, 2],
] as const)("announces every meaningful %s fallback", (_, page, count) => {
  render(showFallbacks(page()));
  const statuses = screen.getAllByRole("status");
  expect(statuses).toHaveLength(count);
  for (const status of statuses) expect(status.textContent).toMatch(/Loading .+…/);
  // Every visible loading message belongs to a status region.
  for (const message of screen.getAllByText(/Loading .+…/)) expect(message.closest('[role="status"]')).toBeTruthy();
});

it("preserves the court discovery height and homepage map placeholder", () => {
  render(showFallbacks(CourtsPage()));
  expect(screen.getByRole("status").parentElement?.className).toContain("min-h-96");
  cleanup();
  const { container } = render(showFallbacks(Home({ searchParams: Promise.resolve({}), params: Promise.resolve({}) })));
  expect(container.querySelector(".h-full.w-full.border")).toBeTruthy();
  expect(screen.getByText("Loading court availability…").className).toContain("py-8");
  expect(screen.getByRole("heading", { name: "Courts", level: 3 })).toBeTruthy();
});
