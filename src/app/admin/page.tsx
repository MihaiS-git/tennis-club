import Link from "next/link";

import { requireActiveAdmin } from "@/lib/admin/authorization";

export const instant = false;

const sections = [
  { title: "Locations", description: "Manage physical club locations, address, timezone and currency.", href: "/admin/locations" },
  { title: "Courts", description: "Manage courts, surfaces, lighting and seasonal coverage.", href: "/admin/courts" },
  { title: "Pricing", description: "Manage hourly pricing for courts, states, days and dates.", href: "/admin/pricing" },
  { title: "Payments", description: "Choose the active provider for new online payments.", href: "/admin/payments" },
  { title: "Users", description: "Manage users, status and roles.", href: "/admin/users" },
];

export default async function AdminPage() {
  await requireActiveAdmin();

  return (
    <>
      <header className="mb-8 md:mb-10">
        <h1 className="font-heading text-4xl font-semibold tracking-tight text-foreground md:text-5xl">
          Club administration
        </h1>
        <p className="mt-3 max-w-2xl text-base text-muted-foreground">
          Manage club locations, courts and accounts.
        </p>
      </header>
      <div className="grid gap-4 sm:grid-cols-2">
        {sections.map(({ title, description, href }) => (
          <Link key={title} href={href} className="block rounded-card border border-border bg-surface p-6 transition-colors hover:border-primary hover:bg-surface-muted focus-visible:border-primary focus-visible:bg-surface-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus">
            <h2 className="font-heading text-xl font-semibold text-primary">{title}</h2>
            <p className="mt-3 text-sm text-muted-foreground">{description}</p>
          </Link>
        ))}
      </div>
    </>
  );
}
