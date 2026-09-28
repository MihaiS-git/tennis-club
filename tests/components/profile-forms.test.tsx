// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

it.each([["Romania", "RO", "🇷🇴"], ["France", "FR", "🇫🇷"], ["United Kingdom", "GB", "🇬🇧"]])("searches English names and submits %s as %s", async (name, code, flag) => {
  render(<PersonalInformationForm profile={emptyPersonal} />);
  const country = screen.getByRole("combobox", { name: "Country" });
  fireEvent.focus(country);
  fireEvent.change(country, { target: { value: name.toUpperCase() } });
  const list = screen.getByRole("listbox", { name: "Countries" });
  expect(within(list).getAllByRole("option")).toHaveLength(1);
  const option = within(list).getByRole("option", { name });
  expect(within(option).getByText(flag).getAttribute("aria-hidden")).toBe("true");
  fireEvent.click(option);
  expect((country as HTMLInputElement).value).toBe(name);
  expect(country.parentElement?.querySelector('[aria-hidden="true"]')?.textContent).toBe(flag);
  fireEvent.submit(screen.getByRole("button", { name: "Save personal information" }).closest("form")!);
  await waitFor(() => expect(personal).toHaveBeenCalledOnce());
  expect(personal.mock.calls[0][1].get("country_code")).toBe(code);
  expect(screen.queryByText(/two-letter abbreviation/)).toBeNull();
});
it("loads an existing country and supports keyboard search, selection, Escape and errors", async () => {
  personal.mockResolvedValue({ fieldErrors: { country_code: "Select a supported country." } });
  render(<PersonalInformationForm profile={{ ...emptyPersonal, country_code: "RO" }} />);
  const country = screen.getByRole("combobox", { name: "Country" });
  expect((country as HTMLInputElement).value).toBe("Romania");
  const selectedFlag = country.parentElement?.querySelector('[aria-hidden="true"]');
  expect(selectedFlag?.textContent).toBe("🇷🇴");
  expect(selectedFlag?.getAttribute("aria-hidden")).toBe("true");
  fireEvent.focus(country);
  fireEvent.change(country, { target: { value: "united" } });
  fireEvent.keyDown(country, { key: "ArrowDown" });
  expect(document.getElementById(country.getAttribute("aria-activedescendant")!)?.textContent).toBe("🇬🇧United Kingdom");
  fireEvent.keyDown(country, { key: "Enter" });
  expect((country as HTMLInputElement).value).toBe("United Kingdom");
  expect(country.getAttribute("aria-expanded")).toBe("false");
  fireEvent.keyDown(country, { key: "ArrowDown" });
  fireEvent.change(country, { target: { value: "invalid country" } });
  expect(screen.getByRole("status").textContent).toBe("No countries found.");
  fireEvent.keyDown(country, { key: "Escape" });
  expect((country as HTMLInputElement).value).toBe("United Kingdom");
  fireEvent.submit(screen.getByRole("button", { name: "Save personal information" }).closest("form")!);
  await screen.findByText("Select a supported country.");
  expect(country.getAttribute("aria-invalid")).toBe("true");
  expect(country.getAttribute("aria-describedby")).toBe("country_code-error");
  expect(personal.mock.calls[0][1].get("country_code")).toBe("GB");
  fireEvent.focus(country);
  fireEvent.change(country, { target: { value: "france" } });
  fireEvent.keyDown(country, { key: "Enter" });
  expect(screen.queryByText("Select a supported country.")).toBeNull();
});
it("never submits a free-form country search value and permits clearing a country", async () => {
  render(<PersonalInformationForm profile={emptyPersonal} />);
  const country = screen.getByRole("combobox", { name: "Country" });
  expect(country.getAttribute("placeholder")).toBe("Select a country");
  expect(country.parentElement?.querySelector('[aria-hidden="true"]')).toBeNull();
  fireEvent.focus(country);
  fireEvent.change(country, { target: { value: "arbitrary" } });
  fireEvent.blur(country);
  expect((country as HTMLInputElement).value).toBe("");
  fireEvent.focus(country);
  fireEvent.click(screen.getByRole("option", { name: "Not specified" }));
  fireEvent.submit(screen.getByRole("button", { name: "Save personal information" }).closest("form")!);
  await waitFor(() => expect(personal).toHaveBeenCalledOnce());
  expect(personal.mock.calls[0][1].get("country_code")).toBe("");
});
it.each([
  ["Mihai", "Suciu", "Mihai Suciu"], ["Mihai", null, "Mihai"], [null, "Suciu", "Suciu"], [null, null, ""],
])("initially displays the effective personal name for %s / %s", (first_name, last_name, expected) => {
  render(<TennisProfileForm profile={null} personal={{ first_name, last_name }} />);
  expect((screen.getByLabelText("Display name") as HTMLInputElement).value).toBe(expected);
});
it("keeps a chosen display name after personal-name changes and submits only individual Sportya levels", async () => {
  const profile = { display_name: "Chosen player", avatar_path: null, rating: null, sportya_level: "6", handedness: null, backhand: null, preferred_game: null, preferred_surface: null, bio: null, updated_at: "2026-09-28T12:00:00Z" };
  const view = render(<TennisProfileForm profile={profile} personal={{ first_name: "Mihai", last_name: "Suciu" }} />);
  view.rerender(<TennisProfileForm profile={profile} personal={{ first_name: "Changed", last_name: "Name" }} />);
  expect((screen.getByLabelText("Display name") as HTMLInputElement).value).toBe("Chosen player");
  const sportya = screen.getByRole("combobox", { name: "Sportya level" });
  expect(within(sportya).getAllByRole("option").map((option) => [option.textContent, (option as HTMLOptionElement).value]))
    .toEqual([["Not specified", ""], ...["4", "5", "6", "7", "8", "9"].map((value) => [`Level ${value}`, value])]);
  fireEvent.change(sportya, { target: { value: "9" } });
  fireEvent.submit(screen.getByRole("button", { name: "Save tennis profile" }).closest("form")!);
  await waitFor(() => expect(tennis).toHaveBeenCalledOnce());
  expect(tennis.mock.calls[0][1].get("sportya_level")).toBe("9");
});
it("keeps photo upload and replacement/removal behind Edit photo using the existing actions", async () => {
  upload.mockResolvedValue({ success: "Avatar saved." }); remove.mockResolvedValue({ success: "Avatar removed." });
  const view = render(<AvatarForms hasAvatar={false} hasProfile={false} />);
  expect(screen.queryByText("Edit photo")).toBeNull();
  expect(document.querySelector('input[type="file"]')).toBeNull();
  expect(document.querySelector("form")).toBeNull();
  view.rerender(<AvatarForms hasAvatar={false} hasProfile />);
  const details = screen.getByText("Edit photo").closest("details")!;
  expect(details.open).toBe(false);
  details.open = true;
  expect(screen.queryByRole("button", { name: "Remove avatar" })).toBeNull();
  const file = new File(["image"], "avatar.png", { type: "image/png" });
  const input = screen.getByLabelText("Upload avatar") as HTMLInputElement;
  // jsdom does not serialize file inputs into FormData; check action connection here,
  // with real file validation/storage lifecycle covered by existing unit/integration tests.
  fireEvent.change(input, { target: { files: [file] } });
  fireEvent.submit(screen.getByRole("button", { name: "Save avatar" }).closest("form")!);
  await waitFor(() => expect(upload).toHaveBeenCalledOnce());
  expect(remove).not.toHaveBeenCalled();
  view.rerender(<AvatarForms hasAvatar hasProfile />);
  expect(screen.getByLabelText("Change avatar")).toBeDefined();
  fireEvent.change(screen.getByLabelText("Change avatar"), { target: { files: [file] } });
  fireEvent.submit(screen.getByRole("button", { name: "Save avatar" }).closest("form")!);
  await waitFor(() => expect(upload).toHaveBeenCalledTimes(2));
  fireEvent.submit(screen.getByRole("button", { name: "Remove avatar" }).closest("form")!);
  await waitFor(() => expect(remove).toHaveBeenCalledOnce());
});

