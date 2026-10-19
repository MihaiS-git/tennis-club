import { AdminToolbar } from "@/components/admin-page-controls";
import { loadAdminCoaching } from "@/lib/coaching/admin";
import { ProgramDialog } from "./program-dialog";
import { ProgramsTable } from "./programs-table";

export const instant = false;

export default async function AdminCoachingProgramsPage() {
  const { programs } = await loadAdminCoaching();
  return <>
    <h2 className="mb-1 font-heading text-xl font-semibold text-primary">Programs</h2>
    <p className="mb-4 max-w-3xl text-sm text-muted-foreground">
      Coaching offerings shown on the public Coaching page while active. Prices are set per duration and location under Prices.
    </p>
    <AdminToolbar primary={<p className="pb-2 text-sm text-muted-foreground">{programs.length} {programs.length === 1 ? "program" : "programs"}</p>}
      action={<ProgramDialog />} />
    <ProgramsTable programs={programs} />
  </>;
}
