import "server-only";

import { z } from "zod";
import { logger } from "@/lib/logger";

export type MailMessage = { to: string; subject: string; text: string };

// No queue or automatic retry: provider failure never changes a committed operation.
export async function sendMail(message: MailMessage): Promise<void> {
  const config = z.object({ key: z.string().trim().min(1), from: z.email() }).safeParse({
    key: process.env.BREVO_API_KEY, from: process.env.BOOKING_MAIL_FROM,
  });
  if (!config.success) {
    logger.error({ event: "booking_email.configuration_missing" }, "BREVO_API_KEY and a verified BOOKING_MAIL_FROM are required");
    return;
  }
  try {
    const response = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: { "api-key": config.data.key, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ sender: { email: config.data.from }, to: [{ email: message.to }],
        subject: message.subject, textContent: message.text }),
      signal: AbortSignal.timeout(10_000),
    });
    // Never log provider bodies, recipients, message content or transport errors.
    if (!response.ok) logger.error({ event: "booking_email.provider_rejected", status: response.status }, "Brevo rejected booking email");
    await response.body?.cancel();
  } catch {
    logger.error({ event: "booking_email.delivery_failed" }, "Brevo request failed or timed out");
  }
}
