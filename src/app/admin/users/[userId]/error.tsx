"use client";

import { Button } from "@/components/button";

export default function UserManagementError({ reset }: { reset: () => void }) {
  return <div className="space-y-3">
    <p role="alert" className="text-sm text-danger">Unable to load user details. Please try again.</p>
    <Button variant="secondary" size="small" onClick={reset}>Retry</Button>
  </div>;
}
