import { z } from "zod";
import { listAdminLocations } from "@/lib/admin/locations";
import { listAdminPricingRules } from "@/lib/admin/pricing";
import { listAdminCourts } from "@/lib/admin/courts";
import { PricingLocationSelect } from "./location-select";
import { PricingRules } from "./pricing-rules";

export default async function AdminPricingPage({ searchParams }: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const locations = await listAdminLocations();
  const requested = z.uuid().safeParse((await searchParams).location);
  const selected = locations.length === 1 ? locations[0]
    : requested.success ? locations.find((location) => location.id === requested.data) : locations[0];
  const [rules, allCourts] = selected
    ? await Promise.all([listAdminPricingRules(selected.id), listAdminCourts()]) : [[], []];
  const courts = allCourts.filter((court) => court.location_id === selected?.id);
  return <>
    <header className="mb-8">
      <h1 className="font-heading text-4xl font-semibold tracking-tight text-foreground md:text-5xl">Pricing</h1>
      <p className="mt-3 text-muted-foreground">Manage hourly pricing for specific courts, operational states, days and dates.</p>
    </header>
    {locations.length > 1 ? <PricingLocationSelect locations={locations} selectedId={selected?.id} />
      : locations.length === 0 ? <p>No locations found. Create a location first.</p> : null}
    {selected ? <PricingRules key={selected.id} location={selected} courts={courts} rules={rules} /> : locations.length > 0 && <p>Select an existing location.</p>}
  </>;
}
