"use client";

import { useFormStatus } from "react-dom";

import { Button } from "@/components/button";

export function SubmitButton({
  children,
  pendingLabel,
  variant = "primary",
  disabled = false,
}: {
  children: string;
  pendingLabel: string;
  variant?: "primary" | "secondary";
  disabled?: boolean;
}) {
  const { pending } = useFormStatus();

  return (
    <Button
      variant={variant}
      type="submit"
      disabled={pending || disabled}
      aria-disabled={pending || disabled}
    >
      {pending ? pendingLabel : children}
    </Button>
  );
}
