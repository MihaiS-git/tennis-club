// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
vi.mock("next/link", () => ({ default: ({ href, children, ...props }: import("react").ComponentProps<"a">) =>
  <a href={href} {...props}>{children}</a> }));
vi.mock("@/app/account/actions", () => ({ signOutAction: vi.fn() }));

import { AccountMenu } from "@/components/account-menu";

afterEach(cleanup);

it("keeps the sign-out form mounted when an outside confirmation closes the menu", () => {
  render(<AccountMenu avatarUrl={null} />);
  fireEvent.click(screen.getByRole("button", { name: "Account menu" }));
  const form = screen.getByRole("button", { name: "Sign out" }).closest("form");
  expect(form?.isConnected).toBe(true);
  fireEvent.pointerDown(document.body);
  expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
  expect(form?.isConnected).toBe(true);
});
