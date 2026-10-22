import { redirect } from "next/navigation";
import { profileContext } from "@/lib/profile/profile";
import { findOwnBookingActivityTarget, listOwnCourtActivity } from "@/lib/bookings/activity-service";
import { activityBookingHref, parseActivityQuery, type ActivitySearchParams } from "@/lib/bookings/activity-query";
import { ActivityControls } from "../activity-controls";
import { ActivityPagination } from "../activity-pagination";
import { HistoryActivity } from "./history-activity";

export async function BookingHistoryContent({ searchParams }: { searchParams: Promise<ActivitySearchParams> }) {
  const { client, account } = await profileContext();
  if (account.state === "unauthenticated") redirect("/login");
  if (account.state !== "active") return <p className="text-muted-foreground">Your account cannot access activity right now.</p>;
  const staff = account.roles.some((role) => role === "admin" || role === "coach");
  const rawParams = await searchParams;
  const query = parseActivityQuery(rawParams, "history", staff);
  const target = await findOwnBookingActivityTarget(rawParams.booking, account.userId);
  if (target?.scope === "upcoming") redirect(activityBookingHref("upcoming", parseActivityQuery(rawParams, "upcoming", staff), target.booking.id));
  const history = await listOwnCourtActivity("history", query, client);

  return <>
    <ActivityControls staff={staff} scope="history" query={query} options={history} />
    <section aria-label="Booking history">
      <HistoryActivity key={target?.booking.id ?? "list"} rows={history.rows} page={query.page} staff={staff} query={query}
        deepLinkedBooking={target?.scope === "history" ? target.booking : null} />
    </section>
    <ActivityPagination scope="history" query={query} hasNext={history.hasNext} empty={!history.rows.length} />
  </>;
}
