import { RouteSubmenu } from "@/components/route-submenu";

const sections = [
  { label: "Bookings", href: "/my-activity/bookings" },
  { label: "History", href: "/my-activity/history" },
];

export default function MyActivityLayout({ children }: { children: React.ReactNode }) {
  return <main className="flex-1 bg-background"><div className="mx-auto max-w-6xl px-6 py-8 md:px-8">
    <h1 className="font-heading text-3xl font-semibold text-primary">My activity</h1>
    <p className="mt-2 mb-6 text-sm text-muted-foreground">Your upcoming activity and club history.</p>
    <RouteSubmenu sections={sections} label="My activity navigation" />
    {children}
  </div></main>;
}
