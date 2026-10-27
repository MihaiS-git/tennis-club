"use client";

import { usePathname, useRouter } from "next/navigation";
import { useId, useTransition } from "react";
import { FilterPendingIndicator } from "@/components/navigation-pending";
import { selectClass } from "../coaching-form";

export function AvailabilityCoachSelect({ coaches, selectedId }: {
  coaches: { user_id: string; display_name: string; ineligibility: string | null }[]; selectedId: string;
}) {
  const router = useRouter();
  const id = useId();
  const [pending, startTransition] = useTransition();
  const pathname = usePathname();
  return <div className="relative flex w-full flex-col gap-1.5 text-sm font-medium text-primary sm:w-72">
    <label htmlFor={id}>Coach</label>
    <select id={id} name="coach" value={selectedId} className={selectClass}
      onChange={(event) => startTransition(() => router.push(`${pathname}?coach=${encodeURIComponent(event.target.value)}`, { scroll: false }))}>
      {coaches.map((coach) => <option key={coach.user_id} value={coach.user_id}>
        {coach.display_name}{coach.ineligibility ? " (not an active coach)" : ""}
      </option>)}
    </select>
    <FilterPendingIndicator pending={pending} />
  </div>;
}
