// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

it.each(["remove"])("disables both avatar controls and blocks duplicate submits during %s", async (operation) => {
  let finish: (state: ProfileActionState) => void = () => {};
  const activeAction = operation === "upload" ? upload : remove;
  const otherAction = operation === "upload" ? remove : upload;
  activeAction.mockImplementation(() => new Promise<ProfileActionState>((resolve) => { finish = resolve; }));
  render(<AvatarForms hasAvatar hasProfile />);
  const input = screen.getByLabelText("Change avatar");
  const uploadForm = screen.getByRole("button", { name: "Save avatar" }).closest("form")!;
  const removeForm = screen.getByRole("button", { name: "Remove avatar" }).closest("form")!;
  fireEvent.change(input, { target: { files: [new File(["image"], "avatar.png", { type: "image/png" })] } });
  // Includes a same-tick second submission before pending UI can render.
  fireEvent.submit(operation === "upload" ? uploadForm : removeForm);
  fireEvent.submit(operation === "upload" ? removeForm : uploadForm);
  await waitFor(() => expect(activeAction).toHaveBeenCalledOnce());
  expect(otherAction).not.toHaveBeenCalled();
  expect(input.hasAttribute("disabled")).toBe(true);
  for (const form of [uploadForm, removeForm]) {
    expect(within(form).getByRole("button").hasAttribute("disabled")).toBe(true);
    fireEvent.submit(form);
  }
  expect(activeAction).toHaveBeenCalledOnce(); expect(otherAction).not.toHaveBeenCalled();
  await act(async () => finish({ formError: "Please retry." }));
  await screen.findByText("Please retry.");
  expect(input.hasAttribute("disabled")).toBe(false);
  for (const form of [uploadForm, removeForm]) expect(within(form).getByRole("button").hasAttribute("disabled")).toBe(false);
});
