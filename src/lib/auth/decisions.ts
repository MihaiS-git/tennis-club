import { fieldValidationErrors, newPasswordSchema } from "@/lib/auth/validation";

export const RECOVERY_SUCCESS_MESSAGE =
  "If an account exists for that email, a password reset link has been sent.";

type AuthContext = "signin" | "signup" | "password" | "callback";

export const WEAK_NEW_PASSWORD_ERROR =
  "This password is too common or has appeared in a data breach. Choose another.";

export function weakPasswordMessage(
  error: { code?: string; reasons?: readonly string[] } | null,
  password: string,
): string | null {
  if (error?.code !== "weak_password") return null;

  const reasons = error.reasons ?? [];
  if (reasons.includes("characters")) {
    console.error(
      "Supabase hosted password configuration conflicts with the application's no-composition-rule policy.",
      { reasons },
    );
  }

  if (reasons.includes("pwned")) return WEAK_NEW_PASSWORD_ERROR;

  if (reasons.includes("length")) {
    const parsed = newPasswordSchema.safeParse({ password, confirmPassword: password });
    if (!parsed.success) {
      const localError = fieldValidationErrors(parsed.error).password;
      if (
        localError === "Use at least 15 characters." ||
        localError === "This password is too long. Use a shorter passphrase."
      ) {
        return localError;
      }
    }
    return "The authentication provider rejected this password's length requirements. Please contact support.";
  }

  return "The authentication provider rejected this password's requirements. Please contact support.";
}

export function safeAuthError(
  context: AuthContext,
  code?: string,
): string {
  if (context === "signin") {
    if (code === "email_not_confirmed") {
      return "Confirm your email address before signing in.";
    }

    return "Email or password is incorrect.";
  }

  if (context === "callback") {
    return "This authentication link is invalid or has expired.";
  }

  return context === "signup"
    ? "We could not create your account. Please try again."
    : "We could not update your password. Please try again.";
}

export type SignUpDecision = "check-email" | "error";

export function decideSignUpResult(input: {
  hasSession: boolean;
  hasUser: boolean;
  hasError: boolean;
}): SignUpDecision {
  if (input.hasError) return "error";
  if (input.hasSession) return "error";
  return input.hasUser ? "check-email" : "error";
}

export type AccountDecision = "active" | "suspended" | "structural-error";

export function decideAccountAccess(
  status: string | null | undefined,
): AccountDecision {
  if (status === null || status === undefined) {
    return "structural-error";
  }

  if (status === "active") return "active";
  if (status === "suspended") return "suspended";
  return "structural-error";
}
