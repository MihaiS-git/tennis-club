export const authMessages = {
  "check-email":
    "Account created. Check your email to confirm it before signing in.",
  "signed-out": "You have been signed out.",
} as const;

export const authErrors = {
  "email-not-confirmed": "Confirm your email address before signing in.",
  "invalid-credentials": "The email or password is incorrect.",
  "invalid-signin": "Enter a valid email address and password.",
  "invalid-signup":
    "Enter a valid email address and a password of 8 to 72 characters.",
  "password-mismatch": "The passwords do not match.",
  "rate-limited": "Too many attempts. Wait a moment and try again.",
  "signin-failed": "We could not sign you in. Please try again.",
  "signout-failed": "We could not sign you out. Please try again.",
  "signup-disabled": "New account registration is currently unavailable.",
  "signup-failed": "We could not create your account. Please try again.",
  "verification-failed": "We could not verify your session. Please sign in again.",
} as const;

export type AuthErrorCode = keyof typeof authErrors;

export function getAuthErrorCode(
  operation: "signin" | "signup",
  providerCode: string | undefined,
): AuthErrorCode {
  if (
    providerCode === "over_request_rate_limit" ||
    providerCode === "over_email_send_rate_limit"
  ) {
    return "rate-limited";
  }

  if (operation === "signin") {
    if (providerCode === "email_not_confirmed") {
      return "email-not-confirmed";
    }

    if (
      providerCode === "invalid_credentials" ||
      providerCode === "user_not_found"
    ) {
      return "invalid-credentials";
    }

    return "signin-failed";
  }

  if (providerCode === "signup_disabled") {
    return "signup-disabled";
  }

  return "signup-failed";
}

export function readAuthNotice(
  value: string | string[] | undefined,
  notices: Record<string, string>,
) {
  const code = Array.isArray(value) ? value[0] : value;

  return code === undefined ? undefined : notices[code];
}
