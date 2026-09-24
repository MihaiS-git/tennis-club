import type { ComponentProps } from "react";

type ButtonProps = Omit<ComponentProps<"button">, "className"> & {
  variant?: "primary" | "secondary";
};

export function Button({
  variant = "primary",
  ...props
}: ButtonProps) {
  return (
    <button
      {...props}
      className={variant === "primary"
        ? "w-full rounded-control bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground transition hover:bg-primary-hover disabled:cursor-wait disabled:opacity-60"
        : "rounded-lg border border-border-strong px-4 py-2 text-sm font-medium text-foreground hover:bg-surface-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:cursor-wait disabled:text-muted-foreground"}
    />
  );
}
