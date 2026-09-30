"use client";

import { useRouter } from "next/navigation";
import { AdminLocationSelect } from "@/components/admin-page-controls";

export function PricingLocationSelect({ locations, selectedId }: {
  locations: { id: string; name: string; is_active: boolean }[]; selectedId?: string;
}) {
  const router = useRouter();
  return <AdminLocationSelect locations={locations} selectedId={selectedId ?? ""}
    onChange={(value) => router.push(`/admin/pricing?location=${encodeURIComponent(value)}`)} />;
}
