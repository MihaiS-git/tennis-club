// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
const mocks = vi.hoisted(() => ({ save: vi.fn() }));
vi.mock("@/app/admin/club/actions", () => ({ saveClubContactAction: mocks.save }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
import { toast } from "sonner";
import { ClubContactForm } from "@/app/admin/club/contact-form";
const contact = { contactEmail: "hello@example.com", contactPhone: "+40 21 123 4567" };
afterEach(cleanup);
beforeEach(() => { vi.resetAllMocks(); });

test("edits public contact details separately and establishes the saved baseline", async () => {
  mocks.save.mockResolvedValue({ ok: true, contact: { ...contact, contactPhone: "+40 21 765 4321" } });
  render(<ClubContactForm contact={contact} />);
  expect(screen.getByRole("heading", { name: "Public contact" })).toBeTruthy();
  expect(screen.getByLabelText("Contact email address")).toHaveProperty("value", contact.contactEmail);
  const save = screen.getByRole("button", { name: "Save contact details" });
  expect(save).toHaveProperty("disabled", true);
  fireEvent.change(screen.getByLabelText("Telephone number"), { target: { value: "+40 21 765 4321" } });
  fireEvent.click(save);
  await waitFor(() => expect(toast.success).toHaveBeenCalledExactlyOnceWith("Contact details saved."));
  expect(mocks.save).toHaveBeenCalledWith({ ...contact, contactPhone: "+40 21 765 4321" });
  expect(save).toHaveProperty("disabled", true);
});

test("keeps edited values and reports validation errors", async () => {
  mocks.save.mockResolvedValue({ ok: false, message: "Enter a valid email address." });
  render(<ClubContactForm contact={{ contactEmail: "", contactPhone: "" }} />);
  fireEvent.change(screen.getByLabelText("Contact email address"), { target: { value: "invalid" } });
  fireEvent.submit(screen.getByRole("button", { name: "Save contact details" }).closest("form")!);
  await waitFor(() => expect(toast.error).toHaveBeenCalledExactlyOnceWith("Enter a valid email address."));
  expect(screen.getByLabelText("Contact email address")).toHaveProperty("value", "invalid");
});
