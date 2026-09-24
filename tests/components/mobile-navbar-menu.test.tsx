// @vitest-environment jsdom

import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

vi.mock("../../src/app/account/actions", () => ({ signOutAction: vi.fn() }));

import { MobileNavbarMenu } from "../../src/components/mobile-navbar-menu";

afterEach(cleanup);

it("shows signed-out links and closes on link selection or Escape", () => {
  render(<MobileNavbarMenu isAuthenticated={false} />);

  const trigger = screen.getByRole("button", { name: "Open menu" });
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByRole("dialog", { name: "Mobile navigation menu" })).toBeNull();

  fireEvent.click(trigger);
  const drawer = screen.getByRole("dialog", { name: "Mobile navigation menu" });
  const navigation = within(drawer).getByRole("navigation", { name: "Mobile navigation" });
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  expect(trigger.getAttribute("aria-controls")).toBe(drawer.id);
  expect(drawer.getAttribute("aria-modal")).toBe("true");
  expect(document.body.style.overflow).toBe("hidden");
  expect(document.activeElement).toBe(within(drawer).getByRole("button", { name: "Close menu" }));
  expect(within(navigation).getAllByRole("link").map((link) => link.textContent)).toEqual([
    "Courts", "Coaching", "Rankings", "Club", "Sign in",
  ]);
  expect(within(navigation).queryByRole("button", { name: "Sign out" })).toBeNull();
  expect(within(navigation).queryByText("Book a court")).toBeNull();

  fireEvent.click(within(navigation).getByRole("link", { name: "Courts" }));
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  expect(document.activeElement).toBe(trigger);
  expect(document.body.style.overflow).toBe("");

  fireEvent.click(trigger);
  fireEvent.keyDown(window, { key: "Escape" });
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  expect(document.activeElement).toBe(trigger);
});

it("shows Matches, Account, and direct Sign out for authenticated users", () => {
  render(<MobileNavbarMenu isAuthenticated />);
  fireEvent.click(screen.getByRole("button", { name: "Open menu" }));

  const drawer = screen.getByRole("dialog", { name: "Mobile navigation menu" });
  const navigation = within(drawer).getByRole("navigation", { name: "Mobile navigation" });
  expect(within(navigation).getAllByRole("link").map((link) => link.textContent)).toEqual([
    "Courts", "Coaching", "Matches", "Rankings", "Club", "Account",
  ]);
  expect(within(navigation).getByRole("button", { name: "Sign out" })).toBeDefined();
  expect(within(navigation).queryByText("Sign in")).toBeNull();
});

it("closes on backdrop or drawer close button and restores focus", () => {
  render(<MobileNavbarMenu isAuthenticated={false} />);
  const trigger = screen.getByRole("button", { name: "Open menu" });

  fireEvent.click(trigger);
  fireEvent.click(document.querySelector('[aria-label="Close menu backdrop"]')!);
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  expect(document.activeElement).toBe(trigger);

  fireEvent.click(trigger);
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Close menu" }));
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  expect(document.activeElement).toBe(trigger);
});

it("keeps keyboard focus inside the open drawer", () => {
  render(<MobileNavbarMenu isAuthenticated={false} />);
  fireEvent.click(screen.getByRole("button", { name: "Open menu" }));

  const drawer = screen.getByRole("dialog", { name: "Mobile navigation menu" });
  const closeButton = within(drawer).getByRole("button", { name: "Close menu" });
  const lastLink = within(drawer).getByRole("link", { name: "Sign in" });

  fireEvent.keyDown(closeButton, { key: "Tab", shiftKey: true });
  expect(document.activeElement).toBe(lastLink);

  fireEvent.keyDown(lastLink, { key: "Tab" });
  expect(document.activeElement).toBe(closeButton);
});
