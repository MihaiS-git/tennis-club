import { AdminPageHeader } from "@/components/admin-page-controls";
import { loadOwnCoachPricing } from "@/lib/coaching/coach-pricing";
import { CoachPricingTable } from "./pricing-table";

export const instant = false;

const emptyClass = "rounded-card border border-border bg-surface px-4 py-5 text-sm text-muted-foreground";

export default async function CoachPricingPage() {
  const view = await loadOwnCoachPricing();
  return <>
    <AdminPageHeader title="My prices" description="Your price for each assigned program and duration, in the currencies of your active locations. Your price replaces the club price for your lessons; remove it to use the club price again. Changes apply to new bookings only." />
    {!view ? <p className={emptyClass}>Your coaching profile has not been set up yet. Ask an Admin to create it and assign your programs and locations.</p>
      : !view.rows.length ? <p className={emptyClass}>
        {view.currencies.length ? "No programs are assigned to you yet. Ask an Admin to assign the programs you offer."
          : "You have no active locations yet. Prices are set in the currencies your locations use."}
      </p>
      : <CoachPricingTable view={view} />}
  </>;
}