it.each([
  ["unsupported MIME", () => new File(["GIF89a"], "avatar.gif", { type: "image/gif" }), "Choose a JPEG, PNG, or WebP image."],
  ["zero bytes", () => new File([], "avatar.png", { type: "image/png" }), "Choose an image to upload."],
  ["oversized input", () => new File([new Uint8Array(5 * 1024 * 1024 + 1)], "avatar.png", { type: "image/png" }), "Use an image no larger than 5 MiB."],
] as const)("blocks %s before submission and clears the error for a valid selection", async (_name, invalidFile, error) => {
  upload.mockResolvedValue({ success: "Avatar saved." });
  render(<AvatarForms hasAvatar={false} hasProfile />);
  const input = screen.getByLabelText("Upload avatar");
  const form = screen.getByRole("button", { name: "Save avatar" }).closest("form")!;
  fireEvent.change(input, { target: { files: [invalidFile()] } });
  expect(screen.getByRole("alert").textContent).toBe(error);
  expect(input.getAttribute("aria-invalid")).toBe("true");
  fireEvent.submit(form);
  expect(upload).not.toHaveBeenCalled();
  fireEvent.change(input, { target: { files: [new File(["image"], "avatar.png", { type: "image/png" })] } });
  expect(screen.queryByRole("alert")).toBeNull();
  expect(input.getAttribute("aria-invalid")).toBe("false");
  fireEvent.submit(form);
  await waitFor(() => expect(upload).toHaveBeenCalledOnce());
});

it("keeps server image validation errors visible until a new file is selected", async () => {
  upload.mockResolvedValue({ fieldErrors: { avatar: "Choose a valid JPEG, PNG, or WebP image." } });
  render(<AvatarForms hasAvatar={false} hasProfile />);
  const input = screen.getByLabelText("Upload avatar");
  fireEvent.change(input, { target: { files: [new File(["malformed"], "avatar.png", { type: "image/png" })] } });
  fireEvent.submit(screen.getByRole("button", { name: "Save avatar" }).closest("form")!);
  await screen.findByText("Choose a valid JPEG, PNG, or WebP image.");
  fireEvent.change(input, { target: { files: [new File(["new image"], "avatar.webp", { type: "image/webp" })] } });
  expect(screen.queryByText("Choose a valid JPEG, PNG, or WebP image.")).toBeNull();
});
