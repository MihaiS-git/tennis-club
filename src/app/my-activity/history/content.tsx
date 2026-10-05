import { redirect } from "next/navigation";
import { profileContext } from "@/lib/profile/profile";
import { listOwnCourtActivity } from "@/lib/bookings/activity-service";
import { parseActivityQuery, type ActivitySearchParams } from "@/lib/bookings/activity-query";
import { ActivityControls } from "../activity-controls";
import { ActivityPagination } from "../activity-pagination";
import { HistoryActivity } from "./history-activity";

export async function BookingHistoryContent({ searchParams }: { searchParams: Promise<ActivitySearchParams> }) {
  const { client, account } = await profileContext();
  if (account.state === "unauthenticated") redirect("/login");
  if (account.state !== "active") return <p className="text-muted-foreground">Your account cannot access activity right now.</p>;
  const staff = account.roles.some((role) => role === "admin" || role === "coach");
  const query = parseActivityQuery(await searchParams, "history", staff);
  const history = await listOwnCourtActivity("history", query, client);

  return <>
    <ActivityControls staff={staff} scope="history" query={query} options={history} />
    <section aria-label="Booking history" className="rounded-card border border-border bg-surface p-5">
      <HistoryActivity rows={history.rows} page={query.page} staff={staff} query={query} />
    </section>
    <ActivityPagination scope="history" query={query} hasNext={history.hasNext} empty={!history.rows.length} />
  </>;
}
