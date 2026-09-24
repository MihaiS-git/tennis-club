import { redirect } from "next/navigation";

import { ResetPasswordForm } from "@/components/auth/reset-password-form";
import { AuthShell } from "@/components/auth-form";
import { hasRecoverySession } from "@/lib/auth/recovery-session";
import { createClient } from "@/lib/supabase/server";

export default async function ResetPasswordPage() {
  const supabase = await createClient();
  if (!(await hasRecoverySession(supabase))) {
    redirect("/login?notice=invalid-reset-link");
  }

  return (
    <AuthShell title="Choose a new password">
      <ResetPasswordForm />
    </AuthShell>
  );
}
