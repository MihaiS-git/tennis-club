// @vitest-environment jsdom
import { type ComponentProps } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Toaster, toast } from "sonner";
import type { ProfileActionState } from "../../src/lib/profile/validation";

const { personal, tennis, password, push, replace } = vi.hoisted(() => ({ personal: vi.fn(), tennis: vi.fn(), password: vi.fn(), push: vi.fn(), replace: vi.fn() }));
vi.mock("../../src/app/profile/actions", () => ({ savePersonalAction: personal, saveTennisAction: tennis, uploadAvatarAction: vi.fn(), removeAvatarAction: vi.fn() }));
vi.mock("../../src/app/account/actions", () => ({ changePasswordAction: password }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ bfcacheId: "visit", push, replace }) }));
// Exercise the documented Link.onNavigate contract; real Next routing is covered in E2E.
vi.mock("next/link", () => ({ default: ({ onNavigate, href, children, replace: shouldReplace, scroll, transitionTypes, ...props }:
  Omit<ComponentProps<"a">, "href"> & { href: string; replace?: boolean; scroll?: boolean; transitionTypes?: string[]; onNavigate?: (event: { preventDefault: () => void }) => void }) =>
  <a {...props} href={href} onClick={(event) => {
    props.onClick?.(event);
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || props.target === "_blank") return;
    event.preventDefault();
    let blocked = false;
    onNavigate?.({ preventDefault: () => { blocked = true; } });
    if (!blocked) (shouldReplace ? replace : push)(href, { scroll, transitionTypes });
  }}>{children}</a> }));

import { ProfileDepartureProvider, ProfileDepartureLink, ProfileDepartureForm } from "../../src/components/profile-departure-navigation";
import { ProfileSettings } from "../../src/app/profile/profile-settings";
import { PersonalInformationForm, TennisProfileForm } from "../../src/app/profile/profile-forms";

const persisted = { first_name: "Mihai", last_name: null, phone: null, date_of_birth: null, address_line1: null, address_line2: null, city: null, postal_code: null, country_code: null };
const player = { display_name: "Mihai", sportya_level: "6", avatar_path: null, rating: null, handedness: null, backhand: null, preferred_game: null, preferred_surface: null, bio: null, updated_at: "2026-09-28T12:00:00Z" };
function settings(firstName = "Mihai") {
  return <ProfileSettings identity={<p>Identity</p>} personal={<PersonalInformationForm profile={{ ...persisted, first_name: firstName }} />}
    tennis={<TennisProfileForm profile={player} />} account={<input aria-label="Password" />} />;
}
function app(content = settings()) {
  return <ProfileDepartureProvider>
    <ProfileDepartureLink href="/">Home</ProfileDepartureLink>
    <ProfileDepartureLink href="/courts">Courts</ProfileDepartureLink>
    <ProfileDepartureLink href="/profile">Profile link</ProfileDepartureLink>
    {content}<Toaster closeButton />
  </ProfileDepartureProvider>;
}
function section(name: string) { fireEvent.click(screen.getByRole("button", { name: new RegExp(`^${name}(?:, unsaved changes)?$`) })); }
function change(label: string, value: string) { fireEvent.change(screen.getByLabelText(label), { target: { value } }); }
function save(name: string) { fireEvent.click(screen.getByRole("button", { name })); }
function unload() { const event = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; }
function leave() { fireEvent.click(screen.getByRole("link", { name: "Home" })); }

beforeEach(() => { vi.resetAllMocks(); personal.mockResolvedValue({ success: "Personal saved." }); tennis.mockResolvedValue({ success: "Tennis saved." }); window.history.replaceState(null, "", "/profile"); });
afterEach(() => { cleanup(); act(() => { toast.dismiss(); }); });

it.each([['Tennis profile', 'Sportya level', '7', '6']])("derives %s dirty state and removes unload protection when restored", (tab, label, edited, original) => {
  render(app());
  expect(unload()).toBe(false);
  const selector = screen.getByRole("navigation", { name: "Profile settings" });
  section(tab);
  const saveName = tab === "Personal information" ? "Save personal information" : "Save tennis profile";
  expect(within(selector).queryByRole("img", { name: "Unsaved changes" })).toBeNull();
  expect(screen.getByRole("button", { name: saveName }).hasAttribute("disabled")).toBe(true);
  change(label, edited); expect(unload()).toBe(true);
  const dirtyTab = within(selector).getByRole("button", { name: `${tab}, unsaved changes` });
  expect(within(selector).getAllByRole("img", { name: "Unsaved changes" })).toHaveLength(1);
  expect(within(dirtyTab).getByRole("img", { name: "Unsaved changes" })).toBeDefined();
  expect(screen.getByRole("button", { name: saveName }).hasAttribute("disabled")).toBe(false);
  change(label, original); expect(unload()).toBe(false);
  expect(within(selector).getByRole("button", { name: tab })).toBeDefined();
  expect(within(selector).queryByRole("img", { name: "Unsaved changes" })).toBeNull();
  expect(screen.getByRole("button", { name: saveName }).hasAttribute("disabled")).toBe(true);
  leave(); expect(push).toHaveBeenCalledWith("/", expect.anything());
  expect(screen.queryByText(/^You have unsaved changes/)).toBeNull();
});

it("normalizes nullable and whitespace values and ignores password drafts", () => {
  render(app()); section("Personal information");
  change("First name", "  Mihai  "); change("Last name", "   "); expect(unload()).toBe(false);
  section("Tennis profile"); change("Bio", "   "); expect(unload()).toBe(false);
  section("Account & security"); change("Password", "draft password"); expect(unload()).toBe(false);
});

