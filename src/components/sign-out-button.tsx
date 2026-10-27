"use client";

import { useFormStatus } from "react-dom";
import { Button } from "@/components/button";

export function SignOutButton({ className }: { className: string }) {
  const { pending } = useFormStatus();
  return <Button type="submit" variant="text" disabled={pending} aria-busy={pending} className={className}>
    {pending ? "Signing out…" : "Sign out"}
  </Button>;
}
