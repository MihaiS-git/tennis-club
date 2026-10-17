import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

// One card per Profile page: a titled header, then the page's content.
export function ProfileSection({ id, title, description, icon: Icon, children }: {
  id: string; title: string; description: string; icon: LucideIcon; children: ReactNode;
}) {
  return <section aria-labelledby={`${id}-heading`}
    className="min-w-0 rounded-card border border-border bg-surface-elevated shadow-card">
    <header className="flex items-start gap-4 border-b border-border px-5 py-5 md:px-6 lg:px-8">
      <span aria-hidden="true" className="flex size-10 shrink-0 items-center justify-center rounded-control bg-success-background text-primary"><Icon className="size-5" /></span>
      <div className="min-w-0">
        <h2 id={`${id}-heading`} className="font-heading text-xl font-semibold text-primary">{title}</h2>
        <p className="mt-1 text-sm leading-6 text-muted-foreground">{description}</p>
      </div>
    </header>
    <div className="min-w-0 p-5 md:p-6 lg:p-8 [&_input]:text-base [&_select]:text-base [&_textarea]:text-base sm:[&_input]:text-sm sm:[&_select]:text-sm sm:[&_textarea]:text-sm">{children}</div>
  </section>;
}
