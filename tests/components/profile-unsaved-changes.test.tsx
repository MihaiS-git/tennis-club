// @vitest-environment jsdom
import { type ComponentProps } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Toaster, toast } from "sonner";
import type { ProfileActionState } from "../../src/lib/profile/validation";

const { personal, tennis, password, signOut, push, replace, route } = vi.hoisted(() => ({ personal: vi.fn(), tennis: vi.fn(), password: vi.fn(), signOut: vi.fn(), push: vi.fn(), replace: vi.fn(), route: { pathname: "/profile/personal" } }));
vi.mock("../../src/app/profile/actions", () => ({ savePersonalAction: personal, saveTennisAction: tennis, uploadAvatarAction: vi.fn(), removeAvatarAction: vi.fn() }));
vi.mock("../../src/app/account/actions", () => ({ changePasswordAction: password, signOutAction: signOut }));
vi.mock("next/navigation", () => ({ usePathname: () => route.pathname, useRouter: () => ({ bfcacheId: "visit", push, replace }) }));
// Exercise the documented Link.onNavigate contract; real Next routing is covered in E2E.
vi.mock("next/link", () => ({ useLinkStatus: () => ({ pending: false }), default: ({ onNavigate, href, children, replace: shouldReplace, scroll, transitionTypes, ...props }:
  Omit<ComponentProps<"a">, "href"> & { href: string; replace?: boolean; scroll?: boolean; transitionTypes?: string[]; onNavigate?: (event: { preventDefault: () => void }) => void }) =>
  <a {...props} href={href} onClick={(event) => {
    props.onClick?.(event);
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || props.target === "_blank") return;
    event.preventDefault();
    let blocked = false;
    onNavigate?.({ preventDefault: () => { blocked = true; } });
    if (!blocked) (shouldReplace ? replace : push)(href, { scroll, transitionTypes });
  }}>{children}</a> }));

import { ProfileDepartureProvider, ProfileDepartureLink } from "../../src/components/profile-departure-navigation";
import { UserNavigation } from "../../src/components/user-navigation";
import { MobileNavbarControls } from "../../src/components/mobile-navbar-menu";
import { ProfileSettings } from "../../src/app/profile/profile-settings";
import { PersonalInformationForm, TennisProfileForm } from "../../src/app/profile/profile-forms";

const persisted = { first_name: "Mihai", last_name: null, phone: null, date_of_birth: null, address_line1: null, address_line2: null, city: null, postal_code: null, country_code: null };
const player = { display_name: "Mihai", sportya_level: "6", avatar_path: null, rating: null, handedness: null, backhand: null, preferred_game: null, preferred_surface: null, bio: null, updated_at: "2026-09-28T12:00:00Z" };
const pages = {
  personal: () => <ProfileSettings path="/profile/personal"><PersonalInformationForm profile={persisted} /></ProfileSettings>,
  tennis: () => <ProfileSettings path="/profile/tennis"><TennisProfileForm profile={player} /></ProfileSettings>,
};
function app(page: keyof typeof pages = "personal") {
  route.pathname = `/profile/${page}`;
  window.history.replaceState(null, "", route.pathname);
  return <ProfileDepartureProvider>
    <ProfileDepartureLink href="/">Home</ProfileDepartureLink>
    <ProfileDepartureLink href="/courts">Courts</ProfileDepartureLink>
    <ProfileDepartureLink href="/profile" aria-label="Profile">Avatar</ProfileDepartureLink>
    <MobileNavbarControls isAuthenticated canReserve={false} />
    <UserNavigation />
    {pages[page]()}<Toaster closeButton />
  </ProfileDepartureProvider>;
}
const sidebar = () => screen.getByRole("navigation", { name: "My account navigation" });
function change(label: string, value: string) { fireEvent.change(screen.getByLabelText(label), { target: { value } }); }
function save(name: string) { fireEvent.click(screen.getByRole("button", { name })); }
function unload() { const event = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; }
function leave() { fireEvent.click(screen.getByRole("link", { name: "Home" })); }

beforeEach(() => { vi.resetAllMocks(); personal.mockResolvedValue({ success: "Personal saved." }); tennis.mockResolvedValue({ success: "Tennis saved." }); });
afterEach(async () => {
  // Sonner defers insertion, then dismissal schedules an animation/removal timer.
  // Let both finish with the Toaster mounted before unmounting or destroying jsdom.
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  act(() => { toast.dismiss(); });
  await waitFor(() => expect(document.querySelector("[data-sonner-toast]")).toBeNull());
  cleanup();
});

it("derives Tennis profile dirty state and removes unload protection when restored", () => {
  render(app("tennis"));
  expect(unload()).toBe(false);
  expect(screen.getByRole("button", { name: "Save tennis profile" }).hasAttribute("disabled")).toBe(true);
  change("Sportya level", "7"); expect(unload()).toBe(true);
  expect(screen.getByRole("button", { name: "Save tennis profile" }).hasAttribute("disabled")).toBe(false);
  change("Sportya level", "6"); expect(unload()).toBe(false);
  expect(screen.getByRole("button", { name: "Save tennis profile" }).hasAttribute("disabled")).toBe(true);
  leave(); expect(push).toHaveBeenCalledWith("/", expect.anything());
  expect(screen.queryByText(/^You have unsaved changes/)).toBeNull();
});

it.each([
  ["personal", () => { change("First name", "  Mihai  "); change("Last name", "   "); }],
  ["tennis", () => { change("Bio", "   "); }],
] as const)("normalizes nullable and whitespace values on the %s page", (page, edit) => {
  render(app(page)); edit(); expect(unload()).toBe(false);
});

