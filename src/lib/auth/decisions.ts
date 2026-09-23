export const RECOVERY_SUCCESS_MESSAGE =
  "If an account exists for that email, a password reset link has been sent.";

type AuthContext = "signin" | "signup" | "password" | "callback";

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

  if (context === "password" && code === "weak_password") {
    return "Choose a stronger password and try again.";
  }

  if (context === "callback") {
    return "This authentication link is invalid or has expired.";
  }

  if (context === "signup" && code === "weak_password") {
    return "Choose a stronger password and try again.";
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
  queryFailed = false,
): AccountDecision {
  if (queryFailed || status === null || status === undefined) {
    return "structural-error";
  }

  if (status === "active") return "active";
  if (status === "suspended") return "suspended";
  return "structural-error";
}
