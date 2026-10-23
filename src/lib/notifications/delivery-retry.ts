import { z } from "zod";
import type { EmailDeliveryStatus } from "./types";

// Only an explicit HTTP rejection is affirmative evidence that another send is safe.
export const definitiveRejectionPattern = "^Brevo HTTP (4[0-9]{2}|5[0-9]{2})(:|$)";
export function deliveryCutoff() {
  const cutoff = process.env.NOTIFICATION_DELIVERY_NOT_BEFORE?.trim();
  return cutoff ? new Date(z.iso.datetime({ offset: true }).parse(cutoff)) : null;
}

export function retryEligibility(delivery: {
  suppressedAt?: Date | null; status: EmailDeliveryStatus; providerMessageId: string | null; lastError: string | null; createdAt: Date;
}, notBefore: Date | null): { eligible: boolean; reason: string } {
  if (delivery.suppressedAt) return { eligible: false, reason: "This email was suppressed when club email delivery was disabled and cannot be resent." };
  if (delivery.status === "processing") return { eligible: false, reason: "This delivery is currently being attempted or has an unresolved processing claim. Do not send again." };
  if (delivery.providerMessageId || delivery.status === "accepted" || delivery.status === "sandbox_accepted") {
    return { eligible: false, reason: "Brevo already accepted this email (possibly in sandbox mode). Another send is prohibited. Acceptance does not confirm inbox delivery." };
  }
  if (notBefore && delivery.createdAt < notBefore) return { eligible: false, reason: "This email predates the delivery cutoff and cannot be sent." };
  if (!["pending", "failed"].includes(delivery.status) || !delivery.lastError
    || !new RegExp(definitiveRejectionPattern).test(delivery.lastError)
    || /^Brevo HTTP 408(?:[: ]|$)/.test(delivery.lastError)) {
    return { eligible: false, reason: "There is no definitive provider rejection. Brevo may already have accepted this email; another send is unsafe." };
  }
  return { eligible: true, reason: "The previous request was rejected. You can retry this email now." };
}

export function readableDeliveryError(error: string | null) {
  if (!error) return "Failure reason unavailable";
  if (error === "Brevo HTTP 401") return "Brevo rejected authentication (HTTP 401). Check the configured Brevo API key before retrying.";
  return error;
}