it("advances only the successfully saved baseline and keeps the other form dirty", async () => {
  render(app()); section("Personal information"); change("First name", "Mike");
  section("Tennis profile"); change("Sportya level", "7"); save("Save tennis profile");
  await screen.findByText("Tennis saved.");
  const selector = screen.getByRole("navigation", { name: "Profile settings" });
  expect(within(selector).getAllByRole("img", { name: "Unsaved changes" })).toHaveLength(1);
  expect(within(selector).getByRole("button", { name: "Personal information, unsaved changes" })).toBeDefined();
  expect(within(selector).getByRole("button", { name: "Tennis profile" })).toBeDefined();
  expect(screen.getByRole("button", { name: "Save tennis profile" }).hasAttribute("disabled")).toBe(true);
  section("Personal information");
  expect(screen.getByRole("button", { name: "Save personal information" }).hasAttribute("disabled")).toBe(false);
  expect(unload()).toBe(true); leave(); await screen.findByText("You have unsaved changes in Personal information.");
  expect(push).not.toHaveBeenCalled(); fireEvent.click(screen.getByRole("button", { name: "Stay" }));
  section("Personal information"); change("First name", "Mihai"); expect(unload()).toBe(false);
  section("Tennis profile"); change("Sportya level", "6"); expect(unload()).toBe(true);
  change("Sportya level", "7"); expect(unload()).toBe(false);
  section("Personal information"); change("First name", "Saved name"); save("Save personal information");
  await screen.findByText("Personal saved."); expect(unload()).toBe(false);
  change("First name", "Mihai"); expect(unload()).toBe(true);
  change("First name", "Saved name"); expect(unload()).toBe(false);
});

it.each(["tennis"])("keeps values and the last baseline after a failed %s save", async (form) => {
  const isPersonal = form === "personal";
  (isPersonal ? personal : tennis).mockResolvedValue({ formError: "Save failed." });
  render(app()); section(isPersonal ? "Personal information" : "Tennis profile");
  const label = isPersonal ? "First name" : "Sportya level";
  const value = isPersonal ? "Mike" : "7";
  change(label, value); save(isPersonal ? "Save personal information" : "Save tennis profile");
  await screen.findByText("Save failed.");
  expect((screen.getByLabelText(label) as HTMLInputElement).value).toBe(value); expect(unload()).toBe(true);
  const title = isPersonal ? "Personal information" : "Tennis profile";
  const dirtyTab = screen.getByRole("button", { name: `${title}, unsaved changes` });
  expect(within(dirtyTab).getByRole("img", { name: "Unsaved changes" })).toBeDefined();
  expect(screen.getByRole("button", { name: isPersonal ? "Save personal information" : "Save tennis profile" }).hasAttribute("disabled")).toBe(false);
  change(label, isPersonal ? "Mihai" : "6"); expect(unload()).toBe(false);
});

it("does not mark edits made during a pending save as persisted", async () => {
  let finish: (result: ProfileActionState) => void = () => {};
  personal.mockImplementation(() => new Promise<ProfileActionState>((resolve) => { finish = resolve; }));
  render(app()); section("Personal information"); change("First name", "Submitted"); save("Save personal information");
  await screen.findByRole("button", { name: "Saving…" }); change("First name", "Newer edit");
  await act(async () => finish({ success: "Personal saved." }));
  expect(unload()).toBe(true); expect((screen.getByLabelText("First name") as HTMLInputElement).value).toBe("Newer edit");
  change("First name", "Submitted"); expect(unload()).toBe(false);
});

it("blocks departure, Stay preserves drafts, and repeated attempts use one confirmation with the latest destination", async () => {
  render(app()); section("Personal information"); change("First name", "Mike"); leave();
  await screen.findByText("You have unsaved changes in Personal information."); expect(push).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Stay" }));
  expect((screen.getByLabelText("First name") as HTMLInputElement).value).toBe("Mike"); expect(unload()).toBe(true);
  // Allow Sonner's dismissal animation before making a fresh attempt.
  await waitFor(() => expect(screen.queryByText("You have unsaved changes in Personal information.")).toBeNull());
  leave(); leave(); fireEvent.click(screen.getByRole("link", { name: "Courts" }));
  await waitFor(() => expect(screen.getAllByText("You have unsaved changes in Personal information.")).toHaveLength(1));
  fireEvent.click(screen.getByRole("button", { name: "Leave without saving" }));
  expect(push).toHaveBeenCalledExactlyOnceWith("/courts", expect.anything());
  section("Personal information"); expect((screen.getByLabelText("First name") as HTMLInputElement).value).toBe("Mihai");
  expect(unload()).toBe(false);
});

it("guards sign out before invoking the existing form action", async () => {
  const signOut = vi.fn().mockResolvedValue(undefined);
  render(app(<>{settings()}<ProfileDepartureForm action={signOut}><button>Sign out</button></ProfileDepartureForm></>));
  section("Personal information"); change("First name", "Mike"); fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
  await screen.findByText("You have unsaved changes in Personal information."); expect(signOut).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Stay" })); expect(signOut).not.toHaveBeenCalled();
  await waitFor(() => expect(screen.queryByText("You have unsaved changes in Personal information.")).toBeNull());
  fireEvent.click(screen.getByRole("button", { name: "Sign out" })); await screen.findByText("You have unsaved changes in Personal information.");
  fireEvent.click(screen.getByRole("button", { name: "Leave without saving" })); await waitFor(() => expect(signOut).toHaveBeenCalledOnce());
});
