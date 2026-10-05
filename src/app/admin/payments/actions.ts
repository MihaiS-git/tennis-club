"use server";

import { revalidatePath } from "next/cache";
import { selectActivePaymentProvider, type PaymentSettingsResult } from "@/lib/payments/settings";

export async function selectPaymentProviderAction(input: unknown): Promise<PaymentSettingsResult> {
  const result = await selectActivePaymentProvider(input);
  if (result.ok) {
    revalidatePath("/admin/payments");
    revalidatePath("/book");
  }
  return result;
}
