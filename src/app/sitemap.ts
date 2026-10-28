import type { MetadataRoute } from "next";
import { connection } from "next/server";

import { getApplicationUrl } from "@/lib/auth/site-url";
import { readPublicCoaching } from "@/lib/coaching/public";
import { listPublicLocationsWithCourts } from "@/lib/courts/public";

const publicRoutes = ["/", "/courts", "/coaching", "/pricing", "/club", "/contact", "/book"];

// Public coach profiles are read per request; a failed read still lists the public pages.
async function publicCoachRoutes() {
  try {
    const { coaches } = await readPublicCoaching(await listPublicLocationsWithCourts());
    return coaches.map((coach) => `/coaching/coaches/${coach.id}`);
  } catch {
    return [];
  }
}

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  await connection();
  return [...publicRoutes, ...await publicCoachRoutes()].map((path) => ({ url: getApplicationUrl(path) }));
}
