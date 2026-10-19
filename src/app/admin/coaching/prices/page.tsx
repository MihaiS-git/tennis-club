import { z } from "zod";
import { AdminToolbar } from "@/components/admin-page-controls";
import { loadAdminCoaching } from "@/lib/coaching/admin";
import { PricesLocationSelect, PricesTable } from "./prices-table";

export const instant = false;

export default async function AdminCoachingPricesPage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { programs, coaches, locations, prices } = await loadAdminCoaching();
  const requested = z.uuid().safeParse((await searchParams).location);
  const location = locations.find((item) => requested.success && item.id === requested.data.toLowerCase()) ?? locations[0];
  return <>
    <h2 className="mb-1 font-heading text-xl font-semibold text-primary">Prices</h2>
    <p className="mb-4 max-w-3xl text-sm text-muted-foreground">
      Club prices apply to every coach at a location. An individual coach price replaces the club price for that coach only.
      Amounts are in the location’s currency; coaches cannot change prices.
    </p>
    {location ? <>
      <AdminToolbar primary={<PricesLocationSelect locations={locations} selectedId={location.id} />}
        metadata={<>Prices in {location.currency}, the currency of {location.name}.</>} />
      <PricesTable key={location.id} location={location} programs={programs} coaches={coaches}
        prices={prices.filter((price) => price.location_id === location.id)} />
    </> : <p className="rounded-card border border-border bg-surface px-4 py-5 text-sm text-muted-foreground">
      No locations yet. Coaching prices are set per location and its currency.
    </p>}
  </>;
}
