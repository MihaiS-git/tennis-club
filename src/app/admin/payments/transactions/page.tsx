import Link from "next/link";
import { ArrowUp, ArrowDown, ArrowUpDown } from "lucide-react";
import { Pagination } from "@/components/pagination";
import { listAdminPaymentTransactions } from "@/lib/payments/admin";
import { parseAdminPaymentQuery, adminPaymentHref } from "@/lib/payments/admin-query";
import { TransactionRow } from "../transaction-row";
import { TransactionsToolbar } from "../transactions-toolbar";

export const instant = false;

export default async function AdminPaymentsPage({ searchParams }: {
  searchParams: Promise<Record<string,string | string[] | undefined>>;
}) {
  const query = parseAdminPaymentQuery(await searchParams);
  const result = await listAdminPaymentTransactions(query);
  const timezones = new Set(result.rows.map((row) => row.location_timezone));
  const sharedTimezone = timezones.size === 1 ? result.rows[0].location_timezone : null;
  return <>
    <h2 className="sr-only">Transactions</h2>
    <TransactionsToolbar />
    <p className="mb-3 text-sm text-muted-foreground">{result.total} transactions{result.rows.length > 0 && (sharedTimezone
      ? ` · Times in ${sharedTimezone}` : " · Times in each booking location’s timezone (shown per row)")}</p>
    {result.rows.length ? <div className="overflow-x-auto rounded-card border border-border bg-surface">
      <table aria-label="Payment transactions" className="w-full text-left text-sm">
        <thead className="border-b border-border bg-surface-muted text-xs font-semibold text-muted-foreground">
          <tr>{([
            ["Date","date"], ["Customer",null], ["Booking",null], ["Transaction",null], ["Amount","amount"], ["Method",null],
            ["Provider",null], ["Status","payment"], ["Attention",null],
          ] as const).map(([label,sort]) => {
            const active = query.sort === sort;
            const Icon = active ? query.dir === "asc" ? ArrowUp : ArrowDown : ArrowUpDown;
            return <th key={label} scope="col" className="px-3 py-3" aria-sort={sort ? active ? query.dir === "asc" ? "ascending" : "descending" : "none" : undefined}>
              {sort ? <Link scroll={false} href={adminPaymentHref({ ...query,sort,dir: active && query.dir === "desc" ? "asc" : "desc" },1)}
                className="inline-flex items-center gap-1.5 hover:text-primary">{label}<Icon size={14} aria-hidden /></Link> : label}
            </th>;
          })}</tr>
        </thead><tbody className="divide-y divide-border">{result.rows.map((row) => <TransactionRow key={`${row.transaction_kind}/${row.transaction_id}`} transaction={row} listHref={adminPaymentHref(query)} showTimezone={!sharedTimezone} />)}</tbody>
      </table>
    </div> : <p className="rounded-card border border-border bg-surface p-6 text-muted-foreground">No transactions match these filters.</p>}
    {result.totalPages > 1 && <div className="mt-6"><Pagination currentPage={result.page} totalPages={result.totalPages}
      buildHref={(page) => adminPaymentHref(query,page)} /></div>}
  </>;
}
