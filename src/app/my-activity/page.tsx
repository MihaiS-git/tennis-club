import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { ProfileDepartureLink } from "@/components/profile-departure-navigation";
import { profileContext } from "@/lib/profile/profile";

export const metadata: Metadata = { title: "My activity | Tennis Club" };

export default function MyActivityPage() {
  return <Suspense fallback={<main className="flex-1 px-6 py-8 md:px-8"><p role="status" className="mx-auto max-w-4xl text-sm text-muted-foreground">Loading my activity…</p></main>}>
    <MyActivityContent />
  </Suspense>;
}

export async function MyActivityContent() {
  const { account } = await profileContext();
  if (account.state === "unauthenticated") redirect("/login");
  if (account.state !== "active") return <main className="flex-1 px-6 py-12"><p className="mx-auto max-w-3xl text-muted-foreground">Your account cannot access activity right now.</p></main>;

  return <main className="flex-1 px-6 py-8 md:px-8"><div className="mx-auto max-w-4xl">
    <h1 className="font-heading text-3xl font-semibold text-primary">My activity</h1>
    <p className="mt-2 text-sm text-muted-foreground">Your upcoming activity and club history.</p>
    <section className="mt-6 rounded-card border border-border bg-surface p-5">
      <h2 className="font-heading text-xl font-semibold text-primary">Bookings & reservations</h2>
      <p className="mt-2 text-sm text-muted-foreground">Manage upcoming court activity and review previous reservations.</p>
      <ProfileDepartureLink href="/my-activity/bookings" className="mt-4 inline-flex min-h-10 items-center rounded-control bg-primary px-4 text-sm font-semibold text-primary-foreground">View bookings & reservations</ProfileDepartureLink>
    </section>
  </div></main>;
}
