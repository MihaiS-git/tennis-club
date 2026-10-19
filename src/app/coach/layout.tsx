import { ManagementShell } from "@/components/management-shell";
import { requireActiveCoach } from "@/lib/coaching/authorization";

export const instant = false;

export default async function CoachLayout({ children }: { children: React.ReactNode }) {
  const account = await requireActiveCoach();
  return <ManagementShell isAdmin={account.roles.includes("admin")} isCoach>{children}</ManagementShell>;
}
