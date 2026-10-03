// @vitest-environment jsdom
import { Activity, StrictMode, useState } from "react";
import { ProfileDepartureLink as Link, ProfileDepartureProvider } from "../../src/components/profile-departure-navigation";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { ProfileSettings } from "../../src/app/profile/profile-settings";

vi.mock("next/navigation", () => ({ useRouter: () => ({ bfcacheId: "profile-visit" }) }));
vi.mock("next/link", () => ({ default: ({ onNavigate, onClick, href, children, ...props }: import("react").ComponentProps<"a"> & { onNavigate?: (event: { preventDefault: () => void }) => void }) =>
  <a {...props} href={href} onClick={(event) => {
    onClick?.(event);
    if (!event.defaultPrevented && event.button === 0 && !event.ctrlKey && !event.metaKey && props.target !== "_blank") onNavigate?.({ preventDefault: () => event.preventDefault() });
    event.preventDefault();
  }}>{children}</a> }));

beforeEach(() => window.history.replaceState(null, "", "/profile"));
afterEach(() => { cleanup(); window.history.replaceState(null, "", "/"); });

function PersonalDraft({ firstName }: { firstName: string }) {
  const [value, setValue] = useState(firstName);
  return <input aria-label="First name" value={value} onChange={(event) => setValue(event.target.value)} />;
}

function settings(firstName: string) {
  return <ProfileSettings identity={<p>Player summary</p>} personal={<PersonalDraft firstName={firstName} />}
    tennis={<p>Tennis details</p>} account={<p>Account details</p>} />;
}

function selectPersonal() {
  fireEvent.click(screen.getByRole("button", { name: "Personal information" }));
  return screen.getByLabelText("First name") as HTMLInputElement;
}

it("discards drafts on a link departure even if a quick return keeps the same route tree", () => {
  render(<StrictMode><ProfileDepartureProvider>
    <Link href="/">Club homepage</Link>
    {settings("Saved name")}
  </ProfileDepartureProvider></StrictMode>);
  fireEvent.change(selectPersonal(), { target: { value: "Unsaved draft" } });
  fireEvent.click(screen.getByRole("button", { name: "Tennis profile" }));
  expect(selectPersonal().value).toBe("Unsaved draft");
  fireEvent.click(screen.getByRole("link", { name: "Club homepage" }));
  expect(selectPersonal().value).toBe("Saved name");
});

it.each(["", "Saved name"])("starts fresh with current server data %j after Activity restores a visit", (firstName) => {
  const view = render(<Activity mode="visible">{settings("Previous name")}</Activity>);
  fireEvent.change(selectPersonal(), { target: { value: "Unsaved draft" } });
  view.rerender(<Activity mode="hidden">{settings(firstName)}</Activity>);
  view.rerender(<Activity mode="visible">{settings(firstName)}</Activity>);
  expect(selectPersonal().value).toBe(firstName);
});

it("preserves drafts for same-route links and links opened in another tab", () => {
  render(<>
    <Link href="/profile#personal" onClick={(event) => event.preventDefault()}>Profile section</Link>
    <Link href="/" target="_blank" onClick={(event) => event.preventDefault()}>Homepage in another tab</Link>
    <Link href="/">Club homepage</Link>
    {settings("Saved name")}
  </>);
  fireEvent.change(selectPersonal(), { target: { value: "Unsaved draft" } });
  fireEvent.click(screen.getByRole("link", { name: "Profile section" }));
  fireEvent.click(screen.getByRole("link", { name: "Homepage in another tab" }));
  fireEvent.click(screen.getByRole("link", { name: "Club homepage" }), { ctrlKey: true });
  expect(selectPersonal().value).toBe("Unsaved draft");
});

it("provides labelled section controls and preserves edits when switching settings", () => {
  render(<ProfileSettings
    identity={<section aria-label="Player identity">Player summary</section>}
    personal={<input aria-label="First name" defaultValue="Ana" />}
    tennis={<input aria-label="Sportya level" defaultValue="" />}
    account={<input aria-label="Current password" type="password" defaultValue="" />}
  />);
  const navigation = screen.getByRole("navigation", { name: "Profile settings" });
  expect(within(navigation).queryByRole("button", { name: "Bookings & reservations" })).toBeNull();
  const identity = within(navigation).getByRole("button", { name: "Profile / player identity" });
  const personal = within(navigation).getByRole("button", { name: "Personal information" });
  const tennis = within(navigation).getByRole("button", { name: "Tennis profile" });
  const account = within(navigation).getByRole("button", { name: "Account & security" });
  expect(identity.getAttribute("aria-pressed")).toBe("true");
  expect(screen.getAllByRole("region")).toHaveLength(1);
  expect(screen.getByRole("region", { name: "Player identity" })).toBeDefined();
  expect(within(navigation).getAllByRole("button")).toHaveLength(4);
  for (const control of [identity, personal, tennis, account]) {
    const section = document.getElementById(control.getAttribute("aria-controls")!);
    expect(section).not.toBeNull();
    fireEvent.click(control);
    expect(section?.hidden).toBe(false);
    expect(screen.getAllByRole("region")).toHaveLength(1);
    expect(within(navigation).getAllByRole("button", { pressed: true })).toEqual([control]);
  }
  fireEvent.click(personal);
  fireEvent.change(screen.getByLabelText("First name"), { target: { value: "Ana Maria" } });
  fireEvent.click(tennis);
  expect(tennis.getAttribute("aria-pressed")).toBe("true");
  expect(personal.getAttribute("aria-pressed")).toBe("false");
  fireEvent.change(screen.getByLabelText("Sportya level"), { target: { value: "My existing level" } });
  fireEvent.click(account);
  fireEvent.change(screen.getByLabelText("Current password"), { target: { value: "entered-password" } });
  fireEvent.click(personal);
  expect((screen.getByLabelText("First name") as HTMLInputElement).value).toBe("Ana Maria");
  expect((screen.getByLabelText("Sportya level") as HTMLInputElement).value).toBe("My existing level");
  expect((screen.getByLabelText("Current password") as HTMLInputElement).value).toBe("entered-password");
  fireEvent.click(identity);
  expect(screen.getByRole("region", { name: "Player identity" })).toBeDefined();
  expect(screen.queryByRole("region", { name: "Personal information" })).toBeNull();
});
