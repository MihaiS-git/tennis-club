import type { ReactNode } from "react";

export function AuthShell({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <main className="flex flex-1 items-center justify-center bg-background px-6 py-16 text-foreground">
      <section className="w-full max-w-md rounded-card border border-border bg-surface-elevated p-8 shadow-card">
        <p className="text-sm font-medium text-accent">Tennis Club</p>
        <h1 className="mt-2 font-heading text-3xl font-semibold tracking-tight text-foreground">{title}</h1>
        {description ? <p className="mt-2 text-sm text-muted-foreground">{description}</p> : null}
        <div className="mt-6">{children}</div>
      </section>
    </main>
  );
}

export function FormMessage({
  children,
  success = false,
}: {
  children?: string;
  success?: boolean;
}) {
  if (!children) return null;

  return (
    <p
      role={success ? "status" : "alert"}
      className={`mb-4 rounded-lg px-3 py-2 text-sm ${
        success ? "bg-success-background text-success" : "bg-danger-background text-danger"
      }`}
    >
      {children}
    </p>
  );
}

export const fieldClassName =
  "w-full rounded-control border border-border bg-surface px-3 py-2.5 text-sm text-foreground outline-none transition focus:border-primary focus:ring-2 focus:ring-focus/20";

export const buttonClassName =
  "w-full rounded-control bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground transition hover:bg-primary-hover disabled:cursor-wait disabled:opacity-60";
