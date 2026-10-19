import "server-only";

import { z } from "zod";
import { logger } from "@/lib/logger";

export type MailMessage = { to: string; subject: string; text: string };

function mailConfiguration() {
  const config = z.object({ key: z.string().trim().min(1), from: z.email() }).safeParse({
    key: process.env.BREVO_API_KEY, from: process.env.BOOKING_MAIL_FROM,
  });
  return config.success ? config.data : null;
}

// accepted: Brevo took the message (not proof of inbox delivery). rejected: Brevo
// refused the request permanently (4xx), so it was not sent and retrying the same
// request cannot help. unavailable: a temporary Brevo error (408, 429 or 5xx); not
// sent, worth retrying. unconfirmed: no answer (timeout or network), so it may or
// may not have been sent. not_configured: nothing was sent.
export type MailDeliveryResult = "accepted" | "rejected" | "unavailable" | "unconfirmed" | "not_configured";
// messageId: Brevo's identifier of an accepted message, which its delivery
// webhooks report as "message-id"; null when Brevo did not return one.
export type MailSubmission = { result: MailDeliveryResult; messageId: string | null };
const temporaryStatus = (status: number) => status === 408 || status === 429 || status >= 500;
const acceptedSchema = z.object({ messageId: z.string().trim().min(1).max(998) });

// submissionKey identifies one submission: Brevo's idempotency key, and echoed
// back by delivery webhooks through X-Mailin-custom so events can be correlated
// even before the returned messageId has been recorded.
export async function deliverMail(message: MailMessage, submissionKey?: string): Promise<MailSubmission> {
  const result = (value: MailDeliveryResult, messageId: string | null = null) => ({ result: value, messageId });
  const config = mailConfiguration();
  if (!config) {
    logger.error({ event: "booking_email.configuration_missing" }, "BREVO_API_KEY and a verified BOOKING_MAIL_FROM are required");
    return result("not_configured");
  }
  try {
    // Delivery runs inside customer/Admin/webhook/cron requests, so keep it short.
    const response = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: { "api-key": config.key, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ sender: { email: config.from }, to: [{ email: message.to }],
        subject: message.subject, textContent: message.text,
        ...(submissionKey ? { headers: { idempotencyKey: submissionKey, "X-Mailin-custom": brevoSubmissionReference(submissionKey) } } : {}) }),
      signal: AbortSignal.timeout(5_000),
    });
    // Brevo's documented idempotency rejection acknowledges an earlier submission.
    if (!response.ok && submissionKey) {
      const body: unknown = await response.json().catch(() => null);
      const duplicate = z.object({ code: z.literal("duplicate_parameter"), message: z.string() }).safeParse(body);
      if (duplicate.success && /idempotency/i.test(duplicate.data.message)) return result("accepted");
    }
    if (response.ok) {
      const accepted = acceptedSchema.safeParse(await response.json().catch(() => null));
      return result("accepted", accepted.success ? accepted.data.messageId : null);
    }
    // Never log provider bodies, recipients, message content or transport errors.
    logger.error({ event: "booking_email.provider_rejected", status: response.status }, "Brevo rejected booking email");
    if (!response.bodyUsed) await response.body?.cancel();
    return result(temporaryStatus(response.status) ? "unavailable" : "rejected");
  } catch {
    logger.error({ event: "booking_email.delivery_failed" }, "Brevo request failed or timed out");
    return result("unconfirmed");
  }
}

const referencePrefix = "booking-notification:";
const brevoSubmissionReference = (submissionKey: string) => `${referencePrefix}${submissionKey}`;
export function parseBrevoSubmissionReference(value: string | undefined) {
  const key = value?.startsWith(referencePrefix) ? value.slice(referencePrefix.length) : undefined;
  return z.uuid().safeParse(key).data ?? null;
}
