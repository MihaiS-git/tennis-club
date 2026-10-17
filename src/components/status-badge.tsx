import type { ReactNode } from "react";

// Same tones as the Admin transaction badges.
export const statusTones = {
  success: "bg-success-background text-success", warning: "bg-warning-background text-foreground",
  danger: "bg-danger-background text-danger", neutral: "bg-surface-muted text-muted-foreground",
} as const;
export type StatusTone = keyof typeof statusTones;

export function StatusBadge({ tone, children }: { tone: StatusTone; children: ReactNode }) {
  return <span className={`inline-flex whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-semibold ${statusTones[tone]}`}>{children}</span>;
}
