// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
const mocks = vi.hoisted(() => ({ save: vi.fn(), send: vi.fn() }));
vi.mock("@/app/admin/club/actions", () => ({ saveClubSettingsAction: mocks.save, sendClubTestEmailAction: mocks.send }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
import { toast } from "sonner";
import { ClubSettingsForm } from "@/app/admin/club/settings-form";
const settings = { officialEmail: "club@example.com", senderName: "Club", emailsEnabled: true };
afterEach(cleanup);
beforeEach(() => { vi.resetAllMocks(); });

test("loads saved fields, disables unchanged saves, and establishes the saved baseline", async () => {
  mocks.save.mockResolvedValue({ ok: true, settings: { ...settings, senderName: "New Club" } });
  render(<ClubSettingsForm settings={settings} />);
  const save = screen.getByRole("button", { name: "Save changes" });
  expect(screen.getByLabelText("Official email address")).toHaveProperty("value", settings.officialEmail);
  expect(save).toHaveProperty("disabled", true);
  fireEvent.change(screen.getByLabelText("Email sender name"), { target: { value: "New Club" } });
  expect(save).toHaveProperty("disabled", false);
  expect(screen.getByRole("button", { name: "Send test email" })).toHaveProperty("disabled", true);
  fireEvent.click(save);
  await waitFor(() => expect(toast.success).toHaveBeenCalledExactlyOnceWith("Club settings saved."));
  expect(mocks.save).toHaveBeenCalledWith({ ...settings, senderName: "New Club" });
  expect(save).toHaveProperty("disabled", true);
});

test("retains edited values after validation errors", async () => {
  mocks.save.mockResolvedValue({ ok: false, message: "Enter a valid sender name." });
  render(<ClubSettingsForm settings={settings} />);
  fireEvent.change(screen.getByLabelText("Email sender name"), { target: { value: " " } });
  fireEvent.submit(screen.getByRole("button", { name: "Save changes" }).closest("form")!);
  await waitFor(() => expect(toast.error).toHaveBeenCalledExactlyOnceWith("Enter a valid sender name."));
  expect(screen.getByLabelText("Email sender name")).toHaveProperty("value", " ");
});

test.each([
  "Test request accepted by Brevo in sandbox mode. No email will arrive.",
  "Test email accepted by Brevo. Acceptance does not confirm inbox delivery.",
])("shows one mode-appropriate success toast: %s", async (message) => {
  mocks.send.mockResolvedValue({ ok: true, message });
  render(<ClubSettingsForm settings={settings} />);
  fireEvent.click(screen.getByRole("button", { name: "Send test email" }));
  await waitFor(() => expect(toast.success).toHaveBeenCalledExactlyOnceWith(message));
  expect(toast.error).not.toHaveBeenCalled();
  expect(screen.queryByRole("status")).toBeNull();
  expect(screen.queryByText(message)).toBeNull();
});

test("shows a readable error toast and disables test for unsaved settings", async () => {
  const message = "Brevo rejected the email. Check the sender configuration and recipient address.";
  mocks.send.mockResolvedValue({ ok: false, message });
  render(<ClubSettingsForm settings={settings} />);
  fireEvent.click(screen.getByRole("button", { name: "Send test email" }));
  await waitFor(() => expect(toast.error).toHaveBeenCalledExactlyOnceWith(message));
  expect(toast.success).not.toHaveBeenCalled();
  expect(screen.queryByRole("status")).toBeNull();
  expect(screen.queryByText(message)).toBeNull();
  expect(mocks.send).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("switch"));
  expect(screen.getByRole("button", { name: "Send test email" })).toHaveProperty("disabled", true);
});

test("shows a safe error toast when the test action throws", async () => {
  mocks.send.mockRejectedValue(new Error("Raw provider response: <smtp-id>"));
  render(<ClubSettingsForm settings={settings} />);
  fireEvent.click(screen.getByRole("button", { name: "Send test email" }));
  await waitFor(() => expect(toast.error).toHaveBeenCalledExactlyOnceWith("Unable to send the test email. Try again."));
  expect(screen.queryByRole("status")).toBeNull();
  expect(screen.queryByText(/smtp-id/)).toBeNull();
  expect(screen.getByRole("button", { name: "Send test email" })).toHaveProperty("disabled", false);
});

test.each(["save", "test"] as const)("labels a pending %s and blocks every action until it settles", async (operation) => {
  let finish!: (value: unknown) => void;
  const pending = new Promise((resolve) => { finish = resolve; });
  mocks.save.mockReturnValue(pending); mocks.send.mockReturnValue(pending);
  render(<ClubSettingsForm settings={settings} />);
  if (operation === "save") {
    fireEvent.change(screen.getByLabelText("Email sender name"), { target: { value: "New Club" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  } else fireEvent.click(screen.getByRole("button", { name: "Send test email" }));
  const label = operation === "save" ? "Saving…" : "Sending test email…";
  const button = await screen.findByRole("button", { name: label });
  expect(button).toHaveProperty("disabled", true);
  expect(button.getAttribute("aria-busy")).toBe("true");
  expect(screen.getAllByRole("button").every((item) => (item as HTMLButtonElement).disabled)).toBe(true);
  fireEvent.submit(button.closest("form")!);
  expect(operation === "save" ? mocks.save : mocks.send).toHaveBeenCalledOnce();
  finish(operation === "save" ? { ok: true, settings: { ...settings, senderName: "New Club" } } : { ok: true, message: "Sent." });
  await screen.findByRole("button", { name: operation === "save" ? "Save changes" : "Send test email" });
  expect(screen.queryByRole("button", { name: label })).toBeNull();
});
