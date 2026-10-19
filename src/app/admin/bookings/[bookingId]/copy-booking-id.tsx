"use client";

import { Copy } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/button";

export function CopyBookingId({ id }: { id: string }) {
  async function copy() {
    try {
      await navigator.clipboard.writeText(id);
      toast.success("Booking ID copied.", { id: "booking-id-copied" });
    } catch {
      toast.error("Unable to copy the booking ID. Select and copy it manually.", { id: "booking-id-copied" });
    }
  }
  return <Button type="button" variant="subtle" size="small" fullWidth={false} onClick={() => void copy()} className="gap-1.5">
    <Copy size={14} aria-hidden />Copy ID
  </Button>;
}
