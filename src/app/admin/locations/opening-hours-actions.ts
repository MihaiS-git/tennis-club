"use server";

import { revalidatePath } from "next/cache";
import { mutateAdminOpeningHours } from "@/lib/admin/opening-hours";

export async function mutateOpeningHoursAction(input: unknown) {
  const result = await mutateAdminOpeningHours(input);
  if (result.ok) {
    revalidatePath("/admin/locations", "layout");
    revalidatePath("/admin/pricing");
    revalidatePath("/book");
    revalidatePath("/courts");
    revalidatePath("/admin/reservations");
  }
  return result;
}
