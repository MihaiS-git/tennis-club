// @vitest-environment jsdom
import { Activity, type ComponentProps } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Toaster, toast } from "sonner";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
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
import { ChangePasswordForm } from "../../src/components/auth/change-password-form";

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

it("offers section navigation only once hydration can handle the click", async () => {
  const content = <ProfileSettings identity={<p>Identity</p>} personal={<p>Personal content</p>}
    tennis={<p>Tennis content</p>} account={<p>Account content</p>} />;
  const container = document.createElement("div");
  document.body.append(container);
  container.innerHTML = renderToString(content);
  const selector = within(container).getByRole("navigation", { name: "Profile settings" });
  const buttons = within(selector).getAllByRole("button");
  const accountButton = within(selector).getByRole("button", { name: "Account & security" });
  for (const button of buttons) expect(button.hasAttribute("disabled")).toBe(true);
  accountButton.click();
  expect(accountButton.getAttribute("aria-pressed")).toBe("false");
  const root = hydrateRoot(container, content);
  try {
    await act(async () => {});
    for (const button of buttons) expect(button.hasAttribute("disabled")).toBe(false);
    fireEvent.click(accountButton);
    expect(accountButton.getAttribute("aria-pressed")).toBe("true");
    expect(within(container).getByRole("heading", { name: "Account & security" })).toBeDefined();
    expect(within(container).getByText("Account content").closest("[hidden]")).toBeNull();
    expect(within(container).getByText("Identity").closest("[hidden]")).not.toBeNull();
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it.each([['Personal information', 'First name', 'Mike', 'Mihai'], ['Tennis profile', 'Sportya level', '7', '6']])("derives %s dirty state and removes unload protection when restored", (tab, label, edited, original) => {
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

it("clears only credentials after password-change success and preserves both Profile drafts and baselines", async () => {
  password.mockResolvedValue({ success: "Your password has been changed." });
  render(app(<ProfileSettings identity={<p>Identity</p>}
    personal={<PersonalInformationForm profile={persisted} />}
    tennis={<TennisProfileForm profile={player} />} account={<ChangePasswordForm />} />));
  section("Personal information"); change("First name", "Mike");
  section("Tennis profile"); change("Sportya level", "7");
  section("Account & security");
  change("Current password", "current-password");
  change("New password", "new-password-123");
  change("Confirm new password", "new-password-123");
  // Clearing must also work when a credential is displayed as text.
  fireEvent.click(screen.getAllByRole("button", { name: "Show password" })[0]);
  save("Change password");
  expect(await screen.findByRole("status")).toHaveProperty("textContent", "Your password has been changed.");
  for (const label of ["Current password", "New password", "Confirm new password"]) {
    expect(screen.getByLabelText(label)).toHaveProperty("value", "");
  }
  expect(password).toHaveBeenCalledOnce();
  expect(push).not.toHaveBeenCalled(); expect(replace).not.toHaveBeenCalled();
  const selector = screen.getByRole("navigation", { name: "Profile settings" });
  expect(within(selector).getAllByRole("img", { name: "Unsaved changes" })).toHaveLength(2);
  section("Personal information");
  expect(screen.getByLabelText("First name")).toHaveProperty("value", "Mike");
  expect(screen.getByRole("button", { name: "Save personal information" }).hasAttribute("disabled")).toBe(false);
  section("Tennis profile");
  expect(screen.getByLabelText("Sportya level")).toHaveProperty("value", "7");
  expect(screen.getByRole("button", { name: "Save tennis profile" }).hasAttribute("disabled")).toBe(false);
  expect(unload()).toBe(true);
  leave(); await screen.findByText("You have unsaved changes in 2 sections.");
  fireEvent.click(screen.getByRole("button", { name: "Stay" }));
  section("Personal information"); change("First name", "Mihai");
  section("Tennis profile"); change("Sportya level", "6"); expect(unload()).toBe(false);
  section("Account & security"); change("New password", "another password draft"); expect(unload()).toBe(false);
});

it.each(["Personal information", "Tennis profile", "both"])("identifies %s drafts in departure confirmation", async (dirtySection) => {
  render(app());
  if (dirtySection !== "Tennis profile") {
    section("Personal information"); change("First name", "Mike");
  }
  if (dirtySection !== "Personal information") {
    section("Tennis profile"); change("Sportya level", "7");
  }
  leave();
  const message = dirtySection === "both" ? "You have unsaved changes in 2 sections." : `You have unsaved changes in ${dirtySection}.`;
  const messageElement = await screen.findByText(message);
  expect(push).not.toHaveBeenCalled();
  const confirmation = messageElement.closest("[data-sonner-toast]");
  if (!(confirmation instanceof HTMLElement)) throw new Error("Expected a Sonner confirmation");
  expect(within(confirmation).getByRole("button", { name: "Stay" })).toBeDefined();
  expect(within(confirmation).getByRole("button", { name: "Leave without saving" })).toBeDefined();
  expect(within(confirmation).getAllByRole("button")).toHaveLength(2);
  expect(within(confirmation).queryByRole("button", { name: "Close toast" })).toBeNull();
  expect(messageElement.parentElement?.querySelector("button")).toBeNull();
});

it("preserves dirty drafts through internal sections and same-profile links", () => {
  render(app()); section("Personal information"); change("First name", "Mike");
  section("Tennis profile"); change("Sportya level", "7");
  const selector = screen.getByRole("navigation", { name: "Profile settings" });
  expect(within(selector).getAllByRole("img", { name: "Unsaved changes" })).toHaveLength(2);
  section("Account & security"); section("Profile / player identity"); section("Personal information");
  expect(within(selector).getAllByRole("img", { name: "Unsaved changes" })).toHaveLength(2);
  expect((screen.getByLabelText("First name") as HTMLInputElement).value).toBe("Mike");
  section("Tennis profile");
  expect((screen.getByLabelText("Sportya level") as HTMLSelectElement).value).toBe("7");
  expect(within(selector).getAllByRole("img", { name: "Unsaved changes" })).toHaveLength(2);
  section("Personal information");
  fireEvent.click(screen.getByRole("link", { name: "Profile link" }));
  expect(screen.queryByText(/^You have unsaved changes/)).toBeNull(); expect(unload()).toBe(true);
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

it.each(["personal", "tennis"])("keeps values and the last baseline after a failed %s save", async (form) => {
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

it("creates a usable confirmation immediately after Stay, isolated from retired callbacks and Sonner removal", async () => {
  const warning = vi.spyOn(toast, "warning");
  try {
    render(app()); section("Personal information"); change("First name", "Mike"); leave();
    const message = await screen.findByText("You have unsaved changes in Personal information.");
    const retired = message.closest("[data-sonner-toast]");
    if (!(retired instanceof HTMLElement)) throw new Error("Expected a Sonner confirmation");
    const retiredOptions = warning.mock.calls[0][1];
    const retiredToast = toast.getHistory().find((item) => item.id === warning.mock.results[0].value);
    if (!retiredOptions || !retiredToast) throw new Error("Expected the first confirmation options and toast");
    fireEvent.click(within(retired).getByRole("button", { name: "Stay" }));
    expect(retired.getAttribute("data-removed")).toBe("true");
    // No wait for Sonner's exit timer: a second departure starts now.
    fireEvent.click(screen.getByRole("link", { name: "Courts" }));
    expect(retired.isConnected).toBe(true);
    await waitFor(() => expect(document.querySelectorAll('[data-sonner-toast][data-removed="false"]')).toHaveLength(1));
    const active = document.querySelector('[data-sonner-toast][data-removed="false"]');
    if (!(active instanceof HTMLElement)) throw new Error("Expected a fresh active confirmation");
    expect(active).not.toBe(retired);
    expect(within(active).getByRole("button", { name: "Stay" })).toBeDefined();
    expect(within(active).getByRole("button", { name: "Leave without saving" })).toBeDefined();
    expect(warning).toHaveBeenCalledTimes(2);
    // Late callbacks from the old confirmation cannot cancel or execute the new continuation.
    act(() => retiredOptions.onDismiss?.(retiredToast));
    fireEvent.click(within(retired).getByRole("button", { name: "Stay" }));
    fireEvent.click(within(retired).getByRole("button", { name: "Leave without saving" }));
    expect(push).not.toHaveBeenCalled(); expect(unload()).toBe(true);
    leave(); fireEvent.click(screen.getByRole("link", { name: "Courts" }));
    expect(warning).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(retired.isConnected).toBe(false));
    expect(active.isConnected).toBe(true);
    expect(active.getAttribute("data-removed")).toBe("false");
    fireEvent.click(within(active).getByRole("button", { name: "Leave without saving" }));
    expect(push).toHaveBeenCalledExactlyOnceWith("/courts", expect.anything());
    expect(unload()).toBe(false);
  } finally {
    warning.mockRestore();
  }
});

it("removes protection when Activity hides Profile and returns with current server values", () => {
  const view = render(app(<Activity mode="visible">{settings()}</Activity>));
  section("Personal information"); change("First name", "Discarded"); expect(unload()).toBe(true);
  view.rerender(app(<Activity mode="hidden">{settings("Current server name")}</Activity>)); expect(unload()).toBe(false);
  view.rerender(app(<Activity mode="visible">{settings("Current server name")}</Activity>));
  section("Personal information"); expect((screen.getByLabelText("First name") as HTMLInputElement).value).toBe("Current server name"); expect(unload()).toBe(false);
  view.unmount(); expect(unload()).toBe(false);
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
