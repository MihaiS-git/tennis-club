import Link from "next/link";

const sections = [
  { label: "Overview", href: "/admin" },
  { label: "Locations", href: "/admin/locations" },
  { label: "Courts", href: "/admin/courts" },
  { label: "Users", href: "/admin/users" },
] as const;

export function AdminNavigation({ current }: { current: typeof sections[number]["href"] }) {
  return (
    <nav aria-label="Admin navigation" className="mb-8 flex flex-wrap gap-2 border-b border-border pb-4">
      {sections.map(({ label, href }) => (
        <Link
          key={href}
          href={href}
          aria-current={current === href ? "page" : undefined}
          className={`inline-flex min-h-10 items-center rounded-control px-3 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary ${current === href
            ? "bg-primary text-primary-foreground"
            : "text-primary hover:bg-surface-muted"}`}
        >
          {label}
        </Link>
      ))}
    </nav>
  );
}
