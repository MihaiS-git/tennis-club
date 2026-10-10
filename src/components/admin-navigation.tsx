import { RouteSubmenu } from "./route-submenu";

const sections = [
  { label: "Locations", href: "/admin/locations", matchDescendants: true },
  { label: "Payments", href: "/admin/payments", matchDescendants: true },
  { label: "Users", href: "/admin/users", matchDescendants: true },
] as const;

export function AdminNavigation() {
  return <RouteSubmenu sections={sections} label="Admin navigation" />;
}
