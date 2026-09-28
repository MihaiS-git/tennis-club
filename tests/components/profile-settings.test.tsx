// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { ProfileSettings } from "../../src/app/profile/profile-settings";

afterEach(cleanup);

it("provides labelled section controls and preserves edits when switching settings", () => {
  render(<ProfileSettings
    identity={<section aria-label="Player identity">Player summary</section>}
    personal={<input aria-label="First name" defaultValue="Ana" />}
    tennis={<input aria-label="Sportya level" defaultValue="" />}
    account={<input aria-label="Current password" type="password" defaultValue="" />}
  />);
  const navigation = screen.getByRole("navigation", { name: "Profile settings" });
  const identity = within(navigation).getByRole("button", { name: "Profile / player identity" });
  const personal = within(navigation).getByRole("button", { name: "Personal information" });
  const tennis = within(navigation).getByRole("button", { name: "Tennis profile" });
  const account = within(navigation).getByRole("button", { name: "Account & security" });
  expect(identity.getAttribute("aria-pressed")).toBe("true");
  expect(screen.getAllByRole("region")).toHaveLength(1);
  expect(screen.getByRole("region", { name: "Player identity" })).toBeDefined();
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
