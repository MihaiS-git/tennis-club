"use server";

import { redirect } from "next/navigation";

import { createClient } from "@/lib/supabase/server";

import { getAuthErrorCode, type AuthErrorCode } from "./messages";
import { getSignUpSessionOutcome } from "./signup-result";
import { parseSignInForm, parseSignUpForm } from "./validation";

function redirectWithNotice(
  path: "/account" | "/login" | "/signup",
  kind: "error" | "message",
  code: string,
): never {
  const searchParams = new URLSearchParams({ [kind]: code });

  redirect(`${path}?${searchParams.toString()}`);
}

export async function signUp(formData: FormData) {
  const parsed = parseSignUpForm(formData);

  if (!parsed.success) {
    const passwordMismatch = parsed.error.issues.some(
      ({ path }) => path[0] === "confirmPassword",
    );

    redirectWithNotice(
      "/signup",
      "error",
      passwordMismatch ? "password-mismatch" : "invalid-signup",
    );
  }

  const supabase = await createClient();
  const { data, error } = await supabase.auth.signUp({
    email: parsed.data.email,
    password: parsed.data.password,
  });

  if (error) {
    redirectWithNotice(
      "/signup",
      "error",
      getAuthErrorCode("signup", error.code),
    );
  }

  if (getSignUpSessionOutcome(data.session) === "check-email") {
    redirectWithNotice("/login", "message", "check-email");
  }

  const { data: claimsData, error: claimsError } =
    await supabase.auth.getClaims();

  if (claimsError || !claimsData?.claims.sub) {
    await supabase.auth.signOut({ scope: "local" });
    redirectWithNotice("/signup", "error", "verification-failed");
  }

  redirect("/account");
}

export async function signIn(formData: FormData) {
  const parsed = parseSignInForm(formData);

  if (!parsed.success) {
    redirectWithNotice("/login", "error", "invalid-signin");
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({
    email: parsed.data.email,
    password: parsed.data.password,
  });

  if (error) {
    redirectWithNotice(
      "/login",
      "error",
      getAuthErrorCode("signin", error.code),
    );
  }

  const { data: claimsData, error: claimsError } =
    await supabase.auth.getClaims();

  if (claimsError || !claimsData?.claims.sub) {
    await supabase.auth.signOut();
    redirectWithNotice("/login", "error", "verification-failed");
  }

  redirect("/account");
}

export async function signOut() {
  const supabase = await createClient();
  const { error } = await supabase.auth.signOut({ scope: "local" });

  if (error) {
    const code: AuthErrorCode = "signout-failed";
    redirectWithNotice("/account", "error", code);
  }

  redirectWithNotice("/login", "message", "signed-out");
}
