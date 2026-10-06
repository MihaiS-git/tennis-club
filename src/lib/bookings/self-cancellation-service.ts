import "server-only";
import { cancelBookingCommand } from "@/lib/bookings/cancellation-service";

import { z } from "zod";
import { readCurrentAccount } from "@/lib/auth/account";
import { logger } from "@/lib/logger";
import { createClient } from "@/lib/supabase/server";
import { listOwnUpcomingCustomerBookings } from "./personal-service";
import { customerBookingNoticeBypass, customerCancellationEligibility } from "./self-cancellation";

import { finishBookingCancellation, type BookingCancellationResult } from "@/lib/payments/refunds";
const messages = {
  unavailable: "This booking is no longer available for cancellation.",
  started: "This booking has started and can no longer be cancelled here.",
  notice_required: "The cancellation notice period for this booking has expired.",
};

export async function cancelOwnCustomerBooking(id: unknown,
  client?: Awaited<ReturnType<typeof createClient>>): Promise<BookingCancellationResult> {
  const parsed = z.uuid().safeParse(id);
  if (!parsed.success) return { ok: false, message: "Choose a valid booking." };
  const supabase = client ?? await createClient();
  const account = await readCurrentAccount(supabase);
  if (account.state !== "active") return { ok: false, message: "An active account is required to cancel a booking." };
  // All reads/mutations are owner-bound. Never resolve a booking by contact
  // details or grant staff a global self-service read.
  const booking = (await listOwnUpcomingCustomerBookings(supabase)).find((row) => row.id === parsed.data);
  // Missing Upcoming rows may be a replay after a committed cancellation.
  // The RPC still verifies active ownership before returning an existing refund.
  const eligibility = booking ? customerCancellationEligibility(booking,
    customerBookingNoticeBypass(account.roles)) : "eligible";
  if (eligibility !== "eligible") return { ok: false, message: messages[eligibility] };
  let data: unknown;
  try {
    data = await cancelBookingCommand(parsed.data, account.userId, false, null);
  } catch {
    logger.error({ event: "bookings.self_cancel_failed", bookingId: parsed.data,
      actorId: account.userId }, "Failed to cancel own customer booking");
    return { ok: false, message: "Unable to cancel this booking. Try again." };
  }
  const outcome = await finishBookingCancellation(data);
  if (outcome.ok) logger.info({ event: "bookings.self_cancelled", bookingId: parsed.data,
    actorId: account.userId, refundStatus: outcome.refundStatus }, "Customer booking cancelled by owner");
  return outcome;
}
