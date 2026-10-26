// URL slug for a location or court name: diacritics removed, lowercase ASCII words joined by hyphens.
export function generateSlug(name: string) {
  return name.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
