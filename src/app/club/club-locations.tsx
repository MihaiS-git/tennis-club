import { customerCancellationNoticeLabel } from "@/lib/bookings/self-cancellation";
import type { PublicVisitorLocation } from "@/lib/courts/public";

function cancellationTerm(minutes: number | null) {
  if (minutes === null) return null;
  return minutes === 0 ? "Cancel any time before the booking starts" : `Cancel with at least ${customerCancellationNoticeLabel(minutes)}`;
}

async function settle(locations: Promise<PublicVisitorLocation[]>) {
  try {
    return await locations;
  } catch {
    return null;
  }
}

// Booking terms each public location currently applies, as configured.
export async function ClubBookingTerms({ locations }: { locations: Promise<PublicVisitorLocation[]> }) {
  const publicLocations = await settle(locations);
  if (!publicLocations) {
    return <p className="border-t border-border pt-4 font-sans text-sm leading-6 text-muted-foreground">Location booking terms are currently unavailable.</p>;
  }
  if (!publicLocations.length) return null;

  return (
    <ul aria-label="Booking terms by location" className="font-sans text-sm leading-6 md:text-base md:leading-7">
      {publicLocations.map((location) => {
        const terms = [cancellationTerm(location.cancellationNoticeMinutes), location.allow_pay_at_club ? "Pay at the club available" : null]
          .filter((term): term is string => Boolean(term));
        return (
          <li key={location.id} className="border-t border-border py-3 md:grid md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] md:gap-6">
            <p className="font-semibold text-primary">{location.name}</p>
            {terms.length > 0 && (
              <ul className="text-muted-foreground">
                {terms.map((term) => <li key={term}>{term}</li>)}
              </ul>
            )}
          </li>
        );
      })}
    </ul>
  );
}
