import { Spinner } from "./spinner";

// inline: one line beside or within content. section: stands in for a panel's
// content and reserves its height, so the loaded content does not jump in. page: a
// route's loading.tsx or page-level fallback, filling the content area below the
// stable navbar/sidebar. `inverse` is for the dark brand sections.
export function LoadingStatus({ label, variant = "inline", tone = "default", className = "", pending = true, compact = false }: {
  label: string; variant?: "inline" | "section" | "page"; tone?: "default" | "inverse"; className?: string; pending?: boolean; compact?: boolean;
}) {
  const layout = variant === "section"
    ? "min-h-20 justify-center rounded-control border border-border bg-surface-muted p-4"
    : variant === "page"
      ? "min-h-60 w-full justify-center rounded-card border border-border bg-surface p-6"
      : "";
  return <p role="status" className={`flex items-center ${compact ? "min-h-4 basis-full gap-1.5 text-xs" : "gap-2 text-sm"} font-sans ${tone === "inverse" ? "text-ivory" : "text-muted-foreground"} ${layout} ${className}`}>
    {pending && <><Spinner size={compact ? "small" : "medium"} />{label}</>}
  </p>;
}
