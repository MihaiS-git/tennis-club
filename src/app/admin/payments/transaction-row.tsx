"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { formatMoney } from "@/lib/pricing/money";
import type { AdminPaymentTransaction } from "@/lib/payments/admin";
import { paymentMethodLabels, paymentProviderLabels, adminTransactionHref, transactionStatusLabel, transactionTimestamp } from "@/lib/payments/admin-query";
import { TransactionDetail } from "./transaction-detail";

export function TransactionRow({ transaction, detail = false, listHref = "/admin/payments/transactions", showTimezone = true }: {
  transaction: AdminPaymentTransaction; detail?: boolean; listHref?: string; showTimezone?: boolean;
}) {
  return detail ? <TransactionDetail transaction={transaction} listHref={listHref} />
    : <TransactionListRow transaction={transaction} listHref={listHref} showTimezone={showTimezone} />;
}

function TransactionListRow({ transaction: t, listHref, showTimezone }: { transaction: AdminPaymentTransaction; listHref: string; showTimezone: boolean }) {
  const router = useRouter();
  const payment = transactionStatusLabel(t);
  const method = t.method ? paymentMethodLabels[t.method] : "Unknown";
  const provider = t.provider ? paymentProviderLabels[t.provider] : "—";
  const href = adminTransactionHref(t.transaction_kind, t.transaction_id, listHref.split("?")[1]);
  return (
      <tr
        tabIndex={0}
        aria-label={`${t.operation_label} ${t.transaction_id}, booking ${t.booking_id}`}
        onClick={event => { if (!(event.target instanceof Element && event.target.closest("a"))) router.push(href); }}
        onKeyDown={(event) => {
          if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) {
            event.preventDefault(); router.push(href);
          }
        }}
        className="cursor-pointer hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-focus [&_td]:px-3 [&_td]:py-3"
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
        <td className="font-mono text-xs">#{t.booking_id.slice(0, 8)}</td>
        <td><Link href={href} className="text-primary underline">{t.operation_label}</Link>
          {t.proposal && !t.proposal.acceptedRevisionId && <span className="block text-xs text-muted-foreground">
            {t.proposal.kind === "cancellation" ? "Cancellation request" : "Proposed modification"} · {t.proposal.status === "pending" ? "Pending" : "Not applied"}
          </span>}
        </td>
        <td className="whitespace-nowrap">
          {t.transaction_kind === "refund" ? "−" : "+"}{formatMoney(t.amount_minor, t.currency)}
        </td>
        <td>{method}</td>
        <td>{provider}</td>
        <td>{payment}</td>

        <td>
          {t.needsAttention ? (
            <span className="inline-flex whitespace-nowrap rounded-control bg-danger-background px-2 py-1 text-xs font-semibold text-danger">
              Needs attention
            </span>
          ) : (
            "—"
          )}
        </td>
      </tr>
  );
}
