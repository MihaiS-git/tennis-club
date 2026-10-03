import { z } from "zod";
import { locationCurrencies } from "@/lib/admin/locations-validation";
import { minorAmountSchema } from "@/lib/pricing/money";

export type BookingContact = { customerName: string; customerEmail: string; customerPhone: string };

export const customerBookingInputSchema = z.strictObject({
  courtId: z.uuid(),
  date: z.iso.date(),
  startMinute: z.number().int().min(0).max(1439),
  endMinute: z.number().int().min(1).max(1440),
  customerName: z.string().trim().min(1).max(200),
  customerEmail: z.string().trim().email().max(320),
  customerPhone: z.string().trim().min(1).max(50),
  expectedTotalAmountMinor: minorAmountSchema,
  expectedCurrency: z.enum(locationCurrencies),
}).refine((value) => value.startMinute % 30 === 0 && value.endMinute % 30 === 0
  && value.endMinute - value.startMinute >= 60,
{ path: ["startMinute"], message: "Choose at least 60 minutes in 30-minute steps." });
