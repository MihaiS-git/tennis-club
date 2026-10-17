import { redirect } from "next/navigation";
import { profileContext } from "@/lib/profile/profile";
import { listOwnFinancialNotices, listOwnNotifications } from "@/lib/notifications/financial-notices";
import { AcknowledgeNoticeButton } from "./acknowledge-notice-button";
import { NotificationInbox } from "./notification-inbox";
import { inboxHref } from "@/lib/notifications/inbox-query";

export async function FinancialNotices({ searchParams }: { searchParams?: Promise<Record<string, string | string[] | undefined>> } = {}) {
  const { account, client } = await profileContext();
  if (account.state === "unauthenticated") redirect("/login");
  if (account.state !== "active") return <p className="text-muted-foreground">Your account cannot access notifications right now.</p>;
  const input = await searchParams ?? {};
  const [inbox, financial] = await Promise.all([listOwnNotifications(input, client), listOwnFinancialNotices(client)]);
  return <div className="space-y-5">
    {/* Financial obligations survive inbox deletion, filters and read/unread changes. */}
    {financial.some(notice => notice.important) && <section aria-label="Important payment notices" className="space-y-3">
      {financial.filter(notice => notice.important).map(notice => <article key={notice.id} role="alert"
        className="rounded-card border border-border border-l-4 border-l-danger bg-surface p-4 text-sm">
        <h2 className="font-semibold">{notice.subject}</h2>
        <p className="mt-2 whitespace-pre-line">{notice.text}</p>
        <AcknowledgeNoticeButton id={notice.id} />
      </article>)}
    </section>}
    <NotificationInbox key={inboxHref(inbox.query)} inbox={inbox} />
  </div>;
}
