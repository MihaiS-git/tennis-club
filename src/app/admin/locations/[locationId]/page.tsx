import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { AdminPageHeader } from "@/components/admin-page-controls";
import { listAdminLocationsWithReadiness } from "@/lib/admin/locations";
import { listAdminLocationOpeningHours } from "@/lib/admin/opening-hours";
import { CourtDialog } from "../../courts/court-dialog";
import { LocationDialog } from "../location-dialog";
import { LocationOpeningHours } from "../location-opening-hours";
import { configurationAreas, ConfigurationIndicator, LocationStatus, publicationState } from "../configuration-status";
import { PublicationControl } from "../publication-control";

export const instant = false;
const linkClass = "font-medium text-primary underline focus-visible:outline-2 focus-visible:outline-focus";
const sectionClass = "rounded-control border border-border bg-surface p-4 sm:p-6";

export default async function LocationManagementPage({ params }: { params: Promise<{ locationId: string }> }) {
  const parsed = z.uuid().safeParse((await params).locationId);
  if (!parsed.success) notFound();
  const [location] = await listAdminLocationsWithReadiness("current", parsed.data);
  if (!location) notFound();
  const intervals = await listAdminLocationOpeningHours(location.id);
  const unavailable = !location.is_active || location.archived_at !== null;
  return <>
    <Link href={location.archived_at ? "/admin/locations?view=archived" : "/admin/locations"} className={linkClass}>Back to locations</Link>
    <AdminPageHeader title={location.name} description={[location.address_line1, location.city, location.country_code, location.timezone, location.currency].filter(Boolean).join(" · ")} />
    <div className="mb-4 flex flex-wrap gap-x-6 gap-y-2 text-sm"><LocationStatus location={location} />
      <span>Public booking: {publicationState(location, location.missing)}</span>
      <span>Configuration: {location.missing.length ? "Setup incomplete" : "Ready"}</span>
    </div>
    <nav aria-label="Location configuration" className="mb-5 flex flex-wrap gap-4 text-sm">
      {configurationAreas.map((area) => <Link key={area.target} href={`#${area.target}`} className={`${linkClass} inline-flex items-center gap-2`}><ConfigurationIndicator area={area} missing={location.missing} />{area.label}</Link>)}
      <Link href="#public-booking" className={linkClass}>Public booking</Link>
    </nav>
    <div className="space-y-5">
      <section id="details" aria-label="Location details" className={sectionClass}><h2 className="mb-3 text-lg font-semibold">Location details</h2>
        <LocationDialog key={location.updated_at} location={location} inline />
      </section>
      <section id="opening-hours" aria-label="Opening hours" className={sectionClass}><h2 className="mb-3 text-lg font-semibold">Opening hours</h2>
        <p className="mb-3 text-sm text-muted-foreground">Weekly opening hours for {location.name} ({location.timezone}).</p>
        {location.archived_at ? <p>Restore this location before changing opening hours.</p> : <LocationOpeningHours locationId={location.id} intervals={intervals} />}
      </section>
      <section id="courts" className={sectionClass}><h2 className="mb-2 text-lg font-semibold">Courts</h2>
        <p className="mb-3 text-sm text-muted-foreground">{location.missing.includes("an active court") ? "Add and activate at least one court." : "Active courts configured."}</p>
        {!location.archived_at && <div className="flex flex-wrap items-center gap-4">
          <Link className={linkClass} href={`/admin/courts?location=${location.id}`}>Manage courts</Link>
          <CourtDialog triggerLabel="Add court" locations={[location]} locationId={location.id} />
        </div>}
      </section>
      <section id="pricing" className={sectionClass}><h2 className="mb-2 text-lg font-semibold">Pricing</h2>
        <p className="mb-3 text-sm text-muted-foreground">{location.missing.includes("an active court") ? "Add active courts before configuring pricing." : location.missing.includes("pricing for every active court") ? "Configure current or future base-state pricing for every active court." : "Pricing configured for every active court."}</p>
        {!location.archived_at && <Link className={linkClass} href={`/admin/pricing?location=${location.id}`}>Configure pricing</Link>}
      </section>
      <section id="public-booking" className={sectionClass}><h2 className="mb-2 text-lg font-semibold">Public booking</h2>
        <p className="text-sm">{publicationState(location, location.missing)}. Publication {location.is_public ? "enabled" : "disabled"}.</p>
        {unavailable && <p className="mt-2 text-sm text-muted-foreground">{location.archived_at ? "Restore and activate" : "Activate"} this location before making it available for public booking.</p>}
        {location.missing.length > 0 && <><p className="mt-2 text-sm text-muted-foreground">Complete these requirements before enabling public booking:</p>
          <ul className="mt-2 space-y-1 text-sm">{configurationAreas.filter((area) => location.missing.includes(area.requirement)).map((area) => <li key={area.target}><Link href={`#${area.target}`} className={linkClass}>{area.missing}</Link></li>)}</ul></>}
        {!location.archived_at && <PublicationControl key={String(location.is_public)} id={location.id} published={location.is_public} blocked={unavailable || location.missing.length > 0} />}
      </section>
    </div>
  </>;
}
