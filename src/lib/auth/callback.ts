import { safeRedirectPath } from "./redirects";

export type SupportedOtpType = "email" | "signup" | "recovery";
export type AuthCallbackOutcome =
  | "authenticated"
  | "confirmed-sign-in-required"
  | "invalid";

export const EMAIL_CONFIRMED_MESSAGE =
  "Your email has been confirmed. Please sign in.";

export function supportedOtpType(value: string | null): SupportedOtpType | null {
  if (value === "email" || value === "signup" || value === "recovery") {
    return value;
  }

  return null;
}

export function authCallbackDestination(
  value: string | null,
  type: SupportedOtpType | null,
): string {
  if (value === "/reset-password" || type === "recovery") {
    return "/reset-password";
  }

  return safeRedirectPath(value);
}

export function isEmailConfirmationCallback(input: {
  flow: string | null;
  type: SupportedOtpType | null;
  next: string | null;
  hasCode: boolean;
}): boolean {
  if (input.flow === "email-confirmation") return true;
  if (input.type === "email" || input.type === "signup") return true;

  // Confirmation links created before the explicit flow marker was added used
  // this exact callback shape. Recovery links use /reset-password instead.
  return input.hasCode && input.next === "/account";
}

export function decideAuthCallbackOutcome(input: {
  verificationSucceeded: boolean;
  sessionEstablished: boolean;
  isEmailConfirmation: boolean;
}): AuthCallbackOutcome {
  if (!input.verificationSucceeded) return "invalid";
  if (input.sessionEstablished) return "authenticated";
  return input.isEmailConfirmation ? "confirmed-sign-in-required" : "invalid";
}
