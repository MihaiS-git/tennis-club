import { publicationToday } from "@/lib/locations/publication";
import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { AdminPageHeader } from "@/components/admin-page-controls";
import { listAdminLocations, listAdminLocationsWithReadiness, readAdminLocationCurrencyChange } from "@/lib/admin/locations";
import { listAdminLocationOpeningHours, listAdminOpeningHoursSchedules } from "@/lib/admin/opening-hours";
import { listAdminCourts } from "@/lib/admin/courts";
import { listAdminCourtCoverage } from "@/lib/admin/court-coverage";
import { listAdminPricingRules } from "@/lib/admin/pricing";
import { CourtInventory } from "../../courts/court-inventory";
import { PricingRules } from "../../pricing/pricing-rules";
import { LocationForm } from "../location-form";
import { LocationOpeningHours } from "../location-opening-hours";
import { LocationWorkspace } from "../location-workspace";
import { countries } from "@/lib/profile/countries";
import { configurationAreas, ConfigurationIndicator, LocationStatus, PublicationStatus, publicationState } from "../configuration-status";
import { PublicationControl } from "../publication-control";

export const instant = false;
const linkClass = "font-medium text-primary underline focus-visible:outline-2 focus-visible:outline-focus";

export default async function LocationManagementPage({ params }: { params: Promise<{ locationId: string }> }) {
  const parsed = z.uuid().safeParse((await params).locationId);
  if (!parsed.success) notFound();
  const [location] = await listAdminLocationsWithReadiness("current", parsed.data);
  if (!location) notFound();
  const [intervals, locations, courts, periods, rules, schedules, currencyBlockers] = await Promise.all([
    listAdminLocationOpeningHours(location.id), listAdminLocations(), listAdminCourts(undefined, location.id),
    listAdminCourtCoverage(undefined, location.id), listAdminPricingRules(location.id), listAdminOpeningHoursSchedules(location.id),
    readAdminLocationCurrencyChange(location.id),
  ]);
  const unavailable = !location.is_active || location.archived_at !== null;
  return <>
    <AdminPageHeader title={location.name} description={[location.address_line1, location.city,
      countries.find((entry) => entry.code === location.country_code)?.name, location.timezone, location.currency].filter(Boolean).join(" · ")}>
      <LocationStatus location={location} />
      <span className="sr-only">Public booking:</span><PublicationStatus location={location} missing={location.missing} />
    </AdminPageHeader>
    <LocationWorkspace key={location.id} panels={{
      details: <LocationForm location={location} currencyBlockers={currencyBlockers} />,
      "opening-hours": <>
        <p className="mb-3 text-sm text-muted-foreground">Weekly opening hours for {location.name} ({location.timezone}).</p>
        {location.archived_at ? <p>Restore this location before changing opening hours.</p>
          : <LocationOpeningHours locationId={location.id} intervals={intervals} schedules={schedules} today={publicationToday(location.timezone)} />}
      </>,
      courts: location.archived_at ? <p>Restore this location before managing courts.</p>
        : <CourtInventory location={location} courts={courts} locations={locations} periods={periods} />,
      pricing: location.archived_at ? <p>Restore this location before configuring pricing.</p>
        : <PricingRules location={location} courts={courts} rules={rules} openingHours={intervals} schedules={schedules} />,
      "public-booking": <div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_minmax(0,18rem)] md:gap-8">
        <div className="min-w-0">
          <h2 className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">Setup checklist</h2>
          <p className="mt-1 text-sm text-muted-foreground">{location.missing.length ? "Complete these requirements before enabling public booking:" : "All setup requirements are complete."}</p>
          <ul className="mt-3 divide-y divide-border rounded-control border border-border text-sm">{configurationAreas.map((area) => {
            const missing = location.missing.includes(area.requirement);
            const waitingForCourts = area.target === "pricing" && location.missing.includes("an active court");
            return <li key={area.target} className="flex min-h-11 items-center gap-3 px-3 py-2">
              <span aria-hidden="true" className="inline-flex"><ConfigurationIndicator area={area} missing={location.missing} /></span>
              {missing ? <Link href={`?tab=${area.target}`} className={linkClass}>{area.missing}</Link>
                : <span className={waitingForCourts ? "text-muted-foreground" : "text-foreground"}>
                  {waitingForCourts ? "Add active courts before configuring pricing" : `${area.label} configured`}</span>}
            </li>;
          })}</ul>
        </div>
        <div className="min-w-0 md:border-l md:border-border md:pl-8">
          <h2 className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">Publication</h2>
          <p className="mt-2 text-sm">{publicationState(location, location.missing)}. Publication {location.is_public ? "enabled" : "disabled"}.</p>
          {unavailable && <p className="mt-2 text-sm text-muted-foreground">{location.archived_at ? "Restore and activate" : "Activate"} this location before making it available for public booking.</p>}
          {!location.archived_at && <PublicationControl key={String(location.is_public)} id={location.id} published={location.is_public} blocked={unavailable || location.missing.length > 0} />}
        </div>
      </div>,
    }} />
  </>;
}
