"use client";

import { Button } from "@/components/button";
import { useEffect } from "react";
import { toast } from "sonner";

export default function UserManagementError({ reset }: { reset: () => void }) {
  useEffect(() => {
    toast.error("Unable to load user details. Please try again.", { id: "user-details-error", action: { label: "Retry", onClick: reset } });
    return () => { toast.dismiss("user-details-error"); };
  }, [reset]);
  return <div className="space-y-3">
    <Button variant="secondary" size="small" onClick={reset}>Retry</Button>
  </div>;
}
