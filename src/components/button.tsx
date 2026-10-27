import type { ComponentProps } from "react";

type ButtonProps = ComponentProps<"button"> & {
  variant?: "primary" | "secondary" | "destructive" | "subtle" | "text";
  size?: "default" | "small" | "icon" | "iconLarge";
  fullWidth?: boolean;
};

export function Button({
  variant = "primary",
  size = "default",
  fullWidth = variant === "primary",
  className = "",
  ...props
}: ButtonProps) {
  const box = "inline-flex items-center justify-center rounded-control border font-semibold";
  const variants = {
    primary: `${box} border-primary bg-primary text-primary-foreground enabled:not-aria-disabled:hover:bg-primary-hover`,
    secondary: `${box} border-border-strong bg-surface text-primary enabled:not-aria-disabled:hover:bg-surface-muted`,
    destructive: `${box} border-danger bg-surface text-danger enabled:not-aria-disabled:hover:bg-danger-background`,
    subtle: `${box} border-transparent bg-transparent text-muted-foreground enabled:not-aria-disabled:hover:bg-surface-muted enabled:not-aria-disabled:hover:text-primary`,
    // Inline text actions keep the surrounding layout and typography; callers add weight or underline as their context requires.
    text: "rounded-control text-primary enabled:not-aria-disabled:hover:text-accent",
  };
  const sizes = {
    default: "min-h-10 px-4 py-2.5 text-sm",
    small: "min-h-9 px-3 py-1.5 text-sm",
    icon: "size-8 shrink-0 p-1 text-sm",
    iconLarge: "size-10 shrink-0 p-0 text-sm",
  };
  return <button {...props} className={`transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:cursor-not-allowed disabled:opacity-60 aria-disabled:cursor-not-allowed aria-disabled:opacity-60 aria-busy:cursor-wait ${variants[variant]} ${variant === "text" ? "" : sizes[size]} ${fullWidth ? "w-full" : ""} ${className}`} />;
}
