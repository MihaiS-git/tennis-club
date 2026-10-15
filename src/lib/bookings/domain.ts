import { z } from "zod";
import { paymentMethodSchema } from "@/lib/payments/domain";
import { locationCurrencies } from "@/lib/admin/locations-validation";
import { minorAmountSchema } from "@/lib/pricing/money";

// Internal application result: only successful cancellation has refund obligations.
export type BookingCancellationCommandResult =
  | { outcome: "cancelled"; refundIds: string[] }
  | { outcome: "unavailable" }
  | { outcome: "inactive" }
  | { outcome: "started" }
  | { outcome: "notice_required" };

export type BookingContact = { customerName: string; customerEmail: string; customerPhone: string };

export const customerBookingInputSchema = z.strictObject({
  paymentMethod: paymentMethodSchema.default("online"),
  courtId: z.uuid(),
  date: z.iso.date(),
  startMinute: z.number().int().min(0).max(1439),
  endMinute: z.number().int().min(1).max(1440),
  customerName: z.string({ error: "Name is required." }).trim()
    .min(1, "Name is required.").max(200, "Name must be 200 characters or fewer."),
  customerEmail: z.string({ error: "Email address is required." }).trim()
    .min(1, "Email address is required.").email("Enter a valid email address.")
    .max(320, "Email address must be 320 characters or fewer."),
  customerPhone: z.string({ error: "Phone number is required." }).trim()
    .min(1, "Phone number is required.").max(50, "Phone number must be 50 characters or fewer.")
    .refine((value) => !value || (/^\+?[0-9 ()-]+$/.test(value) && /[0-9]/.test(value)),
      "Enter a valid phone number, for example +40 712 345 678."),
  expectedTotalAmountMinor: minorAmountSchema,
  expectedCurrency: z.enum(locationCurrencies),
}).refine((value) => value.startMinute % 30 === 0 && value.endMinute % 30 === 0
  && value.endMinute - value.startMinute >= 60,
{ path: ["startMinute"], message: "Choose at least 60 minutes in 30-minute steps." });

// Reserve only the target pieces outside the already-confirmed occupancy.
export function adjustmentHoldFragments(original: { courtId: string; date: string; startMinute: number; endMinute: number },
  target: { courtId: string; date: string; startMinute: number; endMinute: number }) {
  const same = original.courtId === target.courtId && original.date === target.date;
  const intervals = same ? [[target.startMinute, Math.min(target.endMinute, original.startMinute)],
    [Math.max(target.startMinute, original.endMinute), target.endMinute]] : [[target.startMinute, target.endMinute]];
  return intervals.filter(([start, end]) => end > start).map(([startMinute, endMinute]) => ({
    courtId: target.courtId, date: target.date, startMinute, endMinute,
  }));
}
