import { listActiveLocationsWithCourts } from "@/lib/courts/public";

export async function CourtsDiscovery() {
  const locations = await listActiveLocationsWithCourts();
  const courtCount = locations.reduce((total, location) => total + location.courts.length, 0);

  if (courtCount === 0) {
    return (
      <p className="font-sans text-base leading-7 text-muted-foreground">
        Court information is currently unavailable. Please check back soon.
      </p>
    );
  }

  return (
    <div>
      <p className="font-sans text-base leading-7 text-muted-foreground">
        <span className="font-semibold text-primary">{courtCount} {courtCount === 1 ? "court" : "courts"}</span>
        {" across "}{locations.length} {locations.length === 1 ? "location" : "locations"}.
      </p>
      <div className="mt-8 space-y-12 md:mt-10 md:space-y-16">
        {locations.map((location) => {
          const addressLines = [
            location.address_line1,
            location.address_line2,
            [location.city, location.postal_code].filter(Boolean).join(", "),
            location.country_code,
          ].filter(Boolean);

          return (
            <article key={location.id} aria-labelledby={`location-${location.id}`} className="grid gap-6 border-t border-border pt-6 lg:grid-cols-[minmax(0,4fr)_minmax(0,8fr)] lg:gap-12">
              <div>
                <h3 id={`location-${location.id}`} className="font-heading text-2xl font-semibold tracking-[-0.025em] text-primary md:text-3xl">
                  {location.name}
                </h3>
                {addressLines.length > 0 && (
                  <address className="mt-4 font-sans text-sm leading-6 text-muted-foreground not-italic md:text-base md:leading-7">
                    {addressLines.map((line, index) => <div key={index}>{line}</div>)}
                  </address>
                )}
              </div>
              <ul aria-label={`Courts at ${location.name}`}>
                {location.courts.map((court) => (
                  <li key={court.id} className="grid gap-2 border-b border-border py-4 first:pt-0 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] sm:items-baseline sm:gap-6 md:py-5">
                    <h4 className="font-heading text-lg font-semibold text-primary">{court.name}</h4>
                    <dl className="flex flex-wrap gap-x-4 gap-y-1 font-sans text-sm leading-6 text-muted-foreground">
                      <div>
                        <dt className="sr-only">Surface</dt>
                        <dd>{court.surface.charAt(0).toUpperCase() + court.surface.slice(1)}</dd>
                      </div>
                      <div>
                        <dt className="sr-only">Environment</dt>
                        <dd>{court.environment === "indoor" ? "Indoor" : court.balloon_installed ? "Balloon covered" : "Outdoor"}</dd>
                      </div>
                      {court.has_lighting && (
                        <div>
                          <dt className="sr-only">Lighting</dt>
                          <dd>Floodlit</dd>
                        </div>
                      )}
                    </dl>
                  </li>
                ))}
              </ul>
            </article>
          );
        })}
      </div>
    </div>
  );
}
