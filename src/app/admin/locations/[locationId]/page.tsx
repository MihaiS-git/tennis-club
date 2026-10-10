import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { AdminPageHeader } from "@/components/admin-page-controls";
import { listAdminLocations, listAdminLocationsWithReadiness } from "@/lib/admin/locations";
import { listAdminLocationOpeningHours } from "@/lib/admin/opening-hours";
import { listAdminCourts } from "@/lib/admin/courts";
import { listAdminCourtCoverage } from "@/lib/admin/court-coverage";
import { listAdminPricingRules } from "@/lib/admin/pricing";
import { CourtInventory } from "../../courts/court-inventory";
import { PricingRules } from "../../pricing/pricing-rules";
import { LocationForm } from "../location-form";
import { LocationOpeningHours } from "../location-opening-hours";
import { LocationWorkspace } from "../location-workspace";
import { configurationAreas, LocationStatus, publicationState } from "../configuration-status";
import { PublicationControl } from "../publication-control";

export const instant = false;
const linkClass = "font-medium text-primary underline focus-visible:outline-2 focus-visible:outline-focus";

export default async function LocationManagementPage({ params }: { params: Promise<{ locationId: string }> }) {
  const parsed = z.uuid().safeParse((await params).locationId);
  if (!parsed.success) notFound();
  const [location] = await listAdminLocationsWithReadiness("current", parsed.data);
  if (!location) notFound();
  const [intervals, locations, allCourts, allPeriods, rules] = await Promise.all([
    listAdminLocationOpeningHours(location.id), listAdminLocations(), listAdminCourts(),
    listAdminCourtCoverage(), listAdminPricingRules(location.id),
  ]);
  const courts = allCourts.filter((court) => court.location_id === location.id);
  const courtIds = new Set(courts.map(({ id }) => id));
  const periods = allPeriods.filter((period) => courtIds.has(period.court_id));
  const unavailable = !location.is_active || location.archived_at !== null;
  return <>
    <AdminPageHeader title={location.name} description={[location.address_line1, location.city, location.country_code, location.timezone, location.currency].filter(Boolean).join(" · ")} />
    <div className="mb-4 flex flex-wrap gap-x-6 gap-y-2 text-sm"><LocationStatus location={location} />
      <span>Public booking: {publicationState(location, location.missing)}</span>
      <span>Configuration: {location.missing.length ? "Setup incomplete" : "Ready"}</span>
    </div>
    <LocationWorkspace key={location.id} panels={{
      details: <LocationForm location={location} />,
      "opening-hours": <>
        <p className="mb-3 text-sm text-muted-foreground">Weekly opening hours for {location.name} ({location.timezone}).</p>
        {location.archived_at ? <p>Restore this location before changing opening hours.</p>
          : <LocationOpeningHours locationId={location.id} intervals={intervals} />}
      </>,
      courts: location.archived_at ? <p>Restore this location before managing courts.</p>
        : <CourtInventory scoped location={location} courts={courts} locations={locations} periods={periods} />,
      pricing: location.archived_at ? <p>Restore this location before configuring pricing.</p>
        : <PricingRules location={location} courts={courts} rules={rules} openingHours={intervals} />,
      "public-booking": <>
        <p className="text-sm">{publicationState(location, location.missing)}. Publication {location.is_public ? "enabled" : "disabled"}.</p>
        {unavailable && <p className="mt-2 text-sm text-muted-foreground">{location.archived_at ? "Restore and activate" : "Activate"} this location before making it available for public booking.</p>}
        {location.missing.length > 0 && <><p className="mt-2 text-sm text-muted-foreground">Complete these requirements before enabling public booking:</p>
          <ul className="mt-2 space-y-1 text-sm">{configurationAreas.filter((area) => location.missing.includes(area.requirement)).map((area) => <li key={area.target}>
            <Link href={`?tab=${area.target}`} className={linkClass}>{area.missing}</Link>
          </li>)}</ul></>}
        {!location.archived_at && <PublicationControl key={String(location.is_public)} id={location.id} published={location.is_public} blocked={unavailable || location.missing.length > 0} />}
      </>,
    }} />
  </>;
}
