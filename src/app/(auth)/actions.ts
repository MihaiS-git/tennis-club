"use server";

import { redirect } from "next/navigation";

import type { AuthActionState } from "@/lib/auth/action-state";
import {
  RECOVERY_SUCCESS_MESSAGE,
  decideSignUpResult,
  safeAuthError,
} from "@/lib/auth/decisions";
import { getApplicationUrl } from "@/lib/auth/site-url";
import { safeRedirectPath } from "@/lib/auth/redirects";
import {
  fieldValidationErrors,
  newPasswordSchema,
  recoverySchema,
  signInSchema,
  signUpSchema,
} from "@/lib/auth/validation";
import { createClient } from "@/lib/supabase/server";

function value(formData: FormData, key: string): string {
  const field = formData.get(key);
  return typeof field === "string" ? field : "";
}

function redirectWith(
  path: string,
  key: "error" | "message",
  message: string,
  additionalParams?: Record<string, string>,
): never {
  const query = new URLSearchParams(additionalParams);
  query.set(key, message);
  redirect(`${path}?${query.toString()}`);
}

export async function signUpAction(
  _previousState: AuthActionState,
  formData: FormData,
): Promise<AuthActionState> {
  const parsed = signUpSchema.safeParse({
    email: value(formData, "email"),
    password: value(formData, "password"),
    confirmPassword: value(formData, "confirmPassword"),
  });

  if (!parsed.success) {
    return { fieldErrors: fieldValidationErrors(parsed.error) };
  }

  const supabase = await createClient();
  const { data, error } = await supabase.auth.signUp({
    email: parsed.data.email,
    password: parsed.data.password,
    options: {
      emailRedirectTo: getApplicationUrl(
        "/auth/callback?next=/account&flow=email-confirmation",
      ),
    },
  });

  const decision = decideSignUpResult({
    hasSession: Boolean(data.session),
    hasUser: Boolean(data.user),
    hasError: Boolean(error),
  });

  // A signup session means email confirmation is disabled or misconfigured.
  // Never let that session authenticate the user before confirmation.
  if (data.session) await supabase.auth.signOut({ scope: "local" });
  if (decision === "check-email") redirect("/signup/check-email");

  return { formError: safeAuthError("signup", error?.code) };
}

export async function signInAction(
  _previousState: AuthActionState,
  formData: FormData,
): Promise<AuthActionState> {
  const next = safeRedirectPath(value(formData, "next"));
  const parsed = signInSchema.safeParse({
    email: value(formData, "email"),
    password: value(formData, "password"),
  });

  if (!parsed.success) {
    return { fieldErrors: fieldValidationErrors(parsed.error) };
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword(parsed.data);

  if (error) {
    await supabase.auth.signOut({ scope: "local" });
    return { formError: safeAuthError("signin", error.code) };
  }

  const { data: identity, error: identityError } = await supabase.auth.getUser();
  if (identityError || !identity.user) {
    await supabase.auth.signOut({ scope: "local" });
    return { formError: safeAuthError("signin") };
  }

  redirect(next);
}

export async function forgotPasswordAction(
  _previousState: AuthActionState,
  formData: FormData,
): Promise<AuthActionState> {
  const parsed = recoverySchema.safeParse({ email: value(formData, "email") });

  if (!parsed.success) {
    return { fieldErrors: fieldValidationErrors(parsed.error) };
  }

  const supabase = await createClient();
  await supabase.auth.resetPasswordForEmail(parsed.data.email, {
    redirectTo: getApplicationUrl("/auth/callback?next=/reset-password"),
  });

  redirectWith("/forgot-password", "message", RECOVERY_SUCCESS_MESSAGE);
}

export async function resetPasswordAction(
  _previousState: AuthActionState,
  formData: FormData,
): Promise<AuthActionState> {
  const parsed = newPasswordSchema.safeParse({
    password: value(formData, "password"),
    confirmPassword: value(formData, "confirmPassword"),
  });

  if (!parsed.success) {
    return { fieldErrors: fieldValidationErrors(parsed.error) };
  }

  const supabase = await createClient();
  const { data: identity, error: identityError } = await supabase.auth.getUser();
  if (identityError || !identity.user) {
    await supabase.auth.signOut({ scope: "local" });
    return { formError: safeAuthError("callback") };
  }

  const { error } = await supabase.auth.updateUser({ password: parsed.data.password });
  if (error) {
    return { formError: safeAuthError("password", error.code) };
  }

  await supabase.auth.signOut({ scope: "local" });
  redirectWith("/login", "message", "Your password has been reset. Sign in with your new password.");
}
