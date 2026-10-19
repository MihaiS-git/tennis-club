import { notFound } from "next/navigation";
import { z } from "zod";
import { requireActiveAdmin } from "@/lib/admin/authorization";
import { listAdminPaymentTransactions } from "@/lib/payments/admin";
import { parseTransactionBookingReturn } from "@/lib/bookings/admin-query";
import { adminPaymentHref, parseAdminPaymentQuery } from "@/lib/payments/admin-query";
import { TransactionRow } from "../../../transaction-row";

export const instant = false;

export default async function TransactionPage({ params, searchParams }: {
  params: Promise<{ kind: string; transactionId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireActiveAdmin();
  const parsed = z.object({ kind: z.enum(["payment", "refund", "booking"]), transactionId: z.uuid() }).safeParse(await params);
  if (!parsed.success) notFound();
  const result = await listAdminPaymentTransactions(parseAdminPaymentQuery({}), undefined, undefined,
    { kind: parsed.data.kind, id: parsed.data.transactionId });
  const transaction = result.rows[0];
  if (!transaction) notFound();
  const search = await searchParams;
  // Opened from Booking Details: the booking link restores that exact view.
  return <TransactionRow key={`${transaction.transaction_kind}/${transaction.transaction_id}`} transaction={transaction} detail
    listHref={adminPaymentHref(parseAdminPaymentQuery(search))} bookingReturnHref={parseTransactionBookingReturn(search, transaction.booking_id) ?? undefined} />;
}
