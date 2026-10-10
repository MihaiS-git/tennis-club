"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef } from "react";
import { AdminLocationSelect, AdminToolbar } from "@/components/admin-page-controls";
import { courtEnvironments, courtSurfaces, courtEnvironmentLabels, courtSurfaceLabels } from "@/lib/admin/courts-validation";
import { CourtDialog } from "./court-dialog";
import { courtInventorySchema } from "./inventory";

const controlClass = "rounded-control border border-border-strong bg-surface px-3 py-2 text-foreground";

export function CourtsToolbar({ locations, selectedId, scoped = false }: {
  locations: { id: string; name: string; is_active: boolean }[];
  selectedId?: string;
  scoped?: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const queryString = searchParams.toString();
  const currentQuery = useRef(queryString);
  useEffect(() => { currentQuery.current = queryString; }, [queryString]);
  const value = (key: string) => {
    const values = searchParams.getAll(key);
    return values.length === 1 ? values[0] : undefined;
  };
  const filters = courtInventorySchema.parse({ status: value("status"), surface: value("surface"), environment: value("environment") });
  const hasFilters = Boolean(filters.status || filters.surface || filters.environment);

  function navigate(key: string, value: string) {
    const params = new URLSearchParams(currentQuery.current);
    if (!scoped && selectedId && !locations.some((location) => location.id === params.get("location"))) {
      params.set("location", selectedId);
    }
    if (value) params.set(key, value); else params.delete(key);
    currentQuery.current = params.toString();
    const href = `${pathname}${params.size ? `?${params}` : ""}`;
    if (scoped) window.history.replaceState(null, "", href);
    else if (key === "location") router.push(href, { scroll: false });
    else router.replace(href, { scroll: false });
  }

  const clearQuery = new URLSearchParams(searchParams);
  for (const key of ["status", "surface", "environment"]) clearQuery.delete(key);
  const clearHref = `${pathname}${clearQuery.size ? `?${clearQuery}` : ""}`;

  return <AdminToolbar
    primary={!scoped && selectedId && <AdminLocationSelect locations={locations} selectedId={selectedId}
      onChange={(value) => navigate("location", value)} />}
    action={<CourtDialog key={selectedId} locations={scoped ? locations.filter((location) => location.id === selectedId) : locations} locationId={selectedId} />}
    filters={<>
    <label className="flex w-full flex-col gap-1.5 font-medium text-primary sm:w-auto sm:min-w-36">Status
      <select name="status" value={filters.status ?? ""} className={`${controlClass} w-full`} onChange={(event) => navigate("status", event.target.value)}>
        <option value="">All statuses</option><option value="active">Active</option><option value="inactive">Inactive</option>
      </select>
    </label>
    <label className="flex w-full flex-col gap-1.5 font-medium text-primary sm:w-auto sm:min-w-36">Surface
      <select name="surface" value={filters.surface ?? ""} className={`${controlClass} w-full`} onChange={(event) => navigate("surface", event.target.value)}>
        <option value="">All surfaces</option>{courtSurfaces.map((surface) => <option key={surface} value={surface}>{courtSurfaceLabels[surface]}</option>)}
      </select>
    </label>
    <label className="flex w-full flex-col gap-1.5 font-medium text-primary sm:w-auto sm:min-w-36">Environment
      <select name="environment" value={filters.environment ?? ""} className={`${controlClass} w-full`} onChange={(event) => navigate("environment", event.target.value)}>
        <option value="">All environments</option>{courtEnvironments.map((environment) => <option key={environment} value={environment}>{courtEnvironmentLabels[environment]}</option>)}
      </select>
    </label>
    {hasFilters && <Link href={clearHref} onClick={scoped ? (event) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault(); window.history.replaceState(null, "", clearHref);
    } : undefined}
      className="px-3 py-2 font-medium text-primary underline">Clear filters</Link>}
    </>}
  />;
}
