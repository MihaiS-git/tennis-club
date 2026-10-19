import { createHash, timingSafeEqual } from "node:crypto";
import { parseBrevoWebhookPayload, recordBrevoDeliveryEvent, type ProviderEventResult } from "@/lib/notifications/brevo-events";
import { logger } from "@/lib/logger";

// Brevo transactional email webhook: delivery confirmations and failures for
// booking emails. Authenticated with BREVO_WEBHOOK_SECRET (32+ characters), sent
// either as a bearer token (webhook "auth" of type bearer) or as the basic-auth
// password (https://<user>:<secret>@host/... webhook URL). Brevo retries only
// timeouts and 429 responses, so a processing failure answers 429.
const maxBodyBytes = 1_000_000;

const digest = (value: string) => createHash("sha256").update(value).digest();
const same = (presented: string, secret: string) => timingSafeEqual(digest(presented), digest(secret));
function authorized(header: string | null, secret: string) {
  const bearer = header?.match(/^Bearer (\S+)$/)?.[1];
  if (bearer !== undefined) return same(bearer, secret);
  const basic = header?.match(/^Basic ([A-Za-z0-9+/=]+)$/)?.[1];
  if (basic === undefined) return false;
  const credentials = Buffer.from(basic, "base64").toString("utf8");
  const separator = credentials.indexOf(":");
  // Equal-length digests keep the comparison constant-time for any input.
  return separator >= 0 && same(credentials.slice(separator + 1), secret);
}

export async function POST(request: Request) {
  const secret = process.env.BREVO_WEBHOOK_SECRET?.trim();
  if (!secret || secret.length < 32) {
    logger.error({ event: "notifications.brevo_webhook_not_configured" }, "BREVO_WEBHOOK_SECRET (32+ characters) is required");
    return new Response("Brevo webhook is not configured", { status: 503 });
  }
  if (!authorized(request.headers.get("authorization"), secret)) {
    logger.warn({ event: "notifications.brevo_webhook_unauthorized" }, "Rejected Brevo webhook request");
    return new Response("Unauthorized", { status: 401, headers: { "WWW-Authenticate": "Bearer" } });
  }
  const body = await request.text();
  if (Buffer.byteLength(body) > maxBodyBytes) return new Response("Payload too large", { status: 413 });
  let json: unknown;
  try { json = JSON.parse(body); } catch { json = undefined; }
  const payload = parseBrevoWebhookPayload(json);
  if (!payload) {
    // Never log provider payloads: they contain recipients and bounce diagnostics.
    logger.warn({ event: "notifications.brevo_webhook_invalid" }, "Rejected invalid Brevo webhook payload");
    return new Response("Invalid payload", { status: 400 });
  }
  const counts: Record<ProviderEventResult, number> = { applied: 0, duplicate: 0, unknown: 0 };
  try {
    // Sequential: events of one message within a batch are applied in order of arrival,
    // and each event's own timestamp decides whether it is newer.
    for (const event of payload.events) counts[await recordBrevoDeliveryEvent(event)]++;
  } catch {
    logger.error({ event: "notifications.brevo_webhook_failed", ...counts }, "Brevo webhook processing failed; Brevo will retry");
    return new Response("Temporarily unable to process", { status: 429, headers: { "Retry-After": "600" } });
  }
  if (counts.unknown) logger.info({ event: "notifications.brevo_webhook_unknown", unknown: counts.unknown },
    "Brevo events for unknown or superseded messages were ignored");
  return Response.json({ ...counts, ignored: payload.ignored }, { headers: { "Cache-Control": "no-store" } });
}
