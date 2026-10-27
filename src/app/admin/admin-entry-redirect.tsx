import { redirect } from "next/navigation";

import { requireReservationRole } from "@/lib/reservations/authorization";
import { createClient } from "@/lib/supabase/server";

export async function AdminEntryRedirect(): Promise<never> {
  const account = await requireReservationRole(await createClient());
  redirect(account.roles.includes("admin") ? "/admin/locations" : "/coach/bookings");
}
