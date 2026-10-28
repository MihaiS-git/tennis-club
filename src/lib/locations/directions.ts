import { locationAddressLines } from "@/lib/courts/summary";

type AddressedLocation = Parameters<typeof locationAddressLines>[0];

// A street line plus a city or postal code is required for a trustworthy map
// destination; anything less would let Google Maps guess a place.
export function mapQuery(location: AddressedLocation): string | null {
  if (!location.address_line1?.trim() || !(location.city?.trim() || location.postal_code?.trim())) return null;
  return locationAddressLines(location).join(", ");
}

export function directionsUrl(query: string) {
  return `https://www.google.com/maps/dir/?${new URLSearchParams({ api: "1", destination: query })}`;
}

// The Maps Embed API place view; null when the server has no embed key configured.
export function mapEmbedUrl(query: string) {
  const key = process.env.GOOGLE_MAPS_EMBED_API_KEY;
  return key ? `https://www.google.com/maps/embed/v1/place?${new URLSearchParams({ key, q: query })}` : null;
}
