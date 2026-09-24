import { beforeEach, expect, it, vi } from "vitest";

const { signOut, redirect } = vi.hoisted(() => ({
  signOut: vi.fn(),
  redirect: vi.fn((path: string) => {
    throw new Error(`redirect:${path}`);
  }),
}));

vi.mock("next/navigation", () => ({ redirect }));
vi.mock("../../../src/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { signOut } }),
}));
vi.mock("../../../src/lib/auth/account", () => ({ readCurrentAccount: vi.fn() }));
vi.mock("../../../src/lib/auth/password-change", () => ({ changePasswordWithVerification: vi.fn() }));
vi.mock("../../../src/lib/auth/password-verifier.server", () => ({
  createPasswordVerificationClient: vi.fn(),
}));

import { signOutAction } from "../../../src/app/account/actions";

beforeEach(() => {
  vi.clearAllMocks();
});

it("redirects to login after successful local sign-out", async () => {
  signOut.mockResolvedValue({ error: null });

  await expect(signOutAction()).rejects.toThrow("redirect:/login");

  expect(signOut).toHaveBeenCalledExactlyOnceWith({ scope: "local" });
  expect(redirect).toHaveBeenCalledExactlyOnceWith("/login");
});

it("stays on account with a trusted notice after failed local sign-out", async () => {
  signOut.mockResolvedValue({ error: { message: "provider-private-error" } });

  await expect(signOutAction()).rejects.toThrow(
    "redirect:/account?notice=signout-failed",
  );

  expect(signOut).toHaveBeenCalledExactlyOnceWith({ scope: "local" });
  expect(redirect).toHaveBeenCalledExactlyOnceWith("/account?notice=signout-failed");
  expect(redirect.mock.calls[0][0]).not.toContain("provider-private-error");
});