it("advances only the successfully saved baseline", async () => {
  render(app()); change("First name", "Saved name"); save("Save personal information");
  await screen.findByText("Personal saved."); expect(unload()).toBe(false);
  expect(screen.getByRole("button", { name: "Save personal information" }).hasAttribute("disabled")).toBe(true);
  change("First name", "Mihai"); expect(unload()).toBe(true);
  change("First name", "Saved name"); expect(unload()).toBe(false);
});

it("keeps values and the last baseline after a failed tennis save", async () => {
  tennis.mockResolvedValue({ formError: "Save failed." });
  render(app("tennis")); change("Sportya level", "7"); save("Save tennis profile");
  await screen.findByText("Save failed.");
  expect((screen.getByLabelText("Sportya level") as HTMLInputElement).value).toBe("7"); expect(unload()).toBe(true);
  expect(screen.getByRole("button", { name: "Save tennis profile" }).hasAttribute("disabled")).toBe(false);
  change("Sportya level", "6"); expect(unload()).toBe(false);
});

it("does not mark edits made during a pending save as persisted", async () => {
  let finish: (result: ProfileActionState) => void = () => {};
  personal.mockImplementation(() => new Promise<ProfileActionState>((resolve) => { finish = resolve; }));
  render(app()); change("First name", "Submitted"); save("Save personal information");
  await screen.findByRole("button", { name: "Saving…" }); change("First name", "Newer edit");
  await act(async () => finish({ success: "Personal saved." }));
  expect(unload()).toBe(true); expect((screen.getByLabelText("First name") as HTMLInputElement).value).toBe("Newer edit");
  change("First name", "Submitted"); expect(unload()).toBe(false);
});

it("blocks departure, Stay preserves drafts, and repeated attempts use one confirmation with the latest destination", async () => {
  render(app()); change("First name", "Mike"); leave();
  await screen.findByText("You have unsaved changes in Personal information."); expect(push).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Stay" }));
  expect((screen.getByLabelText("First name") as HTMLInputElement).value).toBe("Mike"); expect(unload()).toBe(true);
  // Allow Sonner's dismissal animation before making a fresh attempt.
  await waitFor(() => expect(screen.queryByText("You have unsaved changes in Personal information.")).toBeNull());
  leave(); leave(); fireEvent.click(screen.getByRole("link", { name: "Courts" }));
  await waitFor(() => expect(screen.getAllByText("You have unsaved changes in Personal information.")).toHaveLength(1));
  fireEvent.click(screen.getByRole("button", { name: "Leave without saving" }));
  // The page captures every link departure, including navbar links, through one handler.
  expect(push).toHaveBeenCalledExactlyOnceWith("/courts");
  expect((screen.getByLabelText("First name") as HTMLInputElement).value).toBe("Mihai");
  expect(unload()).toBe(false);
});

it("guards user sidebar links and the navbar Profile link, but not the current page", async () => {
  render(app()); change("First name", "Mike");
  fireEvent.click(within(sidebar()).getByRole("link", { name: "Personal information" }));
  expect(screen.queryByText("You have unsaved changes in Personal information.")).toBeNull();
  fireEvent.click(screen.getByRole("link", { name: "Profile" }));
  await screen.findByText("You have unsaved changes in Personal information.");
  fireEvent.click(within(sidebar()).getByRole("link", { name: "Tennis profile" }));
  await waitFor(() => expect(screen.getAllByText("You have unsaved changes in Personal information.")).toHaveLength(1));
  expect(push).not.toHaveBeenCalledWith("/profile/tennis", expect.anything());
  fireEvent.click(screen.getByRole("button", { name: "Leave without saving" }));
  expect(push).toHaveBeenCalledWith("/profile/tennis");
  expect(push).not.toHaveBeenCalledWith("/profile", expect.anything());
});

it("guards the navbar Sign out before invoking the existing form action", async () => {
  signOut.mockResolvedValue(undefined);
  render(app()); change("First name", "Mike");
  expect(within(sidebar()).queryByRole("button", { name: "Sign out" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Open menu" }));
  fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
  await screen.findByText("You have unsaved changes in Personal information."); expect(signOut).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Stay" })); expect(signOut).not.toHaveBeenCalled();
  await waitFor(() => expect(screen.queryByText("You have unsaved changes in Personal information.")).toBeNull());
  fireEvent.click(screen.getByRole("button", { name: "Open menu" }));
  fireEvent.click(screen.getByRole("button", { name: "Sign out" })); await screen.findByText("You have unsaved changes in Personal information.");
  fireEvent.click(screen.getByRole("button", { name: "Leave without saving" })); await waitFor(() => expect(signOut).toHaveBeenCalledOnce());
});

it("shows the unsaved state beside Save and marks the page for the sidebar indicator", async () => {
  render(app("personal"));
  expect(screen.getByText("No unsaved changes")).toBeTruthy();
  expect(document.querySelector("[data-profile-unsaved]")).toBeNull();
  change("First name", "Changed");
  expect(screen.getByText("Unsaved changes")).toBeTruthy();
  expect(document.querySelector("[data-profile-unsaved]")).not.toBeNull();
  save("Save personal information");
  await waitFor(() => expect(screen.getByText("No unsaved changes")).toBeTruthy());
  expect(document.querySelector("[data-profile-unsaved]")).toBeNull();
});
