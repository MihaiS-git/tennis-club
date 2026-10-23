import Link from "next/link";
import { SegmentedNavigation, segmentedNavigationItemClass } from "@/components/segmented-navigation";

export type ManagementView = "calendar" | "list";

// URL-backed tabs: each tab is an ordinary link, so Back/Forward restores the view.
export function ManagementTabs({ view, base = "/admin/bookings" }: { view: ManagementView; base?: "/admin/bookings" | "/coach/bookings" }) {
  const tabs = [["calendar", "Calendar", `${base}?view=calendar`], ["list", "List", `${base}?view=list`]] as const;
  return <SegmentedNavigation columns={2} aria-label="Bookings and reservations views" className="mb-5">
    {tabs.map(([value, label, href]) => {
      const active = value === view;
      return <Link key={value} href={href} aria-current={active ? "page" : undefined}
        className={segmentedNavigationItemClass(active)}>
        {label}
      </Link>;
    })}
  </SegmentedNavigation>;
}
