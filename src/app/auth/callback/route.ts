import { NextResponse, type NextRequest } from "next/server";

import {
  decideAuthCallbackOutcome,
  isEmailConfirmationCallback,
  supportedOtpType,
} from "@/lib/auth/callback";
import { getApplicationUrl } from "@/lib/auth/site-url";
import { createClient } from "@/lib/supabase/server";

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const tokenHash = url.searchParams.get("token_hash");
  const type = supportedOtpType(url.searchParams.get("type"));
  const next = url.searchParams.get("next");
  const destination = next === "/reset-password" ? "/reset-password" : "/account";
  const isEmailConfirmation = isEmailConfirmationCallback({
    flow: url.searchParams.get("flow"),
    type,
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
    const notice = outcome === "confirmed-sign-in-required"
      ? "email-confirmed"
      : "invalid-auth-link";
    return NextResponse.redirect(getApplicationUrl(`/login?notice=${notice}`));
  }

  return NextResponse.redirect(getApplicationUrl(destination));
}
