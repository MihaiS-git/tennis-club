import type { ReactNode } from "react";

export function ProfileSection({ id, title, description, children }: {
  id: string; title: string; description: string; children: ReactNode;
}) {
  return <section aria-labelledby={`${id}-heading`}
    className="grid min-w-0 gap-6 rounded-card border border-border bg-surface-elevated p-5 md:grid-cols-[11rem_minmax(0,1fr)] md:p-6 lg:grid-cols-[15rem_minmax(0,1fr)] lg:gap-10 lg:p-8">
    <div>
      <h2 id={`${id}-heading`} className="font-heading text-xl font-semibold text-primary">{title}</h2>
      <p className="mt-2 text-sm leading-6 text-muted-foreground">{description}</p>
    </div>
    <div className="min-w-0 w-full max-w-2xl [&_input]:text-base [&_select]:text-base [&_textarea]:text-base sm:[&_input]:text-sm sm:[&_select]:text-sm sm:[&_textarea]:text-sm">{children}</div>
  </section>;
}
