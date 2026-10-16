import { redirect } from "next/navigation";
import { profileContext } from "@/lib/profile/profile";
import { listOwnFinancialNotices } from "@/lib/notifications/financial-notices";
import { AcknowledgeNoticeButton } from "./acknowledge-notice-button";

export async function FinancialNotices() {
  // Request-time account access must propagate (dynamic rendering); only the
  // database read is guarded inside the service.
  const { account, client } = await profileContext();
  if (account.state === "unauthenticated") redirect("/login");
  if (account.state !== "active") return <p className="text-muted-foreground">Your account cannot access notifications right now.</p>;
  // Only financial alerts that need the customer's attention belong here; ordinary
  // booking emails and their delivery status are not customer notifications.
  const notices = (await listOwnFinancialNotices(client)).filter(notice => notice.important);
  if (!notices.length) return <section aria-label="Important payment notices" className="rounded-card border border-border bg-surface p-5">
    <p className="text-sm text-muted-foreground">You have no notifications that need your attention.</p>
  </section>;
  return <section aria-label="Important payment notices" className="space-y-3">
    {notices.map(notice => <article key={notice.id} role="alert"
      className="rounded-card border border-danger bg-danger-background/40 p-4 text-sm">
      <h2 className="mb-2 font-heading text-base font-semibold text-danger">{notice.subject}</h2>
      <p className="whitespace-pre-line text-foreground">{notice.text}</p>
      <AcknowledgeNoticeButton id={notice.id} />
    </article>)}
  </section>;
}
