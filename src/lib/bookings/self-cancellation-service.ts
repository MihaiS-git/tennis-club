import "server-only";

import { z } from "zod";
import { readCurrentAccount } from "@/lib/auth/account";
import { logger } from "@/lib/logger";
import { createClient } from "@/lib/supabase/server";
import { listOwnUpcomingCustomerBookings } from "./personal-service";
import { customerCancellationEligibility } from "./self-cancellation";

type CancellationResult = { ok: true } | { ok: false; message: string };
const messages = {
  unavailable: "This booking is no longer available for cancellation.",
  started: "This booking has started and can no longer be cancelled here.",
  notice_required: "The cancellation notice period for this booking has expired.",
};

export async function cancelOwnCustomerBooking(id: unknown,
  client?: Awaited<ReturnType<typeof createClient>>): Promise<CancellationResult> {
  const parsed = z.uuid().safeParse(id);
  if (!parsed.success) return { ok: false, message: "Choose a valid booking." };
  const supabase = client ?? await createClient();
  const account = await readCurrentAccount(supabase);
  if (account.state !== "active") return { ok: false, message: "An active account is required to cancel a booking." };
  // The owner-bound read is also the application's ownership boundary. Never
  // resolve a booking by contact details or grant staff a global self-service read.
  const booking = (await listOwnUpcomingCustomerBookings(supabase)).find((row) => row.id === parsed.data);
  if (!booking) return { ok: false, message: messages.unavailable };
  const eligibility = customerCancellationEligibility(booking,
    account.roles.some((role) => role === "admin" || role === "coach"));
  if (eligibility !== "eligible") return { ok: false, message: messages[eligibility] };
  const result = await supabase.rpc("cancel_own_customer_booking", { p_id: parsed.data });
  if (result.error) {
    logger.error({ event: "bookings.self_cancel_failed", bookingId: parsed.data,
      actorId: account.userId, code: result.error.code }, "Failed to cancel own customer booking");
    return { ok: false, message: result.error.code === "42501"
      ? "An active account is required to cancel a booking." : "Unable to cancel this booking. Try again." };
  }
  if (result.data === "cancelled") {
    logger.info({ event: "bookings.self_cancelled", bookingId: parsed.data, actorId: account.userId }, "Customer booking cancelled by owner");
    return { ok: true };
  }
  const outcome = z.enum(["unavailable", "started", "notice_required"]).safeParse(result.data);
  if (outcome.success) return { ok: false, message: messages[outcome.data] };
  logger.error({ event: "bookings.self_cancel_invalid_result", bookingId: parsed.data }, "Invalid self-cancellation result");
  return { ok: false, message: "Unable to cancel this booking. Try again." };
}
