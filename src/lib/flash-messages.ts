import { EMAIL_CONFIRMED_MESSAGE } from "@/lib/auth/callback";
import { RECOVERY_SUCCESS_MESSAGE, safeAuthError } from "@/lib/auth/decisions";

export type FlashMessage = {
  kind: "error" | "success";
  text: string;
};

type SearchParams = Pick<URLSearchParams, "toString">;

const notices = {
  "recovery-link-sent": { kind: "success", text: RECOVERY_SUCCESS_MESSAGE },
  "recovery-request-failed": {
    kind: "error",
    text: "We couldn't send password reset instructions right now. Please try again.",
  },
  "password-reset-success": {
    kind: "success",
    text: "Your password has been reset. Sign in with your new password.",
  },
  "password-changed": { kind: "success", text: "Your password has been changed." },
  "email-confirmed": { kind: "success", text: EMAIL_CONFIRMED_MESSAGE },
  "invalid-auth-link": { kind: "error", text: safeAuthError("callback") },
  "invalid-reset-link": {
    kind: "error",
    text: "This password reset link is invalid or has expired.",
  },
  "signout-failed": { kind: "error", text: "We couldn't sign you out. Please try again." },
} as const satisfies Record<string, FlashMessage>;

function readNotice(searchParams: SearchParams): FlashMessage | undefined {
  const codes = new URLSearchParams(searchParams.toString()).getAll("notice");
  if (codes.length !== 1 || !Object.hasOwn(notices, codes[0])) return undefined;

  return notices[codes[0] as keyof typeof notices];
}

export function readFlashMessages(searchParams: SearchParams): FlashMessage[] {
  const notice = readNotice(searchParams);
  return notice ? [notice] : [];
}

export function removeConsumedFlashMessages(searchParams: SearchParams): string {
  const remaining = new URLSearchParams(searchParams.toString());

  if (readNotice(searchParams)) remaining.delete("notice");

  return remaining.toString();
}
