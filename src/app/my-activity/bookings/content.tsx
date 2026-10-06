import { redirect } from "next/navigation";
import { profileContext } from "@/lib/profile/profile";
import { logger } from "@/lib/logger";
import { listOwnUpcomingActivity } from "@/lib/bookings/activity-service";
import type { ActivitySearchParams } from "@/lib/bookings/activity-query";
import { customerBookingNoticeBypass } from "@/lib/bookings/self-cancellation";
import { PersonalActivity } from "./personal-activity";

export async function MyBookingsContent({ searchParams = Promise.resolve({}) }: {
  searchParams?: Promise<ActivitySearchParams>;
} = {}) {
  const { account, client } = await profileContext();
  if (account.state === "unauthenticated") redirect("/login");
  if (account.state !== "active") return <p className="text-muted-foreground">Your account cannot access activity right now.</p>;
  const staff = customerBookingNoticeBypass(account.roles);
  const rawParams = await searchParams;
  const params = staff ? rawParams : { ...rawParams, type: "booking" };
  let initialActivity = null;
  let initialError = "";
  try {
    initialActivity = await listOwnUpcomingActivity(params, client);
  } catch {
    logger.error({ event: "activity.initial_read_failed" }, "Failed to load personal court activity");
    initialError = "Unable to load your court activity. Try again.";
  }

  return <section aria-label="Your bookings and reservations" className="rounded-card border border-border bg-surface p-5">
    <PersonalActivity staff={staff} userId={account.userId}
      initialActivity={initialActivity} initialError={initialError} listQuery={params} />
  </section>;
}
