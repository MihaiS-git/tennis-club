import { locationCurrencies } from "@/lib/admin/locations-validation";
import { Suspense } from "react";
import { connection } from "next/server";
import { createHash } from "node:crypto";
import { z } from "zod";
import { getDataSource } from "@/lib/db/data-source";
import { findAdjustment, adjustmentAttempt } from "@/lib/db/repositories/booking-adjustments.repository";
import { onlinePaymentAdapter } from "@/lib/payments/providers";
import { AdjustmentPayment } from "./payment";

type Props = { params: Promise<{ adjustmentId: string }>; searchParams: Promise<{ token?: string | string[] }> };

async function Content({ params, searchParams }: Props) {
  await connection();
  const input = z.object({ adjustmentId: z.uuid(), token: z.string().regex(/^[a-f0-9]{64}$/) }).safeParse({ ...await params, ...await searchParams });
  if (!input.success) return <p>Payment link unavailable.</p>;
  const manager = (await getDataSource()).manager;
  const adjustment = await findAdjustment(manager, input.data.adjustmentId);
  const attempt = await adjustmentAttempt(manager, input.data.adjustmentId);
  if (!adjustment || !attempt?.providerPaymentId || attempt.checkoutTokenHash !== createHash("sha256").update(input.data.token).digest("hex"))
    return <p>Payment link unavailable.</p>;
  const currency = z.enum(locationCurrencies).parse(adjustment.currency);
  // Retrieval of the registered intent only: opening/refreshing this link cannot create a charge.
  const presentation = await (await onlinePaymentAdapter("stripe")).resumePayment({ id: attempt.id, providerPaymentId: attempt.providerPaymentId });
  return <AdjustmentPayment originalTotal={adjustment.originalTotal} newTotal={adjustment.newTotal} currency={currency}
    checkout={{ attemptId: attempt.id, token: input.data.token, presentation }} holdExpiresAt={adjustment.expiresAt.toISOString()} />;
}
export default function Page(props: Props) {
  return <main className="mx-auto w-full max-w-xl flex-1 p-6"><h1 className="font-heading text-2xl font-semibold">Complete booking modification</h1>
    <Suspense fallback={<p role="status">Loading payment…</p>}><Content {...props} /></Suspense></main>;
}
