export type SignUpSessionOutcome = "authenticated" | "check-email";

export function getSignUpSessionOutcome(
  session: object | null,
): SignUpSessionOutcome {
  return session === null ? "check-email" : "authenticated";
}
