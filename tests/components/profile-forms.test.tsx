// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ProfileActionState } from "../../src/lib/profile/validation";
const { personal, tennis, upload, remove, success } = vi.hoisted(() => ({
  personal: vi.fn(), tennis: vi.fn(), upload: vi.fn(), remove: vi.fn(), success: vi.fn(),
}));
vi.mock("../../src/app/profile/actions", () => ({ savePersonalAction: personal, saveTennisAction: tennis, uploadAvatarAction: upload, removeAvatarAction: remove }));
vi.mock("sonner", () => ({ toast: { success } }));
import { PersonalInformationForm, TennisProfileForm, AvatarForms } from "../../src/app/profile/profile-forms";
const emptyPersonal = { first_name: null, last_name: null, phone: null, date_of_birth: null, address_line1: null, address_line2: null, city: null, postal_code: null, country_code: null };
beforeEach(() => { vi.resetAllMocks(); personal.mockResolvedValue({}); tennis.mockResolvedValue({}); });
afterEach(cleanup);

it("preserves personal values and shows accessible inline validation", async () => {
  personal.mockResolvedValue({ fieldErrors: { phone: "Use at most 40 characters." } });
  render(<PersonalInformationForm profile={emptyPersonal} />);
  const first = screen.getByLabelText("First name"); const phone = screen.getByLabelText("Phone");
  fireEvent.change(first, { target: { value: "Ana" } }); fireEvent.change(phone, { target: { value: "wrong" } });
  fireEvent.submit(screen.getByRole("button", { name: "Save personal information" }).closest("form")!);
  await screen.findByText("Use at most 40 characters.");
  expect(phone.getAttribute("aria-invalid")).toBe("true"); expect(phone.getAttribute("aria-describedby")).toBe("phone-error");
  expect((first as HTMLInputElement).value).toBe("Ana");
  fireEvent.change(phone, { target: { value: "123" } }); expect(screen.queryByText("Use at most 40 characters.")).toBeNull();
});
it("uses pending feedback and Sonner for a successful save", async () => {
  let finish: (state: ProfileActionState) => void = () => {};
  personal.mockImplementation(() => new Promise<ProfileActionState>((resolve) => { finish = resolve; }));
  render(<PersonalInformationForm profile={emptyPersonal} />);
  fireEvent.submit(screen.getByRole("button", { name: "Save personal information" }).closest("form")!);
  const pending = await screen.findByRole("button", { name: "Saving…" }); expect(pending.hasAttribute("disabled")).toBe(true);
  finish({ success: "Personal information saved." }); await waitFor(() => expect(success).toHaveBeenCalledWith("Personal information saved."));
});
it("shows system rating without submitting it, and keeps tennis and personal saves separate", async () => {
  render(<TennisProfileForm profile={{ display_name: "Ana", avatar_path: null, rating: 1200, sportya_level: null, handedness: null, backhand: null, preferred_game: null, preferred_surface: null, bio: null, updated_at: "2026-09-28T12:00:00Z" }} />);
  expect(screen.getByText("1200")).toBeDefined(); expect(document.querySelector('[name="rating"]')).toBeNull();
  fireEvent.change(screen.getByLabelText("Preferred game"), { target: { value: "doubles" } });
  fireEvent.submit(screen.getByRole("button", { name: "Save tennis profile" }).closest("form")!);
  await waitFor(() => expect(tennis).toHaveBeenCalledOnce()); expect(personal).not.toHaveBeenCalled();
  const data = tennis.mock.calls[0][1] as FormData;
  expect(data.get("preferred_game")).toBe("doubles"); expect(data.has("rating")).toBe(false); expect(data.has("user_id")).toBe(false);
});
it("shows the avatar lifecycle controls", () => {
  const view = render(<AvatarForms hasAvatar={false} hasProfile={false} />);
  expect(screen.getByText("Save your tennis profile to add an avatar.")).toBeDefined();
  view.rerender(<AvatarForms hasAvatar hasProfile />);
  fireEvent.click(screen.getByText("Edit photo"));
  expect(screen.getByLabelText("Change avatar").getAttribute("accept")).toBe("image/jpeg,image/png,image/webp");
  expect(screen.getByRole("button", { name: "Remove avatar" })).toBeDefined();
});
it("presents Country with a helpful hint while preserving the submitted code and validation", async () => {
  personal.mockResolvedValue({ fieldErrors: { country_code: "Enter a two-letter country code." } });
  render(<PersonalInformationForm profile={emptyPersonal} />);
  const country = screen.getByLabelText("Country");
  expect(country.getAttribute("name")).toBe("country_code");
  expect(country.getAttribute("aria-describedby")).toBe("country-help");
  fireEvent.change(country, { target: { value: "RO" } });
  fireEvent.submit(screen.getByRole("button", { name: "Save personal information" }).closest("form")!);
  await screen.findByText("Enter a two-letter country code.");
  expect(country.getAttribute("aria-describedby")).toBe("country-help country_code-error");
  expect(personal.mock.calls[0][1].get("country_code")).toBe("RO");
});
