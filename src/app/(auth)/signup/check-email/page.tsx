import Link from "next/link";
import { cookies } from "next/headers";
import { Suspense } from "react";

import { AuthShell } from "@/components/auth-form";
import { ResendConfirmation } from "@/components/auth/resend-confirmation";
import {
  SIGNUP_CONFIRMATION_DESCRIPTION,
  SIGNUP_CONFIRMATION_TITLE,
  SIGNUP_EMAIL_COOKIE,
} from "@/lib/auth/confirmation";

async function ConfirmationResend() {
  const email = (await cookies()).get(SIGNUP_EMAIL_COOKIE)?.value;
  return email ? <ResendConfirmation email={email} /> : (
    <p className="text-sm text-muted-foreground">To request another confirmation email, sign in with your email and password.</p>
  );
}

export default function SignUpCheckEmailPage() {
  return (
    <AuthShell
      title={SIGNUP_CONFIRMATION_TITLE}
      description={SIGNUP_CONFIRMATION_DESCRIPTION}
    >
      <p className="text-sm text-muted-foreground">
        After confirming your email, the confirmation link will return you to your account.
      </p>
      <div className="mt-5">
        <Suspense fallback={null}><ConfirmationResend /></Suspense>
      </div>
      <p className="mt-5 text-center text-sm">
        <Link className="text-muted-foreground underline" href="/login">
          Return to sign in
        </Link>
      </p>
    </AuthShell>
  );
}
