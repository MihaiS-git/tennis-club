"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { AdminToolbar } from "@/components/admin-page-controls";
import { adminUserFiltersSchema } from "@/lib/admin/users-filters";

export function UsersToolbar() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const queryString = searchParams.toString();
  const value = (key: string) => {
    const values = searchParams.getAll(key);
    return values.length === 1 ? values[0] : undefined;
  };
  const filters = adminUserFiltersSchema.parse({ search: value("q"), status: value("status"), role: value("role") });
  const [draft, setDraft] = useState({ queryString, text: filters.search ?? "" });
  // Reset draft state on every external navigation, including Back/Forward.
  if (draft.queryString !== queryString) {
    setDraft({ queryString, text: filters.search ?? "" });
  }
  const text = draft.queryString === queryString ? draft.text : filters.search ?? "";
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const currentQuery = useRef(queryString);

  function cancelSearch() {
    clearTimeout(timer.current);
    timer.current = undefined;
  }

  useEffect(() => {
    currentQuery.current = queryString;
    return () => clearTimeout(timer.current);
  }, [queryString]);

  function navigate(key: string, value: string) {
    cancelSearch();
    const params = new URLSearchParams(currentQuery.current);
    if (value) params.set(key, value); else params.delete(key);
    params.delete("page");
    // Keep consecutive immediate changes composed while navigation is pending.
    currentQuery.current = params.toString();
    router.replace(`${pathname}${params.size ? `?${params}` : ""}`, { scroll: false });
  }

  const controlClass = "min-h-11 rounded-control border border-border-strong bg-surface px-3 py-2 text-base text-foreground sm:text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";
  const hasFilters = Boolean(filters.search || filters.status || filters.role);
  return (
    <AdminToolbar primary={<label className="flex w-full flex-col gap-1.5 text-sm font-medium text-primary sm:w-64 lg:w-80">
        Email search
        <input name="q" type="search" value={text} placeholder="Search by email" className={controlClass}
          onChange={(event) => {
            const next = event.target.value;
            setDraft({ queryString, text: next });
            cancelSearch();
            const scheduledQuery = currentQuery.current;
            timer.current = setTimeout(() => {
              if (currentQuery.current === scheduledQuery) navigate("q", next.trim());
            }, 350);
          }} />
      </label>} filters={<>
      <label className="flex w-full flex-col gap-1.5 text-sm font-medium text-primary sm:w-auto sm:min-w-36">
        Status
        <select name="status" value={filters.status ?? ""} className={`${controlClass} w-full`} onChange={(event) => navigate("status", event.target.value)}>
          <option value="">All statuses</option><option value="active">Active</option><option value="suspended">Suspended</option>
        </select>
      </label>
      <label className="flex w-full flex-col gap-1.5 text-sm font-medium text-primary sm:w-auto sm:min-w-28">
        Role
        <select name="role" value={filters.role ?? ""} className={`${controlClass} w-full`} onChange={(event) => navigate("role", event.target.value)}>
          <option value="">All roles</option><option value="coach">Coach</option><option value="admin">Admin</option>
        </select>
      </label>
      {hasFilters && <Link href={pathname} onClick={cancelSearch} className="inline-flex min-h-11 items-center whitespace-nowrap rounded-control px-2 text-sm font-medium text-primary underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus">Clear filters</Link>}
    </>} />
  );
}
