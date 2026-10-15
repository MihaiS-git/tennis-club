import type { PublicLocation } from "@/lib/courts/public";
import { countLabel, summarizeClubCourts } from "@/lib/courts/summary";

async function readSummary(locations: Promise<PublicLocation[]>) {
  try {
    const resolved = await locations;
    return { locations: resolved, ...summarizeClubCourts(resolved) };
  } catch {
    return null;
  }
}

export const heroSummaryClassName = "mt-2 font-sans text-sm text-foreground md:mt-0 md:border-l md:border-border md:pl-6 lg:flex lg:flex-1 lg:items-center lg:justify-between lg:gap-5";

export async function HeroCourtSummary({ locations }: { locations: Promise<PublicLocation[]> }) {
  const summary = await readSummary(locations);
  if (!summary) return <p className={`${heroSummaryClassName} text-muted-foreground`}>Court information is currently unavailable.</p>;
  if (summary.locationCount === 0) return <p className={`${heroSummaryClassName} text-muted-foreground`}>No club locations are currently open for public booking.</p>;
  return (
    <dl className={heroSummaryClassName}>
      <div className="inline lg:block">
        <dt className="sr-only lg:not-sr-only lg:text-xs lg:text-muted-foreground">Location</dt>
        <dd className="inline font-semibold lg:mt-1 lg:block lg:whitespace-nowrap">
          {summary.locationCount === 1 ? summary.locations[0].name : countLabel(summary.locationCount, "location")} <span aria-hidden="true" className="lg:hidden">·</span>
        </dd>
      </div>{" "}
      <div className="inline lg:block">
        <dt className="sr-only lg:not-sr-only lg:text-xs lg:text-muted-foreground">Date</dt>
        <dd className="inline font-semibold lg:mt-1 lg:block">Today</dd>
      </div>
      <div>
        <dt className="sr-only lg:not-sr-only lg:text-xs lg:text-muted-foreground">Courts</dt>
        <dd className="mt-1 text-muted-foreground lg:whitespace-nowrap lg:text-foreground">{countLabel(summary.courtCount, "court")}</dd>
      </div>
    </dl>
  );
}

const facilityTitleClassName = "font-heading text-xl font-semibold leading-snug tracking-[-0.02em] text-primary";
const facilityTextClassName = "mt-3 font-sans text-sm leading-6 text-muted-foreground md:text-base md:leading-7";

export function FacilitiesCourtsFallback({ message }: { message: string }) {
  return (
    <div className="border-t border-border pt-4">
      <h3 className={facilityTitleClassName}>Courts</h3>
      <p className={facilityTextClassName}>{message}</p>
    </div>
  );
}

export async function FacilitiesCourtsSummary({ locations }: { locations: Promise<PublicLocation[]> }) {
  const summary = await readSummary(locations);
  if (!summary) return <FacilitiesCourtsFallback message="Court information is currently unavailable." />;
  if (summary.courtCount === 0) return <FacilitiesCourtsFallback message="Court details will appear once a club location opens for public booking." />;
  const surfaces = new Intl.ListFormat("en", { type: "conjunction" })
    .format(summary.surfaces.map(({ surface, count }) => countLabel(count, `${surface} court`)));
  return (
    <div className="border-t border-border pt-4">
      <h3 className={facilityTitleClassName}>
        {countLabel(summary.courtCount, "court")} across {countLabel(summary.locationCount, "location")}
      </h3>
      <p className={facilityTextClassName}>{surfaces.charAt(0).toUpperCase() + surfaces.slice(1)} for training, casual play and competitive matches.</p>
    </div>
  );
}
