import "server-only";

import { z } from "zod";

const responseSchema = z.object({ messageId: z.string().min(1) });

type EmailMode = "sandbox" | "live";
export type BrevoConfig = { apiKey: string; sender: string; senderName?: string; mode: EmailMode };
export type SendResult = { ok: true; messageId: string } | { ok: false; retryable: boolean; error: string };

export function brevoConfig(settings?: { officialEmail: string; senderName: string }): BrevoConfig {
  const apiKey = process.env.BREVO_API_KEY?.trim();
  const sender = settings?.officialEmail;
  const mode = process.env.NOTIFICATION_EMAIL_MODE;
  if (!apiKey || !sender || !settings?.senderName.trim() || !z.email().safeParse(sender).success || (mode !== "sandbox" && mode !== "live")) {
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
  return { apiKey, sender, senderName: settings?.senderName, mode };
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
      body: JSON.stringify({ sender: { email: config.sender, name: config.senderName }, to: [{ email: delivery.recipientEmail }],
        subject: delivery.subject, textContent: delivery.bodyText, htmlContent: delivery.bodyHtml,
        headers: { "X-Mailin-custom": `email_delivery_id:${delivery.id}`,
          ...(config.mode === "sandbox" ? { "X-Sib-Sandbox": "drop" } : {}) } }),
      signal: AbortSignal.timeout(4_000),
    });
    if (!response.ok) {
      const payload: unknown = await response.json().catch(() => null);
      const error = z.object({ message: z.string(), code: z.string().optional() }).safeParse(payload);
      const detail = error.success ? `: ${error.data.code ? `${error.data.code}: ` : ""}${error.data.message}`.slice(0, 1000) : "";
      return { ok: false, retryable: response.status === 429 || response.status >= 500,
        error: response.status === 408 ? "Brevo request outcome unknown (HTTP 408)" : `Brevo HTTP ${response.status}${detail}` };
    }
    const parsed = responseSchema.safeParse(await response.json());
    if (!parsed.success) return { ok: false, retryable: false, error: "Brevo acceptance response missing message ID" };
    return { ok: true, messageId: parsed.data.messageId };
  } catch {
    // A timeout or connection loss can occur after Brevo accepted the message.
    return { ok: false, retryable: false, error: "Brevo request outcome unknown" };
  }
}
