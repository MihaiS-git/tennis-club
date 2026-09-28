// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
const { profileContext, loadProfile, redirect, signOutAction } = vi.hoisted(() => ({
  profileContext: vi.fn(), loadProfile: vi.fn(), signOutAction: vi.fn(), redirect: vi.fn((path: string) => { throw new Error(`redirect:${path}`); }),
}));
vi.mock("../../src/lib/profile/profile", () => ({ profileContext, loadProfile }));
vi.mock("../../src/app/profile/profile-forms", () => ({ PersonalInformationForm: () => <p>Personal form</p>, TennisProfileForm: () => <p>Tennis form</p>, AvatarForms: () => <p>Avatar controls</p> }));
vi.mock("../../src/app/account/actions", () => ({ signOutAction, changePasswordAction: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect }));
import ProfilePage from "../../src/app/profile/page";
import AccountPage from "../../src/app/account/page";
beforeEach(() => { vi.resetAllMocks(); });
afterEach(cleanup);
it("redirects anonymous callers before reading profile data", async () => {
  profileContext.mockResolvedValue({ client: {}, account: { state: "unauthenticated" } });
  await expect(ProfilePage()).rejects.toThrow("redirect:/login"); expect(loadProfile).not.toHaveBeenCalled();
});
it("redirects the legacy account route to profile without rendering separate settings", () => {
  expect(() => AccountPage()).toThrow("redirect:/profile");
  expect(redirect).toHaveBeenCalledExactlyOnceWith("/profile");
  expect(profileContext).not.toHaveBeenCalled();
});
it.each(["suspended", "missing-profile", "load-error"])("preserves %s account handling", async (state) => {
  profileContext.mockResolvedValue({ client: {}, account: { state } });
  render(await ProfilePage()); expect(screen.getByRole("button", { name: "Sign out" })).toBeDefined();
  expect(screen.queryByText("Personal form")).toBeNull(); expect(loadProfile).not.toHaveBeenCalled();
  expect(screen.queryByLabelText("Current password")).toBeNull();
});
it.each([{ roles: [] }, { roles: ["admin", "coach"] }])("renders consolidated settings for an active user with roles $roles and no tennis row", async ({ roles }) => {
  const client = {}; profileContext.mockResolvedValue({ client, account: { state: "active", userId: "owner", email: "owner@example.com", roles } });
  loadProfile.mockResolvedValue({ personal: {}, player: null });
  render(await ProfilePage());
  expect(loadProfile).toHaveBeenCalledWith(client, "owner");
  expect(screen.getByRole("heading", { name: "Profile" })).toBeDefined();
  expect(screen.getByRole("img", { name: "Default player avatar" })).toBeDefined();
  expect(screen.queryByRole("link", { name: "Account & security" })).toBeNull();
  expect(screen.getByText("Avatar controls")).toBeDefined();
  const navigation = within(screen.getByRole("navigation", { name: "Profile settings" }));
  expect(screen.queryByRole("heading", { name: "Personal information" })).toBeNull();
  fireEvent.click(navigation.getByRole("button", { name: "Personal information" }));
  expect(screen.getByText("Personal form")).toBeDefined();
  expect(screen.queryByRole("img", { name: "Default player avatar" })).toBeNull();
  fireEvent.click(navigation.getByRole("button", { name: "Tennis profile" }));
  expect(screen.getByText("Tennis form")).toBeDefined();
  fireEvent.click(navigation.getByRole("button", { name: "Account & security" }));
  expect(screen.getByRole("heading", { name: "Account & security" })).toBeDefined();
  expect(screen.getByText("owner@example.com")).toBeDefined();
  expect(screen.getByRole("list", { name: "Assigned roles" }).textContent).toBe(roles.join(""));
  expect(screen.getByRole("heading", { name: "Change password" })).toBeDefined();
  expect(screen.getByLabelText("Current password")).toBeDefined();
  expect(screen.getByLabelText("New password", { exact: true })).toBeDefined();
  expect(screen.getByLabelText("Confirm new password")).toBeDefined();
  expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
});
it("preserves an existing player identity and avatar alongside account controls", async () => {
  profileContext.mockResolvedValue({ client: {}, account: { state: "active", userId: "owner", email: "owner@example.com", roles: [] } });
  loadProfile.mockResolvedValue({ personal: {}, player: { display_name: "Club player", avatar_path: "owner/avatar.png", updated_at: "2026-09-28T10:00:00Z", rating: 1200, sportya_level: "6" } });
  render(await ProfilePage());
  expect(screen.getByRole("heading", { name: "Club player" })).toBeDefined();
  expect(screen.getByRole("img", { name: "Your player avatar" }).getAttribute("src")).toBe("/profile/avatar?v=2026-09-28T10%3A00%3A00Z");
  expect(screen.getByText("1200")).toBeDefined();
  expect(screen.getByText("6")).toBeDefined();
  fireEvent.click(within(screen.getByRole("navigation", { name: "Profile settings" })).getByRole("button", { name: "Account & security" }));
  expect(screen.getByLabelText("Current password")).toBeDefined();
});
it("uses the existing personal name when no player display name is available", async () => {
  profileContext.mockResolvedValue({ client: {}, account: { state: "active", userId: "owner", email: "owner@example.com", roles: [] } });
  loadProfile.mockResolvedValue({ personal: { first_name: "Ana", last_name: "Popescu" }, player: null });
  render(await ProfilePage());
  expect(screen.getByRole("heading", { name: "Ana Popescu" })).toBeDefined();
  fireEvent.click(within(screen.getByRole("navigation", { name: "Profile settings" })).getByRole("button", { name: "Account & security" }));
  expect(screen.getByText("No assigned roles")).toBeDefined();
});
