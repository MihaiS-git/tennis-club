import type { ComponentProps } from "react";

type ButtonProps = ComponentProps<"button"> & {
  variant?: "primary" | "secondary" | "destructive" | "subtle";
  size?: "default" | "small" | "icon";
  fullWidth?: boolean;
};

export function Button({
  variant = "primary",
  size = "default",
  fullWidth = variant === "primary",
  className = "",
  ...props
}: ButtonProps) {
  const variants = {
    primary: "border-primary bg-primary text-primary-foreground hover:bg-primary-hover",
    secondary: "border-border-strong bg-surface text-primary hover:bg-surface-muted",
    destructive: "border-danger bg-danger-background text-danger hover:bg-surface-muted",
    subtle: "border-transparent bg-transparent text-muted-foreground hover:bg-surface-muted hover:text-primary",
  };
  const sizes = {
    default: "min-h-10 px-4 py-2.5 text-sm",
    small: "min-h-9 px-3 py-1.5 text-sm",
    icon: "size-8 shrink-0 p-1 text-sm",
  };
  return <button {...props} className={`inline-flex items-center justify-center rounded-control border font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:cursor-not-allowed disabled:opacity-60 aria-busy:cursor-wait ${variants[variant]} ${sizes[size]} ${fullWidth ? "w-full" : ""} ${className}`} />;
}

export function DialogCloseButton(props: Omit<ButtonProps, "variant" | "size" | "fullWidth" | "children" | "type">) {
  return <Button {...props} type="button" variant="subtle" size="small">Close</Button>;
}
