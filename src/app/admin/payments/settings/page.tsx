import { readAdminPaymentSettings } from "@/lib/payments/settings";
import { PaymentProviderSettings } from "../provider-settings";

export const instant = false;

export default async function AdminPaymentSettingsPage() {
  const settings = await readAdminPaymentSettings();
  return <>
    <h2 className="mb-4 font-heading text-xl font-semibold text-primary">Provider settings</h2>
    <PaymentProviderSettings key={`${settings.activeProvider ?? "none"}:${settings.providers.map((provider) => Number(provider.configured)).join("")}`} settings={settings} />
  </>;
}
