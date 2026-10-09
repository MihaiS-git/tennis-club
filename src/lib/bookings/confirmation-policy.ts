import "server-only";

import { cancellationNoticeMinutesSchema } from "./cancellation-policy";
import { getDataSource } from "@/lib/db/data-source";
import { findLocationCancellationNotice } from "@/lib/db/repositories/clubs.repository";
import { findBookingCancellationNotice } from "@/lib/db/repositories/bookings.repository";
import { normalizeDatabaseError } from "@/lib/db/errors";
import { logger } from "@/lib/logger";

export type ConfirmedCancellationPolicy = { noticeMinutes: number; cutoff: string | null };

// Call only after the user-scoped public location read establishes eligibility.
export async function readPublicBookingCancellationNotice(locationId: string) {
  try {
    const row = await findLocationCancellationNotice((await getDataSource()).manager, locationId);
    return cancellationNoticeMinutesSchema.parse(row?.customerCancellationNoticeMinutes);
  } catch (error: unknown) {
    logger.error({ event: "bookings.policy_read_failed", code: normalizeDatabaseError(error).sqlState }, "Unable to read booking policy");
    throw new Error("Unable to load booking terms. Please try again.");
  }
}

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
