import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { profileContext } from "@/lib/profile/profile";
import { PersonalActivity } from "./personal-activity";

export const metadata: Metadata = { title: "Bookings & reservations | Tennis Club" };

export default function MyBookingsPage() {
  return <Suspense fallback={<main className="flex-1 px-6 py-8 md:px-8"><p role="status" className="mx-auto max-w-4xl text-sm text-muted-foreground">Loading bookings & reservations…</p></main>}>
    <MyBookingsContent />
  </Suspense>;
}

export async function MyBookingsContent() {
  const { account } = await profileContext();
  if (account.state === "unauthenticated") redirect("/login");
  if (account.state !== "active") return <main className="flex-1 px-6 py-12"><p className="mx-auto max-w-3xl text-muted-foreground">Your account cannot access activity right now.</p></main>;

  return <main className="flex-1 px-6 py-8 md:px-8"><div className="mx-auto max-w-4xl">
    <h1 className="font-heading text-3xl font-semibold text-primary">Bookings & reservations</h1>
    <p className="mt-2 text-sm text-muted-foreground">Your court activity at the club.</p>
    <section aria-label="Your bookings and reservations" className="mt-6 rounded-card border border-border bg-surface p-5">
      <PersonalActivity staff={account.roles.some((role) => role === "admin" || role === "coach")} userId={account.userId} />
    </section>
    <section className="mt-6 rounded-card border border-border bg-surface p-5">
      <h2 className="font-heading text-xl font-semibold text-primary">Past bookings & reservations</h2>
      <p className="mt-2 text-sm text-muted-foreground">Review previous and cancelled court activity.</p>
      <Link href="/my-activity/bookings/history" className="mt-4 inline-flex min-h-10 items-center rounded-control border border-border-strong px-4 text-sm font-semibold text-primary">View history</Link>
    </section>
  </div></main>;
}
