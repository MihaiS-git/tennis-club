import { beforeEach, describe, expect, it, vi } from "vitest";

const { signUp, redirect } = vi.hoisted(() => ({
  signUp: vi.fn(),
  redirect: vi.fn((path: string) => {
    throw new Error(`redirect:${path}`);
  }),
}));

vi.mock("next/navigation", () => ({ redirect }));
vi.mock("../../../src/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { signUp } }),
}));

import { signUpAction } from "../../../src/app/(auth)/actions";

describe("signup action role boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    signUp.mockResolvedValue({
      data: { user: { id: "new-user" }, session: null },
      error: null,
    });
  });

  it.each([undefined, "admin", "owner", "coach", "superuser"])(
    "sends no role assignment for submitted role %s",
    async (role) => {
      const form = new FormData();
      form.set("email", "new-member@example.com");
      form.set("password", "safe-password-123");
      form.set("confirmPassword", "safe-password-123");
      if (role) {
        form.set("role", role);
        form.set("roles", role);
        form.set("user_metadata", JSON.stringify({ role }));
      }

      await expect(signUpAction({}, form)).rejects.toThrow(
        "redirect:/signup/check-email",
      );
      expect(signUp).toHaveBeenCalledExactlyOnceWith({
        email: "new-member@example.com",
        password: "safe-password-123",
        options: {
          emailRedirectTo:
            "http://localhost:3000/auth/callback?next=/account&flow=email-confirmation",
        },
      });
      expect(redirect).toHaveBeenCalledWith("/signup/check-email");
    },
  );
});
