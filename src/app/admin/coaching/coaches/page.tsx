import { AdminToolbar } from "@/components/admin-page-controls";
import { loadAdminCoaching } from "@/lib/coaching/admin";
import { CoachDialog } from "./coach-dialog";
import { CoachesTable } from "./coaches-table";

export const instant = false;

export default async function AdminCoachesPage() {
  const { coaches, coachAccounts, locations, programs } = await loadAdminCoaching();
  return <>
    <h2 className="mb-1 font-heading text-xl font-semibold text-primary">Coaches</h2>
    <p className="mb-4 max-w-3xl text-sm text-muted-foreground">
      Public coaching profiles for accounts with the Coach role. Only public coaches with an active account and the Coach role appear on the Coaching page; account details are never shown there.
    </p>
    <AdminToolbar primary={<p className="pb-2 text-sm text-muted-foreground">{coaches.length} {coaches.length === 1 ? "coach" : "coaches"}
      {coachAccounts.length > 0 && <> · {coachAccounts.length} without a profile</>}</p>}
      action={coachAccounts.length ? <CoachDialog accounts={coachAccounts} locations={locations} programs={programs} />
        : <p className="pb-2 text-sm text-muted-foreground">Every coach account has a profile.</p>} />
    <CoachesTable coaches={coaches} locations={locations} programs={programs} />
  </>;
}
