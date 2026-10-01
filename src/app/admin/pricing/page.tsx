import { z } from "zod";
import { AdminPageHeader, AdminToolbar } from "@/components/admin-page-controls";
import { listAdminLocations } from "@/lib/admin/locations";
import { listAdminPricingRules } from "@/lib/admin/pricing";
import { listAdminCourts } from "@/lib/admin/courts";
import { listAdminLocationOpeningHours } from "@/lib/admin/opening-hours";
import { PricingLocationSelect } from "./location-select";
import { PricingRules } from "./pricing-rules";

export const instant = false;

export default async function AdminPricingPage({ searchParams }: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const locations = await listAdminLocations();
  const requested = z.uuid().safeParse((await searchParams).location);
  const selected = locations.length === 1 ? locations[0]
    : requested.success ? locations.find((location) => location.id === requested.data) : locations[0];
  const [rules, allCourts, openingHours] = selected
    ? await Promise.all([listAdminPricingRules(selected.id), listAdminCourts(), listAdminLocationOpeningHours(selected.id)]) : [[], [], []];
  const courts = allCourts.filter((court) => court.location_id === selected?.id);
  return <>
    <AdminPageHeader title="Pricing" description="Manage hourly pricing for specific courts, operational states, days and dates." />
    {selected ? <PricingRules key={selected.id} location={selected} locations={locations} courts={courts} rules={rules} openingHours={openingHours} />
      : locations.length > 0 ? <>
        <AdminToolbar primary={<PricingLocationSelect locations={locations} />} />
        <p>Select an existing location.</p>
      </> : <p>No locations found. Create a location first.</p>}
  </>;
}
