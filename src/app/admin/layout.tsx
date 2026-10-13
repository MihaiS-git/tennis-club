import { ManagementShell } from "@/components/management-shell";
import { requireReservationRole } from "@/lib/reservations/authorization";
import { createClient } from "@/lib/supabase/server";

export const instant = false;

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const account = await requireReservationRole(await createClient());
  return <ManagementShell isAdmin={account.roles.includes("admin")}>{children}</ManagementShell>;
}
