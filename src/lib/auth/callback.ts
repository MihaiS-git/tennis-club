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

export function isEmailConfirmationCallback(input: {
  flow: string | null;
  type: SupportedOtpType | null;
}): boolean {
  if (input.flow === "email-confirmation") return true;
  return input.type === "email" || input.type === "signup";
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
