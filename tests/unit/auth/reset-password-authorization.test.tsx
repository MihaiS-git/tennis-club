import { beforeEach, expect, it, vi } from "vitest";

const { getUser, getClaims, updateUser, signOut, redirect } = vi.hoisted(() => ({
  getUser: vi.fn(),
  getClaims: vi.fn(),
  updateUser: vi.fn(),
  signOut: vi.fn(),
  redirect: vi.fn((path: string) => {
    throw new Error(`redirect:${path}`);
  }),
}));

vi.mock("next/navigation", () => ({ redirect }));
vi.mock("../../../src/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser, getClaims, updateUser, signOut } }),
}));

import ResetPasswordPage from "../../../src/app/(auth)/reset-password/page";
import { resetPasswordAction } from "../../../src/app/(auth)/actions";

function passwordForm(): FormData {
  const form = new FormData();
  form.set("password", "new-password-456");
  form.set("confirmPassword", "new-password-456");
  return form;
}

beforeEach(() => {
  vi.clearAllMocks();
  getUser.mockResolvedValue({ data: { user: { id: "member-1" } }, error: null });
  getClaims.mockResolvedValue({
    data: { claims: { sub: "member-1", amr: [{ method: "recovery", timestamp: 1 }] } },
    error: null,
  });
  updateUser.mockResolvedValue({ error: null });
  signOut.mockResolvedValue({ error: null });
});

it("allows a verified recovery session to render the page and reset the password", async () => {
  expect(await ResetPasswordPage()).toBeDefined();
  expect(redirect).not.toHaveBeenCalled();

  await expect(resetPasswordAction({}, passwordForm())).rejects.toThrow(
    "redirect:/login?notice=password-reset-success",
  );
  expect(updateUser).toHaveBeenCalledExactlyOnceWith({ password: "new-password-456" });
  expect(signOut).toHaveBeenCalledExactlyOnceWith({ scope: "local" });
});

it("rejects a short reset password before calling Supabase", async () => {
  const form = passwordForm();
  form.set("password", "too-short");
  form.set("confirmPassword", "too-short");

  expect(await resetPasswordAction({}, form)).toEqual({
    fieldErrors: { password: "Use at least 15 characters." },
  });
  expect(updateUser).not.toHaveBeenCalled();
});

it.each([
  [["pwned"], "This password is too common or has appeared in a data breach. Choose another."],
  [["length"], "The authentication provider rejected this password's length requirements. Please contact support."],
  [["characters"], "The authentication provider rejected this password's requirements. Please contact support."],
  [[], "The authentication provider rejected this password's requirements. Please contact support."],
])("maps Supabase weak-password reasons %j on reset", async (reasons, message) => {
  const report = vi.spyOn(console, "error").mockImplementation(() => {});
  updateUser.mockResolvedValue({ error: { code: "weak_password", reasons } });

  expect(await resetPasswordAction({}, passwordForm())).toEqual({
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

it("rejects a normal password session on the page and on direct action invocation", async () => {
  getClaims.mockResolvedValue({
    data: { claims: { sub: "member-1", amr: [{ method: "password", timestamp: 1 }] } },
    error: null,
  });

  await expect(ResetPasswordPage()).rejects.toThrow(
    "redirect:/login?notice=invalid-reset-link",
  );
  expect(await resetPasswordAction({}, passwordForm())).toEqual({
    formError: "This authentication link is invalid or has expired.",
  });
  expect(updateUser).not.toHaveBeenCalled();
});

it.each([
  ["missing user", { data: { user: null }, error: null }, null],
  ["invalid claims", { data: { user: { id: "member-1" } }, error: null }, { data: null, error: { message: "invalid" } }],
  ["another user's claims", { data: { user: { id: "member-1" } }, error: null }, { data: { claims: { sub: "member-2", amr: [{ method: "recovery", timestamp: 1 }] } }, error: null }],
])("rejects %s on the page and action", async (_case, userResult, claimsResult) => {
  getUser.mockResolvedValue(userResult);
  if (claimsResult) getClaims.mockResolvedValue(claimsResult);

  await expect(ResetPasswordPage()).rejects.toThrow(
    "redirect:/login?notice=invalid-reset-link",
  );
  expect(await resetPasswordAction({}, passwordForm())).toEqual({
    formError: "This authentication link is invalid or has expired.",
  });
  expect(updateUser).not.toHaveBeenCalled();
});
