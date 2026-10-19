"use client";

import { usePathname, useRouter } from "next/navigation";
import { selectClass } from "../coaching-form";

export function AvailabilityCoachSelect({ coaches, selectedId }: {
  coaches: { user_id: string; display_name: string; ineligibility: string | null }[]; selectedId: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  return <label className="flex w-full flex-col gap-1.5 text-sm font-medium text-primary sm:w-72">
    Coach
    <select name="coach" value={selectedId} className={selectClass}
      onChange={(event) => router.push(`${pathname}?coach=${encodeURIComponent(event.target.value)}`, { scroll: false })}>
      {coaches.map((coach) => <option key={coach.user_id} value={coach.user_id}>
        {coach.display_name}{coach.ineligibility ? " (not an active coach)" : ""}
      </option>)}
    </select>
  </label>;
}
