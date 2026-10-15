import "server-only";
import type { BookingCancellationCommandResult } from "@/lib/bookings/domain";
import { cancelBookingCommand } from "@/lib/bookings/cancellation-service";

import { z } from "zod";
import { readCurrentAccount } from "@/lib/auth/account";
import { logger } from "@/lib/logger";
import { createClient } from "@/lib/supabase/server";

import { finishBookingCancellation, type BookingCancellationResult } from "@/lib/payments/refunds";
export async function cancelOwnCustomerBooking(id: unknown,
  client?: Awaited<ReturnType<typeof createClient>>): Promise<BookingCancellationResult> {
  const parsed = z.uuid().safeParse(id);
  if (!parsed.success) return { ok: false, message: "Choose a valid booking." };
  const supabase = client ?? await createClient();
  const account = await readCurrentAccount(supabase);
  if (account.state !== "active") return { ok: false, message: "An active account is required to cancel a booking." };
  let data: BookingCancellationCommandResult;
  try {
    data = await cancelBookingCommand(parsed.data, account.userId, false);
  } catch {
    logger.error({ event: "bookings.self_cancel_failed", bookingId: parsed.data,
      actorId: account.userId }, "Failed to cancel own customer booking");
    return { ok: false, message: "Unable to cancel this booking. Try again." };
  }
  if (data.outcome === "inactive")
    return { ok: false, message: "An active account is required to cancel a booking." };
  const outcome = await finishBookingCancellation(data);
  if (outcome.ok) logger.info({ event: "bookings.self_cancelled", bookingId: parsed.data,
    actorId: account.userId, outcome: outcome.outcome }, "Customer booking cancellation accepted");
  return outcome;
}
