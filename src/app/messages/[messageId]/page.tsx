import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { adminMessageDelivery } from "@/lib/notifications/admin-delivery";
import { DeliveryDetails } from "./delivery-details";
import { logger } from "@/lib/logger";
import { messageAccess, messageCategory, openOwnMessage, safeMessageHref } from "@/lib/notifications/inbox";
import { inboxHref, parseInboxQuery } from "@/lib/notifications/inbox-query";
import { MessageDetailActions } from "./unread-button";
import { MessageReadSignal } from "./read-signal";

export const metadata: Metadata = { title: "Notification | Tennis Club" };

export default async function MessageDetailsPage({ params, searchParams }: {
  params: Promise<{ messageId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const access = await messageAccess();
  if (access.state === "unauthenticated") redirect("/login");
  if (access.state !== "ready") return <p role="alert" className="text-sm text-muted-foreground">Your notifications are unavailable right now.</p>;
  const { messageId } = await params;
  let message;
  try { message = await openOwnMessage(access.userId, messageId); }
  catch {
    logger.error({ event: "messages.detail_failed" }, "Failed to load notification");
    return <p role="alert" className="rounded-card border border-border bg-surface p-5 text-sm text-primary">Unable to load this notification. Please try again.</p>;
  }
  if (!message) notFound();
  const delivery = message.kind === "email.delivery_failed" ? await adminMessageDelivery(message.id) : null;
  const returnHref = inboxHref(parseInboxQuery(await searchParams));
  const href = safeMessageHref(message.href);
  return <article className="min-w-0 rounded-card border border-border bg-surface-elevated p-5 shadow-card md:p-7">
    <MessageReadSignal id={message.id} />
    <Link href={returnHref} className="text-sm font-semibold text-primary hover:text-accent">← Back to Messages</Link>
    <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
      <span className="text-xs font-semibold uppercase tracking-[0.12em] text-accent">{messageCategory(message.kind)}</span>
      <MessageDetailActions id={message.id} subject={message.subject} returnHref={returnHref} />
    </div>
    <h1 className="mt-2 font-heading text-2xl font-semibold text-primary md:text-3xl">{message.subject}</h1>
    <time dateTime={message.createdAt.toISOString()} className="mt-2 block text-sm text-muted-foreground">{message.createdAt.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}</time>
    <p className="mt-6 whitespace-pre-wrap break-words border-t border-border pt-6 text-sm leading-7 text-foreground">{message.kind === "email.delivery_failed" ? "An outbound booking email could not be delivered." : message.bodyText}</p>
    {delivery && <DeliveryDetails messageId={message.id} delivery={delivery} />}
    {href && <Link href={href} className="mt-6 inline-flex min-h-10 items-center font-semibold text-primary underline hover:text-accent">View booking</Link>}
  </article>;
}
