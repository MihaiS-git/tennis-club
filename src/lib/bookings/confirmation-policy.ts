import "server-only";

import { cancellationNoticeMinutesSchema } from "./cancellation-policy";
import { getDataSource } from "@/lib/db/data-source";
import { findBookingCancellationNotice } from "@/lib/db/repositories/bookings.repository";
import { logger } from "@/lib/logger";

export type ConfirmedCancellationPolicy = { noticeMinutes: number; cutoff: string | null };

// The ID comes from atomic creation or a capability-authorized stored checkout.
// A failed presentation read must never turn a committed booking into a failed submission.
export async function readCreatedBookingCancellationPolicy(bookingId: string): Promise<ConfirmedCancellationPolicy | null> {
  try {
    const row = await findBookingCancellationNotice((await getDataSource()).manager, bookingId);
    return { noticeMinutes: cancellationNoticeMinutesSchema.parse(row?.cancellationNoticeMinutes), cutoff: null };
  } catch {
    logger.error({ event: "bookings.confirmed_policy_read_failed", bookingId }, "Unable to read confirmed booking terms");
    return null;
  }
}
