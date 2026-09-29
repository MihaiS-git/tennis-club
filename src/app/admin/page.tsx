import Link from "next/link";

import { AdminNavigation } from "@/components/admin-navigation";
import { requireActiveAdmin } from "@/lib/admin/authorization";

const sections = [
  { title: "Locations", description: "Manage physical club locations, address, timezone and currency.", href: "/admin/locations" },
  { title: "Courts", description: "Manage courts, surfaces, lighting and seasonal coverage.", href: "/admin/courts" },
  { title: "Opening hours", description: "Configure weekly opening schedules by location.", href: "/admin/locations" },
  { title: "Pricing", description: "Pricing configuration not yet implemented.", href: null },
  { title: "Users", description: "Manage users, status and roles.", href: "/admin/users" },
];

export default async function AdminPage() {
  await requireActiveAdmin();

  return (
    <main className="flex-1 bg-background">
      <div className="mx-auto max-w-7xl px-6 py-10 md:px-8 md:py-12 lg:py-16">
        <AdminNavigation current="/admin" />
        <header className="mb-8 md:mb-10">
          <h1 className="font-heading text-4xl font-semibold tracking-tight text-foreground md:text-5xl">
            Club administration
          </h1>
          <p className="mt-3 max-w-2xl text-base text-muted-foreground">
            Manage club locations, courts and accounts.
          </p>
        </header>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {sections.map(({ title, description, href }) => (
            <article key={title} className="rounded-card border border-border bg-surface p-6">
              <h2 className="font-heading text-xl font-semibold text-foreground">
                {href ? (
                  <Link href={href} className="rounded-control text-primary hover:text-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary">
                    {title}
                  </Link>
                ) : title}
              </h2>
              <p className="mt-3 text-sm text-muted-foreground">{description}</p>
              {!href && (
                <span className="mt-4 inline-flex rounded-control bg-surface-muted px-2.5 py-1 text-xs font-semibold text-muted-foreground">
                  Coming next · Unavailable
                </span>
              )}
            </article>
          ))}
        </div>
      </div>
    </main>
  );
}
