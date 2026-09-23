"use client";

import { Eye, EyeOff } from "lucide-react";
import { useRef, useState, type ComponentProps } from "react";

type PasswordInputProps = Omit<ComponentProps<"input">, "type"> & {
  containerClassName?: string;
};

export function PasswordInput({
  className,
  containerClassName,
  ...props
}: PasswordInputProps) {
  const [isVisible, setIsVisible] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  function toggleVisibility() {
    setIsVisible((visible) => !visible);
    inputRef.current?.focus({ preventScroll: true });
  }

  return (
    <div className={`relative ${containerClassName ?? ""}`}>
      <input
        {...props}
        ref={inputRef}
        className={`w-full rounded-control border border-border bg-surface px-3 py-2.5 pr-11 text-sm text-foreground outline-none transition focus:border-primary focus:ring-2 focus:ring-focus/20 ${className ?? ""}`}
        type={isVisible ? "text" : "password"}
      />
      <button
        aria-label={isVisible ? "Hide password" : "Show password"}
        aria-pressed={isVisible}
        className="absolute inset-y-0 right-0 flex w-11 items-center justify-center rounded-r-control text-muted-foreground transition hover:text-primary focus-visible:outline-none focus-visible:text-primary"
        onClick={toggleVisibility}
        onPointerDown={(event) => event.preventDefault()}
        type="button"
      >
        {isVisible ? (
          <EyeOff aria-hidden="true" size={18} />
        ) : (
          <Eye aria-hidden="true" size={18} />
        )}
      </button>
    </div>
  );
}
