"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { AdminToolbar } from "@/components/admin-page-controls";
import { parseAdminPaymentQuery, paymentStatusLabels, paymentProviderLabels, paymentMethodLabels } from "@/lib/payments/admin-query";

export function TransactionsToolbar() {
  const router = useRouter(), pathname = usePathname(), searchParams = useSearchParams();
  const queryString = searchParams.toString();
  const filters = parseAdminPaymentQuery(Object.fromEntries(["q", "status", "provider", "method", "attention"].map((key) => {
    const values = searchParams.getAll(key); return [key, values.length === 1 ? values[0] : undefined];
  })));
  const [draft, setDraft] = useState({ queryString, text: filters.q });
  if (draft.queryString !== queryString) setDraft({ queryString, text: filters.q });
  const text = draft.queryString === queryString ? draft.text : filters.q;
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const currentQuery = useRef(queryString);
  function cancelSearch() { clearTimeout(timer.current); }
  useEffect(() => { currentQuery.current = queryString; return () => clearTimeout(timer.current); }, [queryString]);
  function navigate(key: string, value: string) {
    cancelSearch();
    const params = new URLSearchParams(currentQuery.current);
    if (value && value !== "all") params.set(key, value); else params.delete(key);
    params.delete("page"); currentQuery.current = params.toString();
    router.replace(`${pathname}${params.size ? `?${params}` : ""}`, { scroll: false });
  }
  const control = "min-h-10 rounded-control border border-border-strong bg-surface px-3 py-2 text-foreground";
  return <AdminToolbar primary={<label className="flex w-full flex-col gap-1.5 font-medium text-primary sm:max-w-sm">
    Search<input type="search" value={text} maxLength={200} placeholder="Customer, booking or payment ID" className={control}
      onChange={(event) => {
        const next = event.target.value; setDraft({ queryString, text: next }); cancelSearch();
        const scheduled = currentQuery.current;
        timer.current = setTimeout(() => { if (scheduled === currentQuery.current) navigate("q", next.trim()); }, 350);
      }} />
  </label>} filters={<>
    {([
      ["status", "Payment status", paymentStatusLabels], ["provider", "Provider", paymentProviderLabels],
      ["method", "Method", paymentMethodLabels], ["attention", "Attention", { required: "Needs attention" }],
    ] as const).map(([key, label, options]) => <label key={key} className="flex flex-col gap-1.5 font-medium text-primary">
      {label}<select value={filters[key]} className={control} onChange={(event) => navigate(key, event.target.value)}>
        <option value="all">All</option>{Object.entries(options).map(([value, name]) => <option key={value} value={value}>{name}</option>)}
      </select>
    </label>)}
    {(filters.q || [filters.status, filters.provider, filters.method, filters.attention].some((value) => value !== "all")) &&
      <Link href={pathname} onClick={cancelSearch} className="px-3 py-2 text-primary underline">Clear filters</Link>}
  </>} />;
}
