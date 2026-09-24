"use server";

import { redirect } from "next/navigation";

import type { AuthActionState } from "@/lib/auth/action-state";
import { readCurrentAccount } from "@/lib/auth/account";
import { safeAuthError, weakPasswordMessage } from "@/lib/auth/decisions";
import { changePasswordWithVerification } from "@/lib/auth/password-change";
import { createPasswordVerificationClient } from "@/lib/auth/password-verifier.server";
import { changePasswordSchema, fieldValidationErrors } from "@/lib/auth/validation";
import { createClient } from "@/lib/supabase/server";
import { logger } from "@/lib/logger";

export async function changePasswordAction(
  _previousState: AuthActionState,
  formData: FormData,
): Promise<AuthActionState> {
  const currentPassword = formData.get("currentPassword");
  const password = formData.get("password");
  const confirmPassword = formData.get("confirmPassword");
  const parsed = changePasswordSchema.safeParse({
    currentPassword: typeof currentPassword === "string" ? currentPassword : "",
    password: typeof password === "string" ? password : "",
    confirmPassword: typeof confirmPassword === "string" ? confirmPassword : "",
  });

  if (!parsed.success) {
    return { fieldErrors: fieldValidationErrors(parsed.error) };
  }

  const supabase = await createClient();
  const account = await readCurrentAccount(supabase);
  if (account.state === "unauthenticated") redirect("/login");

  if (account.state !== "active") {
    return { formError: "Password changes are not available for this account." };
  }

  const result = await changePasswordWithVerification({
    authenticatedClient: supabase,
    verificationClient: createPasswordVerificationClient(),
    userId: account.userId,
    email: account.email,
    currentPassword: parsed.data.currentPassword,
    newPassword: parsed.data.password,
  });

  if (!result.ok && result.reason === "current-password-incorrect") {
    return {
      fieldErrors: { currentPassword: "Current password is incorrect." },
    };
  }

  if (!result.ok) {
    if (result.code === "weak_password" && result.reasons?.includes("characters")) {
      logger.warn(
        { event: "auth.password_policy_conflict", reason: "characters" },
        "Supabase hosted password configuration conflicts with the application's no-composition-rule policy.",
      );
    }
    const passwordError = weakPasswordMessage(result, parsed.data.password);
    if (passwordError) return { fieldErrors: { password: passwordError } };
    return { formError: safeAuthError("password", result.code) };
  }

  redirect("/account?notice=password-changed");
}

export async function signOutAction() {
  const supabase = await createClient();
  const { error } = await supabase.auth.signOut({ scope: "local" });
  if (error) redirect("/account?notice=signout-failed");
  redirect("/login");
}
