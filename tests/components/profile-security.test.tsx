// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

const { readOwnProfile } = vi.hoisted(() => ({ readOwnProfile: vi.fn() }));
vi.mock("@/app/profile/own-profile", () => ({ readOwnProfile }));
vi.mock("@/components/auth/change-password-form", () => ({ ChangePasswordForm: () => <form aria-label="Change password form" /> }));
import AccountSecurityPage from "@/app/profile/security/page";

afterEach(cleanup);
const account = (roles: string[]) => ({ account: { state: "active", userId: "u", email: "player@example.test", roles }, profile: {} });

it("hides the Roles row for accounts without assigned roles", async () => {
  readOwnProfile.mockResolvedValue(account([]));
  render(await AccountSecurityPage());
  expect(screen.getByText("player@example.test")).toBeTruthy();
  expect(screen.queryByText("Roles")).toBeNull();
  expect(screen.queryByText("No assigned roles")).toBeNull();
  expect(screen.queryByRole("list", { name: "Assigned roles" })).toBeNull();
  expect(screen.getByRole("heading", { name: "Change password" })).toBeTruthy();
});

it("shows assigned roles", async () => {
  readOwnProfile.mockResolvedValue(account(["admin", "coach"]));
  render(await AccountSecurityPage());
  expect(screen.getByRole("list", { name: "Assigned roles" }).textContent).toBe("admincoach");
});
