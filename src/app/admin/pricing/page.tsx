import { redirect } from "next/navigation";
import { z } from "zod";
import { listAdminLocationsWithReadiness } from "@/lib/admin/locations";

export const instant = false;

export default async function AdminPricingPage({ searchParams }: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const requested = z.uuid().safeParse(params?.location);
  if (!requested.success) redirect("/admin/locations");
  const [location] = await listAdminLocationsWithReadiness("current", requested.data);
  if (!location) redirect("/admin/locations");

  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params ?? {})) {
    if (key === "location" || key === "tab" || value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) query.append(key, item);
  }
  query.set("tab", "pricing");
  redirect(`/admin/locations/${location.id}?${query}`);
}
