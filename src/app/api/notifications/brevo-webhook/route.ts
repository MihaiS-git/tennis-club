import { ZodError } from "zod";
import { authorizedBearer } from "@/lib/notifications/auth";
import { processBrevoFailureWebhook } from "@/lib/notifications/webhook";
import { logger } from "@/lib/logger";

export async function POST(request: Request) {
  if (!authorizedBearer(request.headers.get("authorization"), process.env.BREVO_WEBHOOK_SECRET)) {
    return new Response(null, { status: 401 });
  }
  try {
    const payload: unknown = await request.json();
    const result = await processBrevoFailureWebhook(payload);
    return Response.json({ result });
  } catch (error) {
    if (error instanceof ZodError || error instanceof SyntaxError) return new Response(null, { status: 400 });
    logger.error({ event: "notifications.brevo_webhook_failed", error }, "Brevo webhook processing failed");
    return Response.json({ error: "Webhook unavailable" }, { status: 503 });
  }
}
