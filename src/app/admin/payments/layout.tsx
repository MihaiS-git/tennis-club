import { requireActiveAdmin } from "@/lib/admin/authorization";

import { AdminPageHeader } from "@/components/admin-page-controls";

export const instant = false;

export default async function PaymentsLayout({ children }: { children: React.ReactNode }) {
  await requireActiveAdmin();
  return <>
    <AdminPageHeader title="Payments" description="Review transactions and manage payment provider settings." />
    {children}
  </>;
}
