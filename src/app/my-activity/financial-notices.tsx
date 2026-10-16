import { listOwnFinancialNotices } from "@/lib/notifications/financial-notices";
import { AcknowledgeNoticeButton } from "./acknowledge-notice-button";

export async function FinancialNotices() {
  // Request-time account access must propagate (dynamic rendering); only the
  // database read is guarded inside the service.
  const notices = await listOwnFinancialNotices();
  if (!notices.length) return null;
  return <section aria-label="Important payment notices" className="mb-6 space-y-3">
    {notices.map(notice => <article key={notice.id} role={notice.important ? "alert" : "status"}
      className={`rounded-card border p-4 text-sm ${notice.important ? "border-danger bg-danger-background/40" : "border-border bg-warning-background"}`}>
      <h2 className={`mb-2 font-heading text-base font-semibold ${notice.important ? "text-danger" : "text-foreground"}`}>{notice.subject}</h2>
      {notice.emailFailed && <p className="mb-2 font-medium text-foreground">
        We could not deliver this message to your email address. It is shown here instead; the club can also see it.
      </p>}
      <p className="whitespace-pre-line text-foreground">{notice.text}</p>
      {notice.important && <AcknowledgeNoticeButton id={notice.id} />}
    </article>)}
  </section>;
}
