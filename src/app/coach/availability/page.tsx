import { AdminPageHeader } from "@/components/admin-page-controls";
import { AvailabilityManager } from "@/components/coach-availability/availability-manager";
import { loadOwnCoachAvailability } from "@/lib/coaching/availability";
import { changeOwnCoachAvailabilityAction } from "./actions";

export const instant = false;

export default async function CoachAvailabilityPage() {
  const view = await loadOwnCoachAvailability();
  return <>
    <AdminPageHeader title="My availability" description="Your regular working hours and date exceptions. Availability is not published and does not make lessons bookable by itself." />
    {view ? <AvailabilityManager view={view} action={changeOwnCoachAvailabilityAction} />
      : <p className="rounded-card border border-border bg-surface px-4 py-5 text-sm text-muted-foreground">
        Your coaching profile has not been set up yet. Ask an Admin to create it and assign your locations.
      </p>}
  </>;
}
