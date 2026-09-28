import { AuthShell } from "@/components/auth-form";

export default function ResetPasswordLoading() {
  return (
    <AuthShell title="Checking reset link">
      <p role="status" className="text-sm text-muted-foreground">Checking your password recovery session…</p>
    </AuthShell>
  );
}
