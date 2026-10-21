"use server";

import { revalidatePath } from "next/cache";
import { saveAdminPricingRule, removeAdminPricingRule } from "@/lib/admin/pricing";

export async function savePricingRuleAction(input: unknown) {
  const result = await saveAdminPricingRule(input);
  if (result.ok) {
    revalidatePath("/admin/pricing");
    revalidatePath("/admin/locations", "layout");
    revalidatePath("/book");
    revalidatePath("/courts");
    revalidatePath("/admin/reservations");
    revalidatePath("/admin/bookings");
  }
  return result;
}
export async function removePricingRuleAction(input: unknown) {
  const result = await removeAdminPricingRule(input);
  if (result.ok) {
    revalidatePath("/admin/pricing");
    revalidatePath("/admin/locations", "layout");
    revalidatePath("/book");
    revalidatePath("/courts");
    revalidatePath("/admin/reservations");
    revalidatePath("/admin/bookings");
  }
  return result;
}
