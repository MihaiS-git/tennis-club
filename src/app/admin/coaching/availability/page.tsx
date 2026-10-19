import { z } from "zod";
import { AdminToolbar } from "@/components/admin-page-controls";
import { AvailabilityManager } from "@/components/coach-availability/availability-manager";
import { StatusBadge } from "@/components/status-badge";
import { loadAdminCoachAvailability } from "@/lib/coaching/availability";
import { changeCoachAvailabilityAction } from "../actions";
import { AvailabilityCoachSelect } from "./coach-select";

export const instant = false;

export default async function AdminCoachAvailabilityPage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const requested = z.uuid().safeParse((await searchParams).coach);
  const { coaches, selected } = await loadAdminCoachAvailability(requested.success ? requested.data : undefined);
  return <>
    <h2 className="mb-1 font-heading text-xl font-semibold text-primary">Availability</h2>
    <p className="mb-4 max-w-3xl text-sm text-muted-foreground">
      Coach working hours and date exceptions, managed on a coach’s behalf. Coaches manage the same schedule under My availability.
      Availability is not published and does not make lessons bookable by itself.
    </p>
    {selected ? <>
      <AdminToolbar primary={<AvailabilityCoachSelect coaches={coaches} selectedId={selected.coach.user_id} />}
        metadata={selected.coach.ineligibility && <StatusBadge tone="warning">
          {selected.coach.ineligibility === "suspended" ? "Account suspended" : "No Coach role"}: availability can only be removed
        </StatusBadge>} />
      <AvailabilityManager key={selected.coach.user_id} view={selected} readOnly={selected.coach.ineligibility !== null}
        action={changeCoachAvailabilityAction.bind(null, selected.coach.user_id)} />
    </> : <p className="rounded-card border border-border bg-surface px-4 py-5 text-sm text-muted-foreground">
      No coaches yet. Create a coach profile under Coaches first.
    </p>}
  </>;
}
