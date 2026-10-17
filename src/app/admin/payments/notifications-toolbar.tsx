"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { AdminToolbar } from "@/components/admin-page-controls";
import { adminNotificationHref, notificationStateLabels, notificationStates, notificationTypes,
  type AdminNotificationQuery } from "@/lib/notifications/admin-notification-query";

const sortOptions = [
  ["created:desc", "Newest first"], ["created:asc", "Oldest first"], ["status:asc", "Status"],
  ["attempts:desc", "Most attempts"], ["next_retry:asc", "Next retry"],
] as const;

// Search, filters and the date range live in the URL; every change returns to page 1.
export function NotificationsToolbar({ query }: { query: AdminNotificationQuery }) {
  const router = useRouter();
  const href = adminNotificationHref(query);
  const [draft, setDraft] = useState({ href, text: query.q });
  if (draft.href !== href) setDraft({ href, text: query.q });
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const current = useRef(query);
  useEffect(() => { current.current = query; return () => clearTimeout(timer.current); }, [query]);
  function navigate(change: Partial<AdminNotificationQuery>) {
    clearTimeout(timer.current);
    const next = { ...current.current, ...change, page: 1 };
    current.current = next;
    router.replace(adminNotificationHref(next), { scroll: false });
  }
  const control = "min-h-10 w-full rounded-control border border-border-strong bg-surface px-3 py-2 text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";
  const label = "flex w-[calc(50%-0.375rem)] flex-col gap-1.5 font-medium text-primary sm:w-36";
  const filtered = query.q || query.status !== "all" || query.type !== "all" || query.from || query.to;
  return <AdminToolbar primary={<label className="flex w-full flex-col gap-1.5 font-medium text-primary sm:w-60">
    Search<input type="search" value={draft.text} maxLength={200} placeholder="Recipient, subject or booking ID" className={control}
      onChange={(event) => {
        const text = event.target.value;
        setDraft({ href, text }); clearTimeout(timer.current);
        // One request after typing pauses, not one per keystroke.
        timer.current = setTimeout(() => { if (text.trim() !== current.current.q) navigate({ q: text.trim() }); }, 350);
      }} />
  </label>} filters={<>
    <label className={label}>Delivery status
      <select value={query.status} className={control} onChange={(event) => navigate({ status: event.target.value as AdminNotificationQuery["status"] })}>
        <option value="all">All</option>
        {notificationStates.map((state) => <option key={state} value={state}>{notificationStateLabels[state]}</option>)}
      </select>
    </label>
    <label className={label}>Type
      <select value={query.type} className={control} onChange={(event) => navigate({ type: event.target.value })}>
        <option value="all">All</option>
        {notificationTypes.map((type) => <option key={type.id} value={type.id}>{type.subject}</option>)}
      </select>
    </label>
    <label className={label}>Created from
      <input type="date" value={query.from ?? ""} max={query.to} className={control} onChange={(event) => navigate({ from: event.target.value || undefined })} />
    </label>
    <label className={label}>Created to
      <input type="date" value={query.to ?? ""} min={query.from} className={control} onChange={(event) => navigate({ to: event.target.value || undefined })} />
    </label>
    {/* Column headers sort on wider screens; phones get the same orders here. */}
    <label className={`${label} md:hidden`}>Sort
      <select value={`${query.sort}:${query.dir}`} className={control} onChange={(event) => {
        const [sort, dir] = event.target.value.split(":") as [AdminNotificationQuery["sort"], AdminNotificationQuery["dir"]];
        navigate({ sort, dir });
      }}>
        {sortOptions.map(([value, name]) => <option key={value} value={value}>{name}</option>)}
      </select>
    </label>
    {filtered && <Link href={adminNotificationHref({ ...query, q: "", status: "all", type: "all", from: undefined, to: undefined, page: 1 })}
      onClick={() => clearTimeout(timer.current)} className="inline-flex min-h-10 items-center px-2 text-primary underline">Clear filters</Link>}
  </>} />;
}
