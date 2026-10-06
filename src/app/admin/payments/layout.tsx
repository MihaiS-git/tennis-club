import { AdminPageHeader } from "@/components/admin-page-controls";
import { RouteSubmenu } from "@/components/route-submenu";

export default function PaymentsLayout({ children }: { children: React.ReactNode }) {
  return <>
    <AdminPageHeader title="Payments" description="Review transactions and manage payment provider settings." />
    <RouteSubmenu label="Payments navigation" sections={[
      { label: "Transactions", href: "/admin/payments" },
      { label: "Settings", href: "/admin/payments/settings" },
    ]} />
    {children}
  </>;
}
