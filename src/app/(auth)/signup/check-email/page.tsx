import Link from "next/link";

import { AuthShell } from "@/components/auth-form";
import {
  SIGNUP_CONFIRMATION_DESCRIPTION,
  SIGNUP_CONFIRMATION_TITLE,
} from "@/lib/auth/confirmation";

export default function SignUpCheckEmailPage() {
  return (
    <AuthShell
      title={SIGNUP_CONFIRMATION_TITLE}
      description={SIGNUP_CONFIRMATION_DESCRIPTION}
    >
      <p className="text-sm text-muted-foreground">
        After confirming your email, the confirmation link will return you to your account.
      </p>
      <p className="mt-5 text-center text-sm">
        <Link className="text-muted-foreground underline" href="/login">
          Return to sign in
        </Link>
      </p>
    </AuthShell>
  );
}
