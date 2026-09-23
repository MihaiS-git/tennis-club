import { NextResponse, type NextRequest } from "next/server";

import {
  EMAIL_CONFIRMED_MESSAGE,
  authCallbackDestination,
  decideAuthCallbackOutcome,
  isEmailConfirmationCallback,
  supportedOtpType,
} from "@/lib/auth/callback";
import { safeAuthError } from "@/lib/auth/decisions";
import { getApplicationUrl } from "@/lib/auth/site-url";
import { createClient } from "@/lib/supabase/server";

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const tokenHash = url.searchParams.get("token_hash");
  const type = supportedOtpType(url.searchParams.get("type"));
  const next = url.searchParams.get("next");
  const destination = authCallbackDestination(next, type);
  const isEmailConfirmation = isEmailConfirmationCallback({
    flow: url.searchParams.get("flow"),
    type,
    next,
    hasCode: Boolean(code),
  });
  const providerVerificationFailed = Boolean(
    url.searchParams.get("error") || url.searchParams.get("error_code"),
  );
  const supabase = await createClient();

  let verificationSucceeded = false;
  let authOperationSucceeded = false;
  let sessionEstablished = false;

  if (!providerVerificationFailed && code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    authOperationSucceeded = !error;
    verificationSucceeded = authOperationSucceeded;
  } else if (!providerVerificationFailed && tokenHash && type) {
    const { error } = await supabase.auth.verifyOtp({
      token_hash: tokenHash,
      type,
    });
    authOperationSucceeded = !error;
    verificationSucceeded = authOperationSucceeded;
  }

  if (authOperationSucceeded) {
    const { data, error } = await supabase.auth.getUser();
    sessionEstablished = !error && Boolean(data.user);
  }

  const outcome = decideAuthCallbackOutcome({
    verificationSucceeded,
    sessionEstablished,
    isEmailConfirmation,
  });

  if (outcome !== "authenticated") {
    await supabase.auth.signOut({ scope: "local" });
    const query = new URLSearchParams(
      outcome === "confirmed-sign-in-required"
        ? { message: EMAIL_CONFIRMED_MESSAGE }
        : { error: safeAuthError("callback") },
    );
    return NextResponse.redirect(getApplicationUrl(`/login?${query.toString()}`));
  }

  return NextResponse.redirect(getApplicationUrl(destination));
}
