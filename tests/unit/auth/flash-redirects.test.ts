import { beforeEach, expect, it, vi } from "vitest";

const { redirect, resetPasswordForEmail, readCurrentAccount, changePasswordWithVerification } = vi.hoisted(() => ({
  redirect: vi.fn((path: string) => {
    throw new Error(`redirect:${path}`);
  }),
  resetPasswordForEmail: vi.fn(),
  readCurrentAccount: vi.fn(),
  changePasswordWithVerification: vi.fn(),
}));

vi.mock("next/navigation", () => ({ redirect }));
vi.mock("../../../src/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { resetPasswordForEmail } }),
}));
vi.mock("../../../src/lib/auth/account", () => ({ readCurrentAccount }));
vi.mock("../../../src/lib/auth/password-change", () => ({ changePasswordWithVerification }));
vi.mock("../../../src/lib/auth/password-verifier.server", () => ({
  createPasswordVerificationClient: () => ({}),
}));

import { forgotPasswordAction } from "../../../src/app/(auth)/actions";
import { changePasswordAction } from "../../../src/app/account/actions";

beforeEach(() => {
  vi.clearAllMocks();
  resetPasswordForEmail.mockResolvedValue({ error: null });
  readCurrentAccount.mockResolvedValue({
    state: "active",
    userId: "member-1",
    email: "member@example.com",
  });
  changePasswordWithVerification.mockResolvedValue({ ok: true });
});

it("redirects a successful recovery request with the link-sent notice", async () => {
  const email = "member@example.com";
  const form = new FormData();
  form.set("email", email);

  await expect(forgotPasswordAction({}, form)).rejects.toThrow(
    "redirect:/forgot-password?notice=recovery-link-sent",
  );
  expect(resetPasswordForEmail).toHaveBeenCalledExactlyOnceWith(email, {
    redirectTo: expect.stringContaining("/auth/callback?next=/reset-password"),
  });
});

it("maps a provider recovery failure to one safe notice", async () => {
  resetPasswordForEmail.mockResolvedValue({
    error: { message: "private provider detail: mailbox unavailable" },
  });
  const form = new FormData();
  form.set("email", "member@example.com");

  await expect(forgotPasswordAction({}, form)).rejects.toThrow(
    "redirect:/forgot-password?notice=recovery-request-failed",
  );
  expect(redirect).toHaveBeenCalledExactlyOnceWith(
    "/forgot-password?notice=recovery-request-failed",
  );
  expect(redirect.mock.calls[0][0]).not.toContain("mailbox unavailable");
});

it("redirects a verified password change with a fixed notice code", async () => {
  const form = new FormData();
  form.set("currentPassword", "old-password-123");
  form.set("password", "new-password-456");
  form.set("confirmPassword", "new-password-456");

  await expect(changePasswordAction({}, form)).rejects.toThrow(
    "redirect:/account?notice=password-changed",
  );
  expect(changePasswordWithVerification).toHaveBeenCalledOnce();
});
