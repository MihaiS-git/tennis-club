import { beforeEach, expect, it, vi } from "vitest";

import type { CurrentAccount } from "../../../src/lib/auth/account";

const { readCurrentAccount, signInWithPassword, updateUser, redirect } = vi.hoisted(() => ({
  readCurrentAccount: vi.fn(),
  signInWithPassword: vi.fn(),
  updateUser: vi.fn(),
  redirect: vi.fn((path: string) => {
    throw new Error(`redirect:${path}`);
  }),
}));

vi.mock("next/navigation", () => ({ redirect }));
vi.mock("../../../src/lib/auth/account", () => ({ readCurrentAccount }));
vi.mock("../../../src/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { updateUser } }),
}));
vi.mock("../../../src/lib/auth/password-verifier.server", () => ({
  createPasswordVerificationClient: () => ({
    auth: { signInWithPassword, signOut: vi.fn() },
  }),
}));

import { changePasswordAction } from "../../../src/app/account/actions";

function validPasswordForm() {
  const form = new FormData();
  form.set("currentPassword", "current-password");
  form.set("password", "new-password-123");
  form.set("confirmPassword", "new-password-123");
  return form;
}

beforeEach(() => {
  vi.clearAllMocks();
});

it("redirects an unauthenticated account before password verification or update", async () => {
  readCurrentAccount.mockResolvedValue({ state: "unauthenticated" } satisfies CurrentAccount);

  await expect(changePasswordAction({}, validPasswordForm())).rejects.toThrow(
    "redirect:/login",
  );

  expect(redirect).toHaveBeenCalledExactlyOnceWith("/login");
  expect(signInWithPassword).not.toHaveBeenCalled();
  expect(updateUser).not.toHaveBeenCalled();
});

it.each([
  { state: "suspended", userId: "member-1", email: "member@example.com", roles: ["member"] },
  { state: "missing-profile" },
  { state: "load-error" },
] satisfies CurrentAccount[])(
  "returns a safe form error for a $state account before password verification or update",
  async (account) => {
    readCurrentAccount.mockResolvedValue(account);

    await expect(changePasswordAction({}, validPasswordForm())).resolves.toStrictEqual({
      formError: "Password changes are not available for this account.",
    });

    expect(signInWithPassword).not.toHaveBeenCalled();
    expect(updateUser).not.toHaveBeenCalled();
  },
);

it("rejects a short new password before account lookup", async () => {
  const form = validPasswordForm();
  form.set("password", "too-short");
  form.set("confirmPassword", "too-short");

  await expect(changePasswordAction({}, form)).resolves.toStrictEqual({
    fieldErrors: { password: "Use at least 15 characters." },
  });
  expect(readCurrentAccount).not.toHaveBeenCalled();
  expect(updateUser).not.toHaveBeenCalled();
});

it.each([
  [["pwned"], "This password is too common or has appeared in a data breach. Choose another."],
  [["length"], "The authentication provider rejected this password's length requirements. Please contact support."],
  [["characters"], "The authentication provider rejected this password's requirements. Please contact support."],
  [[], "The authentication provider rejected this password's requirements. Please contact support."],
])("maps Supabase weak-password reasons %j on change", async (reasons, message) => {
  const report = vi.spyOn(console, "error").mockImplementation(() => {});
  readCurrentAccount.mockResolvedValue({
    state: "active", userId: "member-1", email: "member@example.com", roles: ["member"],
  } satisfies CurrentAccount);
  signInWithPassword.mockResolvedValue({ data: { user: { id: "member-1" } }, error: null });
  updateUser.mockResolvedValue({ error: { code: "weak_password", reasons } });

  await expect(changePasswordAction({}, validPasswordForm())).resolves.toStrictEqual({
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
