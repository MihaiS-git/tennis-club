// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
vi.mock("next/link", () => ({ default: ({ href, children, ...props }: import("react").ComponentProps<"a">) =>
  <a href={href} {...props}>{children}</a> }));
vi.mock("@/app/account/actions", () => ({ signOutAction: vi.fn() }));

import { AccountMenu } from "@/components/account-menu";

afterEach(cleanup);

it("exposes personal destinations and sign out with keyboard focus and Escape", () => {
  render(<AccountMenu avatarUrl={null} />);
  const trigger = screen.getByRole("button", { name: "Account menu" });
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
  fireEvent.click(trigger);
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  expect(screen.getByRole("link", { name: "My activity" }).getAttribute("href")).toBe("/my-activity/bookings");
  expect(screen.getByRole("link", { name: "Profile & settings" }).getAttribute("href")).toBe("/profile");
  expect(screen.getAllByRole("button", { name: "Sign out" })).toHaveLength(1);
  expect(document.activeElement).toBe(screen.getByRole("link", { name: "My activity" }));
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  expect(document.activeElement).toBe(trigger);
});

it("keeps the sign-out form mounted when an outside confirmation closes the menu", () => {
  render(<AccountMenu avatarUrl={null} />);
  fireEvent.click(screen.getByRole("button", { name: "Account menu" }));
  const form = screen.getByRole("button", { name: "Sign out" }).closest("form");
  expect(form?.isConnected).toBe(true);
  fireEvent.pointerDown(document.body);
  expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
  expect(form?.isConnected).toBe(true);
});
