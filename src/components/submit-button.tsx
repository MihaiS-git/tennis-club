"use client";

import { useFormStatus } from "react-dom";

import { Button } from "@/components/button";

export function SubmitButton({
  children,
  pendingLabel,
  variant = "primary",
}: {
  children: string;
  pendingLabel: string;
  variant?: "primary" | "secondary";
}) {
  const { pending } = useFormStatus();

  return (
    <Button
      variant={variant}
      type="submit"
      disabled={pending}
      aria-disabled={pending}
    >
      {pending ? pendingLabel : children}
    </Button>
  );
}
