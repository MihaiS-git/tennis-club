import { redirect } from "next/navigation";

import { ResetPasswordForm } from "@/components/auth-action-forms";
import { AuthShell } from "@/components/auth-form";
import { createClient } from "@/lib/supabase/server";

export default async function ResetPasswordPage() {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getUser();

  if (error || !data.user) {
    redirect("/login?error=This+password+reset+link+is+invalid+or+has+expired.");
  }

  return (
    <AuthShell title="Choose a new password">
      <ResetPasswordForm />
    </AuthShell>
  );
}

