import type { ComponentProps } from "react";

export function Input({ className, ...props }: ComponentProps<"input">) {
  return (
    <input
      {...props}
      className={`w-full rounded-control border border-border bg-surface px-3 py-2.5 text-sm text-foreground outline-none transition focus:border-primary focus:ring-2 focus:ring-focus/20${className ? ` ${className}` : ""}`}
    />
  );
}
