"use client";

import { useFormStatus } from "react-dom";

export function SignOutButton({ className }: { className: string }) {
  const { pending } = useFormStatus();
  return <button type="submit" disabled={pending} aria-busy={pending}
    className={`${className} enabled:hover:text-accent disabled:cursor-not-allowed disabled:opacity-60`}>
    {pending ? "Signing out…" : "Sign out"}
  </button>;
}
