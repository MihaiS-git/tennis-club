import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowLeft, Mail } from "lucide-react";
import { profileContext } from "@/lib/profile/profile";
import { readOwnNotification } from "@/lib/notifications/financial-notices";
import { inboxHref, inboxTypeLabels, parseInboxQuery } from "@/lib/notifications/inbox-query";
import { AcknowledgeNoticeButton } from "../../acknowledge-notice-button";
import { NotificationDetailsActions } from "./notification-details-actions";

export type NotificationDetailsProps = {
  params: Promise<{ notificationId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};
export async function NotificationDetailsContent({ params, searchParams }: NotificationDetailsProps) {
  const { account, client } = await profileContext();
  if (account.state === "unauthenticated") redirect("/login");
  if (account.state !== "active") return <p>Your account cannot access notifications right now.</p>;
  const backHref = inboxHref(parseInboxQuery(await searchParams));
  const notice = await readOwnNotification((await params).notificationId, client);
  const back = <Link href={backHref}
    className="inline-flex min-h-11 items-center gap-2 rounded-control text-sm font-semibold text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus">
    <ArrowLeft aria-hidden="true" className="size-4" />Back to notifications
  </Link>;
  if (!notice) return <div className="mx-auto w-full max-w-3xl space-y-4">
    {back}
    <div className="rounded-card border border-border bg-surface p-6 sm:p-8">
      <h2 className="font-heading text-xl font-semibold text-primary">Notification unavailable</h2>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">This notification is no longer available.</p>
    </div>
  </div>;
  const kind = parseInboxQuery({ type: notice.event_kind }).type;
  return <div className="mx-auto w-full max-w-3xl space-y-4">
    {back}
    <article aria-labelledby="notification-subject" className="min-w-0 rounded-card border border-border bg-surface shadow-sm">
      <header className="space-y-3 border-b border-border p-5 sm:p-8">
        <p className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
          <Mail aria-hidden="true" className="size-4 shrink-0" />{kind === "all" ? "Booking update" : inboxTypeLabels[kind]}
        </p>
        <h2 id="notification-subject" className="break-words font-heading text-2xl leading-snug font-semibold text-primary sm:text-3xl">{notice.subject}</h2>
        <p className="text-xs text-muted-foreground"><time dateTime={notice.created_at}>{new Date(notice.created_at).toLocaleString("en-GB", { timeZone: "Europe/Bucharest" })}</time> · Bucharest time</p>
      </header>
      <div className="p-5 sm:p-8">
        <p className="whitespace-pre-wrap break-words text-sm leading-7 text-foreground sm:text-base">{notice.text}</p>
      </div>
      <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-5 py-3 sm:px-8">
        <div>
          {notice.important && !notice.acknowledged_at && <>
            <p className="text-sm text-muted-foreground">Please acknowledge this financial notice separately.</p>
            <AcknowledgeNoticeButton id={notice.id} />
          </>}
          {notice.acknowledged_at && <p className="text-sm text-muted-foreground">Acknowledged</p>}
        </div>
        <NotificationDetailsActions id={notice.id} read={Boolean(notice.read_at)} backHref={backHref} />
      </footer>
    </article>
  </div>;
}
