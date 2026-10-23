import Link from "next/link";
import type { adminMessageDelivery } from "@/lib/notifications/admin-delivery";
import { RetryDeliveryButton } from "./retry-button";

type Details = NonNullable<Awaited<ReturnType<typeof adminMessageDelivery>>>;
function dateLabel(value: string | null) {
  return value ? `${new Date(value).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" })} UTC` : "Not recorded";
}

export function DeliveryDetails({ messageId, delivery }: { messageId: string; delivery: Details }) {
  return <section className="mt-6 border-t border-border pt-6" aria-labelledby="delivery-heading">
    <h2 id="delivery-heading" className="font-heading text-lg font-semibold text-primary">Delivery details</h2>
    <dl className="mt-3 grid gap-x-5 gap-y-2 text-sm sm:grid-cols-[auto_1fr]">
      <dt className="font-semibold">Booking</dt><dd>{delivery.bookingHref
        ? <Link href={delivery.bookingHref} className="text-primary underline">View booking details</Link> : "Booking association unavailable"}</dd>
      <dt className="font-semibold">Recipient</dt><dd className="break-words">{delivery.recipientEmail}</dd>
      <dt className="font-semibold">Email type</dt><dd>{delivery.emailType}</dd>
      <dt className="font-semibold">Delivery status</dt><dd>{delivery.status.replaceAll("_", " ")}</dd>
      <dt className="font-semibold">Failure reason</dt><dd className="break-words">{delivery.failureReason}</dd>
      <dt className="font-semibold">Attempts</dt><dd>{delivery.attempts}</dd>
      <dt className="font-semibold">Last attempt</dt><dd>{dateLabel(delivery.lastAttempt)} <span className="text-muted-foreground">(latest recorded delivery update)</span></dd>
      <dt className="font-semibold">Next automatic retry</dt><dd>{delivery.nextAutomaticRetry ? dateLabel(delivery.nextAutomaticRetry) : "None scheduled"}</dd>
    </dl>
    <RetryDeliveryButton messageId={messageId} {...delivery.retry} />
  </section>;
}
