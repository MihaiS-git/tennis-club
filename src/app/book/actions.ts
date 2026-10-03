"use server";

import { revalidatePath } from "next/cache";
import { fieldValidationErrors } from "@/lib/auth/validation";
import { customerBookingInputSchema } from "@/lib/bookings/domain";
import { createCustomerBooking } from "@/lib/bookings/service";
import { logger } from "@/lib/logger";
import type { LocationCurrency } from "@/lib/pricing/money";

export type ConfirmBookingResult = { ok: true; totalAmountMinor: number; currency: LocationCurrency }
  | { ok: false; reason: "price_changed"; totalAmountMinor: number; currency: LocationCurrency }
  | { ok: false; message: string; fieldErrors?: Record<string, string>; availabilityChanged?: boolean };

export async function confirmCustomerBookingAction(input: unknown): Promise<ConfirmBookingResult> {
  const parsed = customerBookingInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: "Check the customer details.",
    fieldErrors: fieldValidationErrors(parsed.error) };
  let result;
  try { result = await createCustomerBooking(parsed.data); }
  catch {
    logger.error({ event: "bookings.action_failed" }, "Customer booking action failed");
    return { ok: false, message: "Unable to confirm the booking. Please try again." };
  }
  if (!result.ok) {
    if ("reason" in result) return result;
    if (result.availabilityChanged) revalidatePath("/book");
    return { ok: false, message: result.message, availabilityChanged: result.availabilityChanged };
  }
  revalidatePath("/book");
  return { ok: true, totalAmountMinor: result.totalAmountMinor, currency: result.currency };
}
