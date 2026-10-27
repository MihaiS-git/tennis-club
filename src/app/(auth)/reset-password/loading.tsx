import { AuthShell } from "@/components/auth-form";
import { LoadingStatus } from "@/components/loading-status";

export default function ResetPasswordLoading() {
  return (
    <AuthShell title="Checking reset link">
      <LoadingStatus label="Checking your password recovery session…" />
    </AuthShell>
  );
}
