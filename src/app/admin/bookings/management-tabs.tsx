import Link from "next/link";

export type ManagementView = "calendar" | "list";

// URL-backed tabs: each tab is an ordinary link, so Back/Forward restores the view.
export function ManagementTabs({ view, base = "/admin/bookings" }: { view: ManagementView; base?: "/admin/bookings" | "/coach/bookings" }) {
  const tabs = [["calendar", "Calendar", `${base}?view=calendar`], ["list", "List", base]] as const;
  return <nav aria-label="Bookings and reservations views" className="mb-5 flex gap-1 border-b border-border">
    {tabs.map(([value, label, href]) => {
      const active = value === view;
      return <Link key={value} href={href} aria-current={active ? "page" : undefined}
        className={`-mb-px inline-flex min-h-11 items-center border-b-2 px-4 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus ${active ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-primary"}`}>
        {label}
      </Link>;
    })}
  </nav>;
}
