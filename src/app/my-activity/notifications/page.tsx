import type { Metadata } from "next";
import { Suspense } from "react";
import { FinancialNotices } from "../financial-notices";

export const metadata: Metadata = { title: "Notifications | Tennis Club" };

export default function NotificationsPage() {
  return <Suspense fallback={<p role="status" className="text-sm text-muted-foreground">Loading notifications…</p>}>
    <FinancialNotices />
  </Suspense>;
}
