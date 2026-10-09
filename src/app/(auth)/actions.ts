"use server";

import { redirect } from "next/navigation";
import { cookies } from "next/headers";

import type { AuthActionState } from "@/lib/auth/action-state";
import {
  CONFIRMATION_RESEND_SUCCESS,
  SIGNUP_CONFIRMATION_CALLBACK,
  SIGNUP_EMAIL_COOKIE,
} from "@/lib/auth/confirmation";
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
import { logger } from "@/lib/logger";

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
      emailRedirectTo: getApplicationUrl(SIGNUP_CONFIRMATION_CALLBACK),
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
  if (decision === "check-email") {
    const cookieStore = await cookies();
    cookieStore.set(SIGNUP_EMAIL_COOKIE, parsed.data.email, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/signup/check-email",
      maxAge: 3600,
    });
    redirect("/signup/check-email");
  }

  if (
    error?.code === "weak_password" &&
    "reasons" in error &&
    Array.isArray(error.reasons) &&
    error.reasons.includes("characters")
  ) {
    logger.warn(
      { event: "auth.password_policy_conflict", reason: "characters" },
      "Supabase hosted password configuration conflicts with the application's no-composition-rule policy.",
    );
  }
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
    return {
      formError: safeAuthError("signin", error.code),
      ...(error.code === "email_not_confirmed" ? { emailUnconfirmed: true } : {}),
    };
  }

  const { data: identity, error: identityError } = await supabase.auth.getUser();
  if (identityError || !identity.user) {
    await supabase.auth.signOut({ scope: "local" });
    return { formError: safeAuthError("signin") };
  }

  redirect("/");
}

export async function resendConfirmationAction(
  _previousState: AuthActionState,
  formData: FormData,
): Promise<AuthActionState> {
  const parsed = recoverySchema.safeParse({ email: value(formData, "email") });
  if (!parsed.success) {
    return { fieldErrors: fieldValidationErrors(parsed.error) };
  }

  try {
    const supabase = await createClient();
    const { error } = await supabase.auth.resend({
      type: "signup",
      email: parsed.data.email,
      options: { emailRedirectTo: getApplicationUrl(SIGNUP_CONFIRMATION_CALLBACK) },
    });
    if (error?.status === 429 || error?.code === "over_email_send_rate_limit" || error?.code === "over_request_rate_limit") {
      return { formError: "Too many email requests. Please wait a few minutes before trying again." };
    }
    // Never reveal missing/already-confirmed accounts or provider messages.
    if (error && !["user_not_found", "user_already_exists", "email_exists", "email_not_confirmed"].includes(error.code ?? "")) {
      return { formError: "We could not request a confirmation email. Please try again later." };
    }
    return { success: CONFIRMATION_RESEND_SUCCESS };
  } catch {
    return { formError: "We could not request a confirmation email. Please try again later." };
  }
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
    if (
      error.code === "weak_password" &&
      "reasons" in error &&
      Array.isArray(error.reasons) &&
      error.reasons.includes("characters")
    ) {
      logger.warn(
        { event: "auth.password_policy_conflict", reason: "characters" },
        "Supabase hosted password configuration conflicts with the application's no-composition-rule policy.",
      );
    }
    const passwordError = weakPasswordMessage(error, parsed.data.password);
    if (passwordError) return { fieldErrors: { password: passwordError } };
    return { formError: safeAuthError("password", error.code) };
  }

  await supabase.auth.signOut({ scope: "local" });
  redirect("/login?notice=password-reset-success");
}
