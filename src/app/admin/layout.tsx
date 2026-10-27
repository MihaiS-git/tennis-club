import { Suspense } from "react";
import { ManagementShell, ManagementShellFallback } from "@/components/management-shell";
import { requireReservationRole } from "@/lib/reservations/authorization";
import { createClient } from "@/lib/supabase/server";

async function AuthorizedAdminLayout({ children }: { children: React.ReactNode }) {
  const account = await requireReservationRole(await createClient());
  return <ManagementShell isAdmin={account.roles.includes("admin")} isCoach={account.roles.includes("coach")}>{children}</ManagementShell>;
}

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  // Let client navigation commit while request-specific authorization and the
  // entry page's role-based redirect resolve with Cache Components enabled.
  return <Suspense fallback={<ManagementShellFallback />}><AuthorizedAdminLayout>{children}</AuthorizedAdminLayout></Suspense>;
}
