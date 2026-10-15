import "server-only";

import { z } from "zod";
import { logger } from "@/lib/logger";

export type MailMessage = { to: string; subject: string; text: string };

// Legacy callers remain best-effort; financial notifications use the durable worker.
export async function sendMail(message: MailMessage): Promise<void> {
  await deliverMail(message);
}

export async function deliverMail(message: MailMessage, idempotencyKey?: string): Promise<boolean> {
  const config = z.object({ key: z.string().trim().min(1), from: z.email() }).safeParse({
    key: process.env.BREVO_API_KEY, from: process.env.BOOKING_MAIL_FROM,
  });
  if (!config.success) {
    logger.error({ event: "booking_email.configuration_missing" }, "BREVO_API_KEY and a verified BOOKING_MAIL_FROM are required");
    return false;
  }
  try {
    const response = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: { "api-key": config.data.key, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ sender: { email: config.data.from }, to: [{ email: message.to }],
        subject: message.subject, textContent: message.text,
        ...(idempotencyKey ? { headers: { idempotencyKey } } : {}) }),
      signal: AbortSignal.timeout(10_000),
    });
    // Brevo's documented idempotency rejection acknowledges an earlier submission.
    if (!response.ok && idempotencyKey) {
      const body: unknown = await response.json().catch(() => null);
      const duplicate = z.object({ code: z.literal("duplicate_parameter"), message: z.string() }).safeParse(body);
      if (duplicate.success && /idempotency/i.test(duplicate.data.message)) return true;
    }
    // Never log provider bodies, recipients, message content or transport errors.
    if (!response.ok) logger.error({ event: "booking_email.provider_rejected", status: response.status }, "Brevo rejected booking email");
    if (!response.bodyUsed) await response.body?.cancel();
    return response.ok;
  } catch {
    logger.error({ event: "booking_email.delivery_failed" }, "Brevo request failed or timed out");
    return false;
  }
}
