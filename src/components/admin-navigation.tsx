import { RouteSubmenu } from "./route-submenu";

const sections = [
  { label: "Overview", href: "/admin" },
  { label: "Locations", href: "/admin/locations" },
  { label: "Courts", href: "/admin/courts" },
  { label: "Pricing", href: "/admin/pricing" },
  { label: "Users", href: "/admin/users" },
] as const;

export function AdminNavigation() {
  return <RouteSubmenu sections={sections} label="Admin navigation" />;
}
