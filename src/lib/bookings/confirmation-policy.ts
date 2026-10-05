import "server-only";

import { z } from "zod";
import { cancellationNoticeMinutesSchema } from "./cancellation-policy";
import { createBookingWriter } from "@/lib/supabase/booking-writer";
import { logger } from "@/lib/logger";

export type ConfirmedCancellationPolicy = { noticeMinutes: number; cutoff: string | null };

// Call only after the user-scoped public location read establishes eligibility.
export async function readPublicBookingCancellationNotice(locationId: string) {
  const result = await createBookingWriter().from("locations")
    .select("customer_cancellation_notice_minutes").eq("id", locationId).single();
  const parsed = z.object({ customer_cancellation_notice_minutes: cancellationNoticeMinutesSchema }).safeParse(result.data);
  if (result.error || !parsed.success) {
    logger.error({ event: "bookings.policy_read_failed", code: result.error?.code }, "Unable to read booking policy");
    throw new Error("Unable to load booking terms. Please try again.");
  }
  return parsed.data.customer_cancellation_notice_minutes;
}

// The ID comes from atomic creation or a capability-authorized stored checkout.
// A failed presentation read must never turn a committed booking into a failed submission.
export async function readCreatedBookingCancellationPolicy(bookingId: string,
  writer: ReturnType<typeof createBookingWriter>): Promise<ConfirmedCancellationPolicy | null> {
  try {
    const result = await writer.from("bookings").select("cancellation_notice_minutes").eq("id", bookingId).single();
    const parsed = z.object({ cancellation_notice_minutes: cancellationNoticeMinutesSchema }).safeParse(result.data);
    if (result.error || !parsed.success) throw new Error("Policy snapshot read failed");
    return { noticeMinutes: parsed.data.cancellation_notice_minutes, cutoff: null };
  } catch {
    logger.error({ event: "bookings.confirmed_policy_read_failed", bookingId }, "Unable to read confirmed booking terms");
    return null;
  }
}
