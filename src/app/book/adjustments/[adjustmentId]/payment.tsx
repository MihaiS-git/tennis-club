"use client";
import { useState } from "react";
import Link from "next/link";
import { OnlinePayment } from "../../online-payment";
import type { OnlineCheckout } from "@/lib/payments/domain";
import { formatMoney, type LocationCurrency } from "@/lib/pricing/money";

export function AdjustmentPayment({ originalTotal, newTotal, currency, checkout, holdExpiresAt }: {
  originalTotal: number; newTotal: number; currency: LocationCurrency; checkout: OnlineCheckout; holdExpiresAt: string;
}) {
  const [completed, setCompleted] = useState(false);
  return <section className="mt-4 space-y-3 text-sm">
    <p>Current total: {formatMoney(originalTotal, currency)}</p><p>New total: {formatMoney(newTotal, currency)}</p>
    <p className="font-semibold">Additional amount payable: {formatMoney(newTotal - originalTotal, currency)}</p>
    {completed ? <p role="status">Booking modification completed.</p> : <>
      <p>The original booking remains confirmed until payment and the modification are verified.</p>
      <OnlinePayment checkout={checkout} holdExpiresAt={holdExpiresAt} confirmationMessage="Booking modification completed." onConfirmed={() => setCompleted(true)} />
    </>}
    <Link href="/my-activity/bookings" className="underline">View my bookings</Link>
  </section>;
}
