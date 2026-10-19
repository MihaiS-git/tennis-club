"use client";

import { Button } from "@/components/button";

export default function AdminCoachingError({ reset }: { reset: () => void }) {
  return <div role="alert" className="space-y-3 rounded-card border border-border bg-surface px-4 py-5 text-sm">
    <p>Unable to load coaching. Please try again.</p>
    <Button variant="secondary" size="small" fullWidth={false} onClick={reset}>Retry</Button>
  </div>;
}
