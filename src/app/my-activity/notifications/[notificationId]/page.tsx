import type { Metadata } from "next";
import { Suspense } from "react";
import { NotificationDetailsContent, type NotificationDetailsProps } from "./content";

export const metadata: Metadata = { title: "Notification | Tennis Club" };
export default function NotificationDetailsPage(props: NotificationDetailsProps) {
  return <Suspense fallback={<p role="status" className="mx-auto w-full max-w-3xl rounded-card border border-border bg-surface p-6 text-sm text-muted-foreground">Loading notification…</p>}>
    <NotificationDetailsContent {...props} />
  </Suspense>;
}
