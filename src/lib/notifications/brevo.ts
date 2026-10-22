import "server-only";

import { z } from "zod";

const responseSchema = z.object({ messageId: z.string().min(1) });

type EmailMode = "sandbox" | "live";
export type BrevoConfig = { apiKey: string; sender: string; mode: EmailMode };
export type SendResult = { ok: true; messageId: string } | { ok: false; retryable: boolean; error: string };

export function brevoConfig(): BrevoConfig {
  const apiKey = process.env.BREVO_API_KEY?.trim();
  const sender = process.env.BOOKING_MAIL_FROM?.trim();
  const mode = process.env.NOTIFICATION_EMAIL_MODE;
  if (!apiKey || !sender || !z.email().safeParse(sender).success || (mode !== "sandbox" && mode !== "live")) {
    throw new Error("Brevo delivery configuration is missing or invalid");
  }
  if (mode === "live" && ((process.env.NODE_ENV !== "production" && process.env.NODE_ENV !== "development")
    || Boolean(process.env.VITEST) || (Boolean(process.env.CI) && process.env.NODE_ENV !== "production")
    || process.env.NOTIFICATION_TEST_RUNNER === "1"
    || (process.env.NODE_ENV === "production"
      && /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/i.test(process.env.APP_URL ?? ""))
    || (process.env.VERCEL && process.env.VERCEL_ENV !== "production"))) {
    throw new Error("Live Brevo delivery is not permitted in this environment");
  }
  return { apiKey, sender, mode };
}

export async function sendBrevoEmail(config: BrevoConfig, delivery: {
  id: string; recipientEmail: string; subject: string; bodyText: string; bodyHtml: string;
}): Promise<SendResult> {
  if (config.mode === "live" && (process.env.NOTIFICATION_TEST_RUNNER === "1"
    || process.env.NODE_ENV === "test" || Boolean(process.env.VITEST))) {
    throw new Error("Live Brevo delivery is not permitted in automated tests");
  }
  try {
    const response = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: { "api-key": config.apiKey, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ sender: { email: config.sender }, to: [{ email: delivery.recipientEmail }],
        subject: delivery.subject, textContent: delivery.bodyText, htmlContent: delivery.bodyHtml,
        headers: { "X-Mailin-custom": `email_delivery_id:${delivery.id}`,
          ...(config.mode === "sandbox" ? { "X-Sib-Sandbox": "drop" } : {}) } }),
      signal: AbortSignal.timeout(4_000),
    });
    if (!response.ok) return { ok: false, retryable: response.status === 408 || response.status === 429 || response.status >= 500,
      error: `Brevo HTTP ${response.status}` };
    const parsed = responseSchema.safeParse(await response.json());
    if (!parsed.success) return { ok: false, retryable: true, error: "Brevo acceptance response missing message ID" };
    return { ok: true, messageId: parsed.data.messageId };
  } catch {
    // A timeout or connection loss can occur after Brevo accepted the message.
    return { ok: false, retryable: true, error: "Brevo request outcome unknown" };
  }
}
