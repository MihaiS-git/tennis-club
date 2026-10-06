import "server-only";

import { z } from "zod";

import { logger } from "../logger.ts";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { MailAdapter, MailDelivery } from "../mail/adapter.ts";
import { bookingEmailEventSchema, renderBookingEmail } from "./booking-email.ts";

export function deliveryPersistence(outcome: MailDelivery["outcome"], attempts: number) {
  return {
    status: outcome === "retry" ? attempts < 10 ? "pending" : "failed" : outcome,
    delaySeconds: Math.min(3600, 30 * 2 ** Math.min(attempts - 1, 7)),
  };
}

// The scheduler/CLI owns the privileged client; application mutations never send mail.
export async function deliverNextBookingEmail(client: SupabaseClient, mail: MailAdapter): Promise<boolean> {
  const claimed = await client.rpc("claim_booking_email");
  if (claimed.error) throw new Error("Unable to claim booking email.");
  if (!Array.isArray(claimed.data)) throw new Error("Invalid booking email claim.");
  if (!claimed.data.length) return false;
  const identity = z.object({ id: z.uuid(), lease_token: z.uuid(), attempts: z.number().int().positive() }).parse(claimed.data[0]);
  const parsed = bookingEmailEventSchema.safeParse(claimed.data[0]);
  if (!parsed.success) {
    const rejected = await client.rpc("finish_booking_email", { p_id: identity.id, p_token: identity.lease_token,
      p_status: "failed", p_delay_seconds: deliveryPersistence("failed", identity.attempts).delaySeconds,
      p_error: "invalid_email_snapshot" });
    if (rejected.error || rejected.data !== true) throw new Error("Unable to reject invalid booking email.");
    logger.error({ event: "booking_email.invalid_snapshot", eventId: identity.id }, "Invalid booking email snapshot");
    return true;
  }
  const event = parsed.data;
  const message = renderBookingEmail(event);
  const started = await client.rpc("start_booking_email", { p_id: event.id, p_token: event.lease_token });
  if (started.error) throw new Error("Unable to start booking email.");
  if (started.data !== true) return true; // Lost lease: another worker owns it.
  let result: MailDelivery;
  try { result = await mail.send(message); }
  catch { result = { outcome: "uncertain", error: "adapter_acknowledgement_unknown" }; }
  const finished = await client.rpc("finish_booking_email", { p_id: event.id, p_token: event.lease_token,
    p_status: deliveryPersistence(result.outcome, identity.attempts).status,
    p_delay_seconds: deliveryPersistence(result.outcome, identity.attempts).delaySeconds, p_error: result.error ?? null });
  // A persistence failure after sending leaves sending -> uncertain on recovery.
  if (finished.error || finished.data !== true) throw new Error("Unable to record booking email outcome.");
  logger.info({ event: "booking_email.delivery", eventId: event.id, outcome: result.outcome, code: result.error }, "Booking email delivery recorded");
  return true;
}
