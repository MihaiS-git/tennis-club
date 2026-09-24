"use server";

import { redirect } from "next/navigation";

import type { AuthActionState } from "@/lib/auth/action-state";
import {
  decideSignUpResult,
  safeAuthError,
  weakPasswordMessage,
} from "@/lib/auth/decisions";
import { getApplicationUrl } from "@/lib/auth/site-url";
import { hasRecoverySession } from "@/lib/auth/recovery-session";
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

  const passwordError = weakPasswordMessage(error, parsed.data.password);
  if (passwordError) return { fieldErrors: { password: passwordError } };

  return { formError: safeAuthError("signup", error?.code) };
}

export async function signInAction(
  _previousState: AuthActionState,
  formData: FormData,
): Promise<AuthActionState> {
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

  redirect("/");
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
  const { error } = await supabase.auth.resetPasswordForEmail(parsed.data.email, {
    redirectTo: getApplicationUrl("/auth/callback?next=/reset-password"),
  });

  if (error) redirect("/forgot-password?notice=recovery-request-failed");
  redirect("/forgot-password?notice=recovery-link-sent");
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
  if (!(await hasRecoverySession(supabase))) {
    await supabase.auth.signOut({ scope: "local" });
    return { formError: safeAuthError("callback") };
  }

  const { error } = await supabase.auth.updateUser({ password: parsed.data.password });
  if (error) {
    const passwordError = weakPasswordMessage(error, parsed.data.password);
    if (passwordError) return { fieldErrors: { password: passwordError } };
    return { formError: safeAuthError("password", error.code) };
  }

  await supabase.auth.signOut({ scope: "local" });
  redirect("/login?notice=password-reset-success");
}
