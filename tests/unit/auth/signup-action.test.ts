import { beforeEach, describe, expect, it, vi } from "vitest";

const { signUp, signOut, redirect } = vi.hoisted(() => ({
  signUp: vi.fn(),
  signOut: vi.fn(),
  redirect: vi.fn((path: string) => {
    throw new Error(`redirect:${path}`);
  }),
}));

vi.mock("next/navigation", () => ({ redirect }));
vi.mock("../../../src/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { signUp, signOut } }),
}));

import { signUpAction } from "../../../src/app/(auth)/actions";

describe("signup action role boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("ignores submitted admin role and role metadata", async () => {
    signUp.mockResolvedValue({
      data: { user: { id: "new-user" }, session: null },
      error: null,
    });

    const form = new FormData();
    form.set("email", "new-member@example.com");
    form.set("password", "safe-password-123");
    form.set("confirmPassword", "safe-password-123");
    form.set("role", "admin");
    form.set("roles", "admin");
    form.set("user_metadata", JSON.stringify({ role: "admin" }));

    await expect(signUpAction({}, form)).rejects.toThrow(
      "redirect:/signup/check-email",
    );
    expect(signUp).toHaveBeenCalledExactlyOnceWith({
      email: "new-member@example.com",
      password: "safe-password-123",
      options: {
        emailRedirectTo: expect.stringContaining("/auth/callback"),
      },
    });
    expect(redirect).toHaveBeenCalledWith("/signup/check-email");
  });

  it("signs out an unexpected signup session and returns a safe error", async () => {
    signUp.mockResolvedValue({
      data: { user: { id: "new-user" }, session: { access_token: "unexpected-session" } },
      error: null,
    });

    const form = new FormData();
    form.set("email", "new-member@example.com");
    form.set("password", "safe-password-123");
    form.set("confirmPassword", "safe-password-123");

    await expect(signUpAction({}, form)).resolves.toEqual({
      formError: "We could not create your account. Please try again.",
    });
    expect(signOut).toHaveBeenCalledExactlyOnceWith({ scope: "local" });
    expect(redirect).not.toHaveBeenCalled();
  });

  it("rejects a short password before calling Supabase", async () => {
    const form = new FormData();
    form.set("email", "new-member@example.com");
    form.set("password", "too-short");
    form.set("confirmPassword", "too-short");

    await expect(signUpAction({}, form)).resolves.toEqual({
      fieldErrors: { password: "Use at least 15 characters." },
    });
    expect(signUp).not.toHaveBeenCalled();
  });

  it.each([
    [["pwned"], "This password is too common or has appeared in a data breach. Choose another."],
    [["length"], "The authentication provider rejected this password's length requirements. Please contact support."],
    [["characters"], "The authentication provider rejected this password's requirements. Please contact support."],
    [["characters", "pwned"], "This password is too common or has appeared in a data breach. Choose another."],
    [[], "The authentication provider rejected this password's requirements. Please contact support."],
  ])("maps Supabase weak-password reasons %j on the password field", async (reasons, message) => {
    const report = vi.spyOn(console, "error").mockImplementation(() => {});
    signUp.mockResolvedValue({
      data: { user: null, session: null },
      error: { code: "weak_password", reasons },
    });
    const form = new FormData();
    form.set("email", "new-member@example.com");
    form.set("password", "a sufficiently long password");
    form.set("confirmPassword", "a sufficiently long password");

    await expect(signUpAction({}, form)).resolves.toEqual({
      fieldErrors: { password: message },
    });
    if (reasons.includes("characters")) {
      expect(report).toHaveBeenCalledWith(
        expect.stringContaining("Supabase hosted password configuration conflicts"),
        { reasons },
      );
    } else {
      expect(report).not.toHaveBeenCalled();
    }
    report.mockRestore();
  });
});
