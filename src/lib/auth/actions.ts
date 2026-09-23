"use server";

import { redirect } from "next/navigation";

import { createClient } from "@/lib/supabase/server";

import {
  createAuthErrorState,
  type AuthActionState,
} from "./action-state";
import { changePasswordWithVerification } from "./password-change";
import { createPasswordVerificationClient } from "./password-verifier.server";
import { getApplicationUrl } from "./site-url";
import { getAuthErrorCode, type AuthErrorCode } from "./messages";
import { getSignUpSessionOutcome } from "./signup-result";
import {
  parseNewPasswordForm,
  parseChangePasswordForm,
  parsePasswordResetForm,
  parseSignInForm,
  parseSignUpForm,
} from "./validation";

function redirectWithNotice(
  path: "/account" | "/forgot-password" | "/login" | "/reset-password" | "/signup",
  kind: "error" | "message",
  code: string,
): never {
  const searchParams = new URLSearchParams({ [kind]: code });

  redirect(`${path}?${searchParams.toString()}`);
}

export async function signUp(
  previousState: AuthActionState,
  formData: FormData,
): Promise<AuthActionState> {
  const parsed = parseSignUpForm(formData);

  if (!parsed.success) {
    const passwordMismatch = parsed.error.issues.some(
      ({ path }) => path[0] === "confirmPassword",
    );

    return createAuthErrorState(
      previousState,
      passwordMismatch ? "password-mismatch" : "invalid-signup",
    );
  }

  const supabase = await createClient();
  const { data, error } = await supabase.auth.signUp({
    email: parsed.data.email,
    password: parsed.data.password,
  });

  if (error) {
    return createAuthErrorState(
      previousState,
      getAuthErrorCode("signup", error.code),
    );
  }

  if (getSignUpSessionOutcome(data.session) === "check-email") {
    redirectWithNotice("/login", "message", "check-email");
  }

  const { data: claimsData, error: claimsError } =
    await supabase.auth.getClaims();

  if (claimsError || !claimsData?.claims.sub) {
    await supabase.auth.signOut({ scope: "local" });
    return createAuthErrorState(previousState, "verification-failed");
  }

  redirect("/account");
}

export async function signIn(
  previousState: AuthActionState,
  formData: FormData,
): Promise<AuthActionState> {
  const parsed = parseSignInForm(formData);

  if (!parsed.success) {
    return createAuthErrorState(previousState, "invalid-signin");
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({
    email: parsed.data.email,
    password: parsed.data.password,
  });

  if (error) {
    return createAuthErrorState(
      previousState,
      getAuthErrorCode("signin", error.code),
    );
  }

  const { data: claimsData, error: claimsError } =
    await supabase.auth.getClaims();

  if (claimsError || !claimsData?.claims.sub) {
    await supabase.auth.signOut();
    return createAuthErrorState(previousState, "verification-failed");
  }

  redirect("/account");
}

export async function signOut() {
  const supabase = await createClient();
  const { error } = await supabase.auth.signOut({ scope: "local" });

  if (error) {
    const code: AuthErrorCode = "signout-failed";
    redirectWithNotice("/account", "error", code);
  }

  redirectWithNotice("/login", "message", "signed-out");
}

export async function requestPasswordReset(formData: FormData) {
  const parsed = parsePasswordResetForm(formData);

  if (!parsed.success) {
    redirectWithNotice("/forgot-password", "error", "invalid-password-reset");
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.resetPasswordForEmail(parsed.data.email, {
    redirectTo: getApplicationUrl("/auth/confirm?next=/reset-password"),
  });

  if (error) {
    redirectWithNotice("/forgot-password", "error", "reset-request-failed");
  }

  redirectWithNotice("/forgot-password", "message", "password-reset-sent");
}

export async function updatePassword(formData: FormData) {
  const parsed = parseNewPasswordForm(formData);

  if (!parsed.success) {
    const passwordMismatch = parsed.error.issues.some(
      ({ path }) => path[0] === "confirmPassword",
    );

    redirectWithNotice(
      "/reset-password",
      "error",
      passwordMismatch ? "new-password-mismatch" : "password-update-failed",
    );
  }

  const supabase = await createClient();
  const { data: claimsData, error: claimsError } = await supabase.auth.getClaims();

  if (claimsError || !claimsData?.claims.sub) {
    redirectWithNotice("/login", "error", "reset-link-invalid");
  }

  const { error } = await supabase.auth.updateUser({
    password: parsed.data.password,
  });

  if (error) {
    redirectWithNotice("/reset-password", "error", "password-update-failed");
  }

  await supabase.auth.signOut({ scope: "local" });
  redirectWithNotice("/login", "message", "password-updated");
}

export async function changePassword(formData: FormData) {
  const parsed = parseChangePasswordForm(formData);

  if (!parsed.success) {
    redirectWithNotice("/account", "error", "password-change-invalid");
  }

  const supabase = await createClient();
  const { data: claimsData, error: claimsError } = await supabase.auth.getClaims();
  const userId = claimsData?.claims.sub;
  const email = claimsData?.claims.email;

  if (
    claimsError ||
    typeof userId !== "string" ||
    typeof email !== "string"
  ) {
    redirectWithNotice("/login", "error", "verification-failed");
  }

  const result = await changePasswordWithVerification({
    authenticatedClient: supabase,
    verificationClient: createPasswordVerificationClient(),
    userId,
    email,
    currentPassword: parsed.data.currentPassword,
    newPassword: parsed.data.password,
  });

  if (!result.ok) {
    redirectWithNotice(
      "/account",
      "error",
      result.reason === "current-password-incorrect"
        ? "current-password-incorrect"
        : "password-update-failed",
    );
  }

  redirectWithNotice("/account", "message", "password-updated");
}
