import "server-only";

import { z } from "zod";

import { logger } from "@/lib/logger";
import { createClient } from "@/lib/supabase/server";

const courtSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  slug: z.string(),
  surface: z.enum(["clay", "hard", "grass", "carpet"]),
  environment: z.enum(["outdoor", "indoor"]),
  has_lighting: z.boolean(),
});
const locationSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  slug: z.string(),
  address_line1: z.string().nullable(),
  address_line2: z.string().nullable(),
  city: z.string().nullable(),
  postal_code: z.string().nullable(),
  country_code: z.string().nullable(),
  timezone: z.string(),
  courts: z.array(courtSchema),
});

export type PublicCourt = z.infer<typeof courtSchema>;
export type PublicLocation = z.infer<typeof locationSchema>;

export async function listActiveLocationsWithCourts(
  supabase?: Awaited<ReturnType<typeof createClient>>,
): Promise<PublicLocation[]> {
  const client = supabase ?? await createClient();
  // Inner embedding excludes locations that have no active courts.
  const { data, error } = await client.from("locations")
    .select("id, name, slug, address_line1, address_line2, city, postal_code, country_code, timezone, courts!inner(id, name, slug, surface, environment, has_lighting)")
    .eq("is_active", true)
    .is("archived_at", null)
    .eq("courts.is_active", true)
    .order("display_order")
    .order("name")
    .order("id")
    .order("display_order", { referencedTable: "courts" })
    .order("name", { referencedTable: "courts" })
    .order("id", { referencedTable: "courts" });

  const parsed = z.array(locationSchema).safeParse(data);
  if (error || !parsed.success) {
    logger.error({ event: "courts.public_read_failed", code: error?.code }, "Failed to load public courts");
    throw new Error("Unable to load courts.");
  }
  return parsed.data;
}
