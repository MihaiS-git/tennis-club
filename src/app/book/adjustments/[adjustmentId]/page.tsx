import { Suspense } from "react";
import { connection } from "next/server";
import { readAdjustmentPaymentLink } from "@/lib/payments/checkout";
import { AdjustmentPayment } from "./payment";

type Props = { params: Promise<{ adjustmentId: string }>; searchParams: Promise<{ token?: string | string[] }> };

async function Content({ params, searchParams }: Props) {
  await connection();
  const { adjustmentId } = await params;
  const { token } = await searchParams;
  const result = await readAdjustmentPaymentLink({ adjustmentId, token });
  if (result.kind === "unavailable") return <p>Payment link unavailable.</p>;
  return <AdjustmentPayment originalTotal={result.originalTotal} newTotal={result.newTotal} currency={result.currency}
    checkout={result.checkout} holdExpiresAt={result.holdExpiresAt} />;
}
export default function Page(props: Props) {
  return <main className="mx-auto w-full max-w-xl flex-1 p-6"><h1 className="font-heading text-2xl font-semibold">Complete booking modification</h1>
    <Suspense fallback={<p role="status">Loading payment…</p>}><Content {...props} /></Suspense></main>;
}
