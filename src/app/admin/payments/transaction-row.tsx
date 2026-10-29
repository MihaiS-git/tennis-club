import Link from "next/link";
import { RowLink } from "@/components/row-link";
import { adminBookingLinkFrom } from "@/lib/bookings/admin-query";
import { formatMoney } from "@/lib/pricing/money";
import type { AdminPaymentTransaction } from "@/lib/payments/admin";
import { StatusBadge } from "@/components/status-badge";
import { paymentMethodLabels, paymentProviderLabels, adminTransactionHref, transactionStatusLabel, transactionStatusTone, transactionTimestamp } from "@/lib/payments/admin-query";
import { TransactionDetail } from "./transaction-detail";

export function TransactionRow({ transaction, detail = false, listHref = "/admin/payments/transactions", bookingReturnHref, showTimezone = true }: {
  transaction: AdminPaymentTransaction; detail?: boolean; listHref?: string; bookingReturnHref?: string; showTimezone?: boolean;
}) {
  return detail ? <TransactionDetail transaction={transaction} listHref={listHref} bookingReturnHref={bookingReturnHref} />
    : <TransactionListRow transaction={transaction} listHref={listHref} showTimezone={showTimezone} />;
}

function TransactionListRow({ transaction: t, listHref, showTimezone }: { transaction: AdminPaymentTransaction; listHref: string; showTimezone: boolean }) {
  const payment = transactionStatusLabel(t);
  const method = t.method ? paymentMethodLabels[t.method] : "Unknown";
  const provider = t.provider ? paymentProviderLabels[t.provider] : null;
  const href = adminTransactionHref(t.transaction_kind, t.transaction_id, listHref.split("?")[1]);
  return (
      <tr
        className={`relative cursor-pointer hover:bg-surface-muted focus-within:bg-surface-muted [&_td]:px-3 [&_td]:py-2.5 [&_td]:align-top ${t.needsAttention ? "bg-danger-background/40 shadow-[inset_3px_0_0_var(--danger)]" : ""}`}
      >
        <td className="whitespace-nowrap">
          <time dateTime={t.created_at}>{transactionTimestamp(t.created_at, t.location_timezone)}</time>
          {showTimezone && <span className="block text-xs text-muted-foreground">{t.location_timezone}</span>}
        </td>
        <td>
          <span className="block font-medium">{t.customer_name}</span>
          <span className="block text-xs text-muted-foreground">
            {t.customer_email}
          </span>
        </td>
        <td>{t.is_actual_booking ? <Link href={adminBookingLinkFrom(t.booking_id, listHref)} title={t.booking_id}
          className="relative z-10 font-mono text-xs text-primary underline focus-visible:outline-2 focus-visible:outline-focus">
          <span aria-hidden="true">#{t.booking_id.slice(0, 8)}</span><span className="sr-only">Booking {t.booking_id}</span></Link> : <span className="font-mono text-xs">Checkout #{t.booking_id.slice(0, 8)}</span>}</td>
        <td><RowLink href={href} className="text-primary underline">{t.operation_label}</RowLink>
          {t.proposal && !t.proposal.acceptedRevisionId && <span className="block text-xs text-muted-foreground">
            {t.proposal.kind === "cancellation" ? "Cancellation request" : "Proposed modification"} · {t.proposal.status === "pending" ? "Pending" : "Not applied"}
          </span>}
        </td>
        <td className={`whitespace-nowrap text-right font-semibold tabular-nums ${t.transaction_kind === "refund" ? "text-accent" : "text-foreground"}`}>
          {t.transaction_kind === "refund" ? "−" : "+"}{formatMoney(t.amount_minor, t.currency)}
        </td>
        <td className="whitespace-nowrap">{method}{provider && <span className="block text-xs text-muted-foreground">{provider}</span>}</td>
        <td>
          <span className="flex flex-col items-start gap-1">
            <StatusBadge tone={transactionStatusTone(t)}>{payment}</StatusBadge>
            {t.needsAttention && <span className="text-xs font-semibold text-danger">Needs attention</span>}
          </span>
        </td>
      </tr>
  );
}
