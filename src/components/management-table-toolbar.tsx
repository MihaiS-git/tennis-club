"use client";

import Link from "next/link";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState, useTransition, type ReactNode } from "react";
import { AdminToolbar } from "@/components/admin-page-controls";
import { FilterClearSlot } from "@/components/filter-clear-slot";

export type TableFilterControl = { name: string; label: string; options: { value: string; label: string }[] };

export function ManagementTableToolbar({ searchLabel, placeholder, controls, action }: {
  searchLabel: string; placeholder: string; controls: TableFilterControl[]; action?: ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();
  const queryString = searchParams.toString();
  const value = (key: string) => {
    const values = searchParams.getAll(key);
    return values.length === 1 ? values[0] : undefined;
  };
  const search = value("q") ?? "";
  const [draft, setDraft] = useState({ queryString, text: search });
  // Reset draft state on every external navigation, including Back/Forward.
  if (draft.queryString !== queryString) {
    setDraft({ queryString, text: search });
  }
  const text = draft.queryString === queryString ? draft.text : search;
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
    startTransition(() => router.replace(`${pathname}${params.size ? `?${params}` : ""}`, { scroll: false }));
  }

  const controlClass = "min-h-11 rounded-control border border-border-strong bg-surface px-3 py-2 text-base text-foreground sm:text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";
  const hasFilters = Boolean(search || controls.some(control => value(control.name)));
  return (
    <AdminToolbar pending={pending} primary={<label className="flex w-full flex-col gap-1.5 text-sm font-medium text-primary sm:w-64 lg:w-80">
        {searchLabel}
        <input name="q" type="search" value={text} placeholder={placeholder} className={controlClass}
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
      {controls.map(control => <label key={control.name} className="flex w-full flex-col gap-1.5 text-sm font-medium text-primary sm:w-auto sm:min-w-36">
        {control.label}
        <select name={control.name} value={value(control.name) ?? ""} className={`${controlClass} w-full`} onChange={event => navigate(control.name, event.target.value)}>
          {control.options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      </label>)}
      <FilterClearSlot active={hasFilters} className="min-h-11">
        <Link scroll={false} href={pathname} onNavigate={event => { event.preventDefault(); currentQuery.current = ""; startTransition(() => router.replace(pathname, { scroll: false })); }} onClick={cancelSearch} className="inline-flex min-h-11 items-center whitespace-nowrap rounded-control px-2 text-sm font-medium text-primary underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus">Clear filters</Link>
      </FilterClearSlot>
    </>} action={action} />
  );
}
