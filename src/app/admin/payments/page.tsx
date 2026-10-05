import { AdminPageHeader } from "@/components/admin-page-controls";
import { readAdminPaymentSettings } from "@/lib/payments/settings";
import { PaymentProviderSettings } from "./provider-settings";

export const instant = false;

export default async function AdminPaymentsPage() {
  const settings = await readAdminPaymentSettings();
  return <>
    <AdminPageHeader title="Payment settings" description="Choose the provider for new online payments." />
    <PaymentProviderSettings key={`${settings.activeProvider ?? "none"}:${settings.providers.map((provider) => Number(provider.configured)).join("")}`} settings={settings} />
  </>;
}
