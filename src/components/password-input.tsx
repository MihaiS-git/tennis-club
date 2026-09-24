"use client";

import { Eye, EyeOff } from "lucide-react";
import { useRef, useState, type ComponentProps } from "react";

import { Input } from "@/components/input";

type PasswordInputProps = Omit<ComponentProps<"input">, "type" | "className">;

export function PasswordInput(props: PasswordInputProps) {
  const [isVisible, setIsVisible] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  function toggleVisibility() {
    setIsVisible((visible) => !visible);
    inputRef.current?.focus({ preventScroll: true });
  }

  return (
    <div className="relative">
      <Input
        {...props}
        ref={inputRef}
        className="pr-11"
        type={isVisible ? "text" : "password"}
      />
      <button
        aria-label={isVisible ? "Hide password" : "Show password"}
        aria-pressed={isVisible}
        className="absolute inset-y-0 right-0 flex w-11 items-center justify-center rounded-r-control text-muted-foreground transition hover:text-primary focus-visible:text-primary"
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
