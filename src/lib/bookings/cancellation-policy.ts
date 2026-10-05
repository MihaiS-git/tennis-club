import { z } from "zod";

export const defaultCustomerCancellationNoticeMinutes = 1440;
export const cancellationNoticeMinutesSchema = z.number().int("Enter a whole number of minutes.")
  .min(0, "Cancellation notice cannot be negative.")
  .max(43200, "Cancellation notice cannot exceed 30 days.");
